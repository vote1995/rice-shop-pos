//! `/owner/*` — owner app API. Every handler takes [`OwnerAuth`].

use axum::Json;
use serde_json::{json, Value};

use crate::auth::owner::OwnerAuth;

pub async fn me(owner: OwnerAuth) -> Json<Value> {
    Json(json!({ "user_id": owner.user_id, "email": owner.email }))
}
