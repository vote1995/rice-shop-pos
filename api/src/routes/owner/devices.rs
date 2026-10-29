//! `/owner/devices` — shop tablets/phones (schema `devices`, FEATURES 3.52,
//! 3.55–3.56). `device_token_hash` is never selected: the token itself lives
//! only on the device (3.71).

use axum::{
    extract::{Path, RawQuery, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::Env;

use super::query_param;
use crate::util::{int, now_ms, parse_uuid, txt};
use crate::auth::owner::OwnerAuth;
use crate::extract::ApiJson;
use crate::{db, error::ApiError, AppState};

#[derive(Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub shop_id: Option<String>,
    pub name: String,
    pub model: Option<String>,
    pub status: String,
    pub registered_at: i64,
    pub approved_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub last_sync_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveBody {
    pub shop_id: String,
}

#[worker::send]
pub async fn list(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    RawQuery(query): RawQuery,
) -> Result<Json<Vec<Device>>, ApiError> {
    const STATUSES: [&str; 3] = ["pending", "approved", "revoked"];
    let status = match query_param(&query, "status") {
        None => None,
        Some(s) if STATUSES.contains(&s.as_str()) => Some(s),
        Some(_) => {
            return Err(ApiError::BadRequest(
                "status must be one of: pending, approved, revoked".into(),
            ))
        }
    };

    let env = &state.env;
    // Two fixed statements instead of string-building the WHERE clause; the
    // optional status value itself is always a bound parameter.
    let devices = match status {
        Some(status) => db::db(env)?
            .prepare(
                "SELECT id, shop_id, name, model, status, registered_at, approved_at, \
                 revoked_at, last_sync_at
                 FROM devices WHERE status = ?1 ORDER BY registered_at, id",
            )
            .bind(&[txt(&status)])?
            .all()
            .await?
            .results::<Device>()?,
        None => db::db(env)?
            .prepare(
                "SELECT id, shop_id, name, model, status, registered_at, approved_at, \
                 revoked_at, last_sync_at
                 FROM devices ORDER BY registered_at, id",
            )
            .all()
            .await?
            .results::<Device>()?,
    };
    Ok(Json(devices))
}

/// pending -> approved. Only the owner does this, and only while the device is
/// still pending (3.55); the shop is chosen at approval time, not registration.
#[worker::send]
pub async fn approve(
    State(state): State<AppState>,
    owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ApproveBody>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let shop_id = parse_uuid(&body.shop_id, "shop_id")?.to_string();
    let env = &state.env;

    let device = load_device(env, &id).await?.ok_or(ApiError::NotFound)?;
    if device.status != "pending" {
        return Err(ApiError::Conflict(format!(
            "device {id} is not pending (current status: {status})",
            status = device.status
        )));
    }

    let shop = db::db(env)?
        .prepare("SELECT id FROM shops WHERE id = ?1")
        .bind(&[txt(&shop_id)])?
        .first::<String>(Some("id"))
        .await?;
    if shop.is_none() {
        return Err(ApiError::NotFound);
    }

    let now = now_ms();
    let updated = db::db(env)?
        .prepare(
            "UPDATE devices
             SET shop_id = ?1, status = 'approved', approved_by = ?2,
                 approved_at = ?3, updated_at = ?3
             WHERE id = ?4 AND status = 'pending'",
        )
        .bind(&[
            txt(&shop_id),
            txt(&owner.user_id),
            int(now),
            txt(&id),
        ])?
        .run()
        .await?;
    // Guarded by `status = 'pending'`: a concurrent revoke wins over approve.
    if updated.meta()?.and_then(|m| m.changes).unwrap_or(0) == 0 {
        return Err(ApiError::Conflict(format!("device {id} is no longer pending")));
    }

    Ok(Json(json!({
        "id": id,
        "shop_id": shop_id,
        "status": "approved",
        "approved_at": now,
    })))
}

/// -> revoked (3.56), plus that device's live staff_sessions in the same batch.
/// Revoking an already-revoked device is an idempotent 200.
#[worker::send]
pub async fn revoke(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let device = load_device(env, &id).await?.ok_or(ApiError::NotFound)?;

    let now = now_ms();
    if device.status != "revoked" {
        db::db(env)?
            .batch(vec![
                db::db(env)?
                    .prepare(
                        "UPDATE devices
                         SET status = 'revoked', revoked_at = ?1, updated_at = ?1
                         WHERE id = ?2",
                    )
                    .bind(&[int(now), txt(&id)])?,
                db::db(env)?
                    .prepare(
                        "UPDATE staff_sessions
                         SET revoked_at = ?1
                         WHERE device_id = ?2 AND revoked_at IS NULL",
                    )
                    .bind(&[int(now), txt(&id)])?,
            ])
            .await?;
        return Ok(Json(json!({
            "id": id,
            "status": "revoked",
            "revoked_at": now,
        })));
    }

    // Already revoked: report the stored state unchanged.
    Ok(Json(json!({
        "id": id,
        "status": "revoked",
        "revoked_at": device.revoked_at,
    })))
}

async fn load_device(env: &Env, id: &str) -> Result<Option<Device>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT id, shop_id, name, model, status, registered_at, approved_at, \
             revoked_at, last_sync_at
             FROM devices WHERE id = ?1",
        )
        .bind(&[txt(id)])?
        .first::<Device>(None)
        .await?)
}
