//! Owner menu-image endpoints (FEATURES 3.2, 3.79; quotas in [`crate::media`]).
//!
//! - `PUT    /owner/menu-items/{id}/image`  raw WebP/JPEG body (client resizes first)
//! - `DELETE /owner/menu-items/{id}/image`
//! - `GET    /owner/media-usage`            this month's R2 usage vs the app limits
//!
//! Every upload stores a NEW immutable key; the item is switched to it with a
//! conditional UPDATE (`image_key IS <the key we read>`), so two concurrent
//! uploads can never orphan an object: the loser deletes its own upload.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde_json::{json, Value};
use worker::Env;

use crate::auth::owner::OwnerAuth;
use crate::media::{self, OpClass};
use crate::routes::orders::changes;
use crate::routes::owner::menu::{load_menu_item, MenuItem};
use crate::util::{int, now_ms, opt_txt, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

fn quota_error(message: &str) -> ApiError {
    ApiError::coded(StatusCode::CONFLICT, "media_quota", message)
}

/// Best-effort removal of an object we no longer reference. DeleteObject is
/// free (no quota). A failure only leaves an orphan: logged, never surfaced.
async fn remove_object(env: &Env, key: &str) {
    let result = async {
        db::media(env)?.delete(key).await?;
        db::db(env)?
            .prepare("DELETE FROM media_objects WHERE key = ?1")
            .bind(&[txt(key)])?
            .run()
            .await?;
        Ok::<(), ApiError>(())
    }
    .await;
    if let Err(e) = result {
        worker::console_error!("media: could not remove {key}: {e:?}");
    }
}

/// Point the item at `new_key` only if it still has `old_key`; true on success.
async fn swap_image_key(
    env: &Env,
    item: &MenuItem,
    new_key: Option<&str>,
) -> Result<bool, ApiError> {
    let result = db::db(env)?
        .prepare(
            "UPDATE menu_items SET image_key = ?1, updated_at = ?2
             WHERE id = ?3 AND shop_id = ?4 AND image_key IS ?5",
        )
        .bind(&[
            opt_txt(new_key),
            int(now_ms()),
            txt(&item.id),
            txt(&item.shop_id),
            opt_txt(item.image_key.as_deref()),
        ])?
        .run()
        .await?;
    Ok(changes(&result)? > 0)
}

async fn reload(env: &Env, id: &str) -> Result<Json<MenuItem>, ApiError> {
    let item = load_menu_item(env, id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("menu item {id} vanished")))?;
    Ok(Json(item))
}

#[worker::send]
pub async fn put_image(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
    body: Bytes,
) -> Result<Json<MenuItem>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    if body.is_empty() || body.len() > media::MAX_IMAGE_BYTES {
        return Err(ApiError::coded(
            StatusCode::PAYLOAD_TOO_LARGE,
            "image_too_large",
            format!("image must be 1..={} bytes", media::MAX_IMAGE_BYTES),
        ));
    }
    let (content_type, ext) = media::sniff_image(&body)
        .ok_or_else(|| ApiError::BadRequest("image must be WebP or JPEG".into()))?;
    let env = &state.env;
    let item = load_menu_item(env, &id).await?.ok_or(ApiError::NotFound)?;
    let key = media::new_menu_key(&item.shop_id, ext);
    let bytes = body.len() as i64;

    // Storage quota: the row is the reservation, inserted only if it fits.
    let reserved = db::db(env)?
        .prepare(
            "INSERT INTO media_objects (key, shop_id, bytes, created_at)
             SELECT ?1, ?2, ?3, ?4
             WHERE (SELECT COALESCE(SUM(bytes), 0) FROM media_objects) + ?3 <= ?5",
        )
        .bind(&[
            txt(&key),
            txt(&item.shop_id),
            int(bytes),
            int(now_ms()),
            int(media::MAX_TOTAL_BYTES),
        ])?
        .run()
        .await?;
    if changes(&reserved)? == 0 {
        return Err(quota_error("image storage quota reached"));
    }
    // From here on every failure path releases the reservation (remove_object).
    if !media::reserve_op(env, OpClass::A).await? {
        remove_object(env, &key).await;
        return Err(quota_error("monthly image upload quota reached"));
    }
    let put = db::media(env)?
        .put(key.as_str(), body.to_vec())
        .http_metadata(worker::HttpMetadata {
            content_type: Some(content_type.to_owned()),
            cache_control: Some(media::CACHE_CONTROL.to_owned()),
            ..Default::default()
        })
        .execute()
        .await;
    if let Err(e) = put {
        remove_object(env, &key).await;
        return Err(e.into());
    }

    if !swap_image_key(env, &item, Some(&key)).await? {
        remove_object(env, &key).await;
        return Err(ApiError::Conflict(
            "the item's image changed meanwhile, reload and retry".into(),
        ));
    }
    if let Some(old) = &item.image_key {
        remove_object(env, old).await;
    }
    reload(env, &id).await
}

#[worker::send]
pub async fn delete_image(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<MenuItem>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let item = load_menu_item(env, &id).await?.ok_or(ApiError::NotFound)?;
    let Some(old) = item.image_key.clone() else {
        return reload(env, &id).await;
    };
    if !swap_image_key(env, &item, None).await? {
        return Err(ApiError::Conflict(
            "the item's image changed meanwhile, reload and retry".into(),
        ));
    }
    remove_object(env, &old).await;
    reload(env, &id).await
}

#[derive(serde::Deserialize)]
struct UsageRow {
    class_a: i64,
    class_b: i64,
}

#[worker::send]
pub async fn usage(
    State(state): State<AppState>,
    _owner: OwnerAuth,
) -> Result<Json<Value>, ApiError> {
    let env = &state.env;
    let month = media::month_key(now_ms());
    let ops = db::db(env)?
        .prepare("SELECT class_a, class_b FROM media_usage WHERE month = ?1")
        .bind(&[txt(&month)])?
        .first::<UsageRow>(None)
        .await?
        .unwrap_or(UsageRow {
            class_a: 0,
            class_b: 0,
        });
    let stored_bytes = db::db(env)?
        .prepare("SELECT COALESCE(SUM(bytes), 0) AS stored FROM media_objects")
        .first::<i64>(Some("stored"))
        .await?
        .unwrap_or(0);
    Ok(Json(json!({
        "month": month,
        "class_a": ops.class_a,
        "class_b": ops.class_b,
        "stored_bytes": stored_bytes,
        "limits": {
            "max_image_bytes": media::MAX_IMAGE_BYTES,
            "max_total_bytes": media::MAX_TOTAL_BYTES,
            "max_class_a_per_month": media::MAX_CLASS_A_PER_MONTH,
            "max_class_b_per_month": media::MAX_CLASS_B_PER_MONTH,
        },
    })))
}
