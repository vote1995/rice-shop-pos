//! `GET /health` — liveness probe used by ops/CI and (later) the PWA to check
//! the API is reachable. Deliberately cheap: no D1 round-trip.

use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::AppState;

pub async fn health(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({ "ok": true }))
}
