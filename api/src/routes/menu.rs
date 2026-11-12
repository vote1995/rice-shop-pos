//! `/menu...` - the menu as the staff POS sees it (ROADMAP M1-1b).
//!
//! Endpoints (staff auth: the shop ALWAYS comes from the session, never from
//! the request, so one shop's staff can never touch another shop's rows):
//! - `GET  /menu`                       saleable menu of the session shop
//! - `POST /menu/items/{id}/sold-out`   toggle a menu item's sold_out (3.5)
//! - `POST /menu/options/{id}/sold-out` toggle a curry pot's sold_out (3.5)
//!
//! `GET /menu` returns ACTIVE items only (inactive ones must not be sold) but
//! DOES include sold-out items and options - the counter dims them instead of
//! hiding them (FEATURES 3.5). The JSON shape is identical to the owner menu
//! endpoint: the row structs and column lists are shared with
//! `routes::owner::menu`, so both apps always see the same fields.
//!
//! It is revalidated, not cached: the response carries a strong ETag over the
//! exact body bytes, so an unchanged menu costs a `304` instead of the full
//! JSON (see [`staff_menu`]).

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::staff::StaffAuth;
use crate::extract::ApiJson;
use crate::routes::owner::menu::{
    load_menu_item, load_option, menu_stock_out_json, MenuItem, MenuOption, OptionGroup,
};
use crate::util::{body_etag, if_none_match_matches, int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

/// Column lists mirror `routes::owner::menu` one-to-one (the shared row
/// structs deserialize them); local consts keep that module's SQL untouched.
/// `NULL AS cost`: the per-plate cost is owner-only data (margins), never sent to staff.
const ITEM_COLUMNS: &str = "id, shop_id, name, category, menu_type, base_price, price_2, \
     price_3, grab_price, lineman_price, foodpanda_price, NULL AS cost, image_key, sold_out, status, \
     sort_order, created_at, updated_at";
const GROUP_COLUMNS: &str = "id, shop_id, menu_item_id, name, required, max_select, \
     tier_pricing, sort_order, created_at, updated_at";
const OPTION_COLUMNS: &str = "id, shop_id, option_group_id, name, price_add, sold_out, \
     sort_order, created_at, updated_at";

/// The menu is per-session and changes with every sold-out toggle / stock dip,
/// so the POS may keep a copy but has to revalidate it against the ETag every
/// time. `private` keeps it out of shared caches; `no-cache` forces the
/// revalidation round-trip (it means "must revalidate", not "do not store").
const MENU_CACHE_CONTROL: &str = "private, no-cache";
/// The request headers the menu body varies by: a shared cache (or a proxy
/// that ignored `private`) must never hand shop A's menu to shop B's session.
const MENU_VARY: [&str; 2] = ["Authorization", "X-Device-Token"];

/// The headers every menu response carries, 200 and 304 alike: the strong
/// [`etag`], the must-revalidate cache policy and the per-session `Vary`.
/// `Content-Type` is deliberately left out — it belongs to the 200 alone (a
/// 304 has no body). `Vary` is appended, so nothing a later layer adds (CORS
/// appends `Origin`) is clobbered.
fn revalidation_headers(etag: &str) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(etag)
            .map_err(|e| ApiError::Internal(format!("menu ETag is not header-safe: {e}")))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(MENU_CACHE_CONTROL),
    );
    for vary in MENU_VARY {
        headers.append(header::VARY, HeaderValue::from_static(vary));
    }
    Ok(headers)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SoldOutBody {
    pub sold_out: bool,
}

/// The menu of the session shop as the POS needs it: active items, all option
/// groups and options of the shop (sold-out rows included, dimmed client-side)
/// and the channel markup so the POS can price delivery lines (3.6).
///
/// The body is always built in full, then compared against the request's
/// `If-None-Match`: a 304 therefore still costs the same auth + queries (so
/// revalidation can never hand a menu to an unauthenticated caller) and the
/// ETag is a SHA-256 over the very bytes a 200 would have sent - anything that
/// feeds the JSON (items, options, sold-out flags, channel markup, the derived
/// stock-out flags from ingredient levels) is covered automatically.
#[worker::send]
pub async fn staff_menu(
    State(state): State<AppState>,
    staff: StaffAuth,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let shop_id = staff.shop_id;
    let env = &state.env;

    let Some(markup_json) = db::db(env)?
        .prepare("SELECT channel_markup_json FROM shops WHERE id = ?1")
        .bind(&[txt(&shop_id)])?
        .first::<String>(Some("channel_markup_json"))
        .await?
    else {
        return Err(ApiError::NotFound);
    };
    let channel_markup: Value = serde_json::from_str(&markup_json).map_err(|e| {
        ApiError::Internal(format!("shop {shop_id} has invalid channel_markup_json: {e}"))
    })?;

    let items = db::db(env)?
        .prepare(format!(
            "SELECT {ITEM_COLUMNS}
             FROM menu_items
             WHERE shop_id = ?1 AND status = 'active' AND deleted_at IS NULL
             ORDER BY sort_order, created_at, id"
        ))
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<MenuItem>()?;
    let option_groups = db::db(env)?
        .prepare(format!(
            "SELECT {GROUP_COLUMNS}
             FROM option_groups
             WHERE shop_id = ?1
             ORDER BY sort_order, created_at, id"
        ))
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<OptionGroup>()?;
    let options = db::db(env)?
        .prepare(format!(
            "SELECT {OPTION_COLUMNS}
             FROM options
             WHERE shop_id = ?1
             ORDER BY sort_order, created_at, id"
        ))
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<MenuOption>()?;

    // stock_out is derived per row (auto-block): the counter dims it next to
    // the manual sold_out flag. One read for the whole shop.
    let (items, options) =
        menu_stock_out_json(env, &shop_id, items, options).await?;

    let body = json!({
        "items": items,
        "option_groups": option_groups,
        "options": options,
        "channel_markup": channel_markup,
        // false: this shop has no Beam credentials, the POS hides the QR option
        "beam_qr": crate::routes::promptpay::qr_available(env, &shop_id).await,
    });
    // Serialize once and send those exact bytes, so the ETag can never lie
    // about the body it was computed from (the bytes are the `Json` body this
    // handler used to return: same `serde_json` formatting).
    let bytes = serde_json::to_vec(&body).map_err(|e| {
        ApiError::Internal(format!("menu of shop {shop_id} is not serializable: {e}"))
    })?;
    let etag = body_etag(&bytes);

    let mut out = revalidation_headers(&etag)?;

    let revalidates = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| if_none_match_matches(v, &etag));
    if revalidates {
        // No body, no content-type: the client keeps its own copy.
        return Ok((StatusCode::NOT_MODIFIED, out).into_response());
    }
    out.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok((StatusCode::OK, out, Body::from(bytes)).into_response())
}

