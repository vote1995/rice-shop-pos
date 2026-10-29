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

use axum::{
    extract::{Path, State},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::staff::StaffAuth;
use crate::extract::ApiJson;
use crate::routes::owner::menu::{
    load_menu_item, load_option, MenuItem, MenuOption, OptionGroup,
};
use crate::util::{int, now_ms, parse_uuid, txt};
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SoldOutBody {
    pub sold_out: bool,
}

/// The menu of the session shop as the POS needs it: active items, all option
/// groups and options of the shop (sold-out rows included, dimmed client-side)
/// and the channel markup so the POS can price delivery lines (3.6).
#[worker::send]
pub async fn staff_menu(
    State(state): State<AppState>,
    staff: StaffAuth,
) -> Result<Json<Value>, ApiError> {
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
             WHERE shop_id = ?1 AND status = 'active'
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

    Ok(Json(json!({
        "items": items,
        "option_groups": option_groups,
        "options": options,
        "channel_markup": channel_markup,
    })))
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
