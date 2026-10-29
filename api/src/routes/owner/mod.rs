//! `/owner/*` — owner app API. Every handler takes [`OwnerAuth`].
//!
//! Endpoints (all JSON, ids are client-generated UUIDs, FEATURES 3.70):
//! - `GET  /owner/shops`                 list shops
//! - `POST /owner/shops`                 create shop (idempotent by id)
//! - `GET  /owner/staff?shop_id=`        list staff of one shop (no PIN material)
//! - `POST /owner/staff`                 create staff user with a PIN
//! - `POST /owner/staff/{id}/reset-pin`  new salt+hash, revoke sessions
//! - `POST /owner/staff/{id}/revoke`     status='revoked', revoke sessions
//! - `GET  /owner/devices?status=`       list devices (never token hashes)
//! - `POST /owner/devices/{id}/approve`  pending -> approved
//! - `POST /owner/devices/{id}/revoke`   -> revoked (idempotent)

pub mod devices;
pub mod shops;
pub mod staff;

use axum::Json;
use serde_json::{json, Value};
use uuid::Uuid;
use wasm_bindgen::JsValue;
use worker::Date;

use crate::auth::owner::OwnerAuth;
use crate::error::ApiError;

pub async fn me(owner: OwnerAuth) -> Json<Value> {
    Json(json!({ "user_id": owner.user_id, "email": owner.email }))
}

/// "Now" in the schema's canonical unit: unix milliseconds (migrations, 0001).
pub(super) fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// D1 bind values. Kept explicit (and uniform in bind slices) instead of
/// `.into()` so the JsValue target type never depends on inference.
pub(super) fn txt(v: &str) -> JsValue {
    JsValue::from(v)
}

/// Timestamps/counters are exact in f64 (unix ms ≪ 2^53), so this binds
/// losslessly; SQLite accepts integral REALs in INTEGER columns (STRICT).
pub(super) fn int(v: i64) -> JsValue {
    JsValue::from_f64(v as f64)
}

/// Names of shops/staff/devices: trimmed, non-empty, at most 100 characters.
pub(super) fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::BadRequest(
            "name must be 1-100 characters after trimming".into(),
        ));
    }
    Ok(name.to_owned())
}

/// Ids come from the client and are UUIDs by schema convention; else 400.
pub(super) fn parse_uuid(raw: &str, field: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::BadRequest(format!("invalid uuid for {field}")))
}

/// First value of `key` in a raw query string (`a=1&b=2`). No percent-decoding:
/// our query values (uuid / status enum) never need it.
pub(super) fn query_param(raw: &Option<String>, key: &str) -> Option<String> {
    let raw = raw.as_deref()?;
    for pair in raw.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(v.to_owned());
            }
        }
    }
    None
}