/// Toggle a menu item's sold-out flag (the counter's big "sold out" button,
/// FEATURES 3.5). Scoped to the session shop: another shop's item id matches
/// 0 rows and therefore answers 404.
#[worker::send]
pub async fn item_sold_out(
    State(state): State<AppState>,
    staff: StaffAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SoldOutBody>,
) -> Result<Json<MenuItem>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;

    let updated = db::db(env)?
        .prepare(
            "UPDATE menu_items
             SET sold_out = ?1, updated_at = ?2
             WHERE id = ?3 AND shop_id = ?4",
        )
        .bind(&[
            int(i64::from(body.sold_out)),
            int(now_ms()),
            txt(&id),
            txt(&staff.shop_id),
        ])?
        .run()
        .await?;
    // 0 changes = no such item in this shop (or at all).
    if updated.meta()?.and_then(|m| m.changes).unwrap_or(0) == 0 {
        return Err(ApiError::NotFound);
    }
    let mut item = load_menu_item(env, &id).await?.ok_or_else(|| {
        ApiError::Internal(format!("menu item {id} vanished right after the update"))
    })?;
    item.cost = None; // owner-only, see ITEM_COLUMNS
    Ok(Json(item))
}

/// Toggle an option's sold-out flag (curry pot empty, FEATURES 3.5). Same
/// shop scoping as [`item_sold_out`].
#[worker::send]
pub async fn option_sold_out(
    State(state): State<AppState>,
    staff: StaffAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SoldOutBody>,
) -> Result<Json<MenuOption>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;

    let updated = db::db(env)?
        .prepare(
            "UPDATE options
             SET sold_out = ?1, updated_at = ?2
             WHERE id = ?3 AND shop_id = ?4",
        )
        .bind(&[
            int(i64::from(body.sold_out)),
            int(now_ms()),
            txt(&id),
            txt(&staff.shop_id),
        ])?
        .run()
        .await?;
    // 0 changes = no such option in this shop (or at all).
    if updated.meta()?.and_then(|m| m.changes).unwrap_or(0) == 0 {
        return Err(ApiError::NotFound);
    }
    let option = load_option(env, &id).await?.ok_or_else(|| {
        ApiError::Internal(format!("option {id} vanished right after the update"))
    })?;
    Ok(Json(option))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The revalidation contract of `GET /menu`: the same headers on a 200 and
    /// on the 304 it may be replaced by, and nothing that would let a shared
    /// cache serve one session's menu to another.
    #[test]
    fn menu_revalidation_headers_shape() {
        let etag = "\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\"";
        let h = revalidation_headers(etag).unwrap();
        assert_eq!(h.get(header::ETAG).unwrap(), etag);
        assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "private, no-cache");
        let vary: Vec<_> = h
            .get_all(header::VARY)
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(vary, ["Authorization", "X-Device-Token"]);
        // Content-Type is the 200's business: a 304 must stay body-less.
        assert!(!h.contains_key(header::CONTENT_TYPE));
    }

    /// A layer that adds its own `Vary` (CORS appends `Origin`) keeps it.
    #[test]
    fn menu_revalidation_headers_append_vary() {
        let mut h = revalidation_headers("\"abc\"").unwrap();
        h.append(header::VARY, HeaderValue::from_static("Origin"));
        assert_eq!(h.get_all(header::VARY).iter().count(), 3);
        assert_eq!(h.get(header::VARY).unwrap(), "Authorization");
    }

    /// The tag is the hash of the exact body, so an ETag is stable per body and
    /// changes with the menu JSON that produced it.
    #[test]
    fn menu_etag_tracks_the_body_bytes() {
        let body = br#"{"items":[],"options":[]}"#;
        let etag = body_etag(body);
        // The tag we hand out revalidates against the tag we would recompute.
        assert!(if_none_match_matches(&etag, &body_etag(body)));
        // Any byte of menu drift (a sold-out flip, a price, a stock dip) is a
        // new representation, so the old tag no longer matches.
        assert!(!if_none_match_matches(
            &etag,
            &body_etag(br#"{"items":[],"options":[{"sold_out":true}]}"#)
        ));
    }
}
