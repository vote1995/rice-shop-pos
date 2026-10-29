//! `/owner/*` - owner app API. Every handler takes [`OwnerAuth`].
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
//! - menu CRUD lives in [`menu`] (M1-1a)
//!
//! The generic helpers (`now_ms`, `txt`, `int`, `clean_name`, `parse_uuid`)
//! moved to `crate::util` in M0-2b, when the device/staff endpoints started
//! needing them too.

pub mod devices;
pub mod menu;
pub mod shops;
pub mod staff;

use axum::Json;
use serde_json::{json, Value};

use crate::auth::owner::OwnerAuth;

pub async fn me(owner: OwnerAuth) -> Json<Value> {
    Json(json!({ "user_id": owner.user_id, "email": owner.email }))
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
