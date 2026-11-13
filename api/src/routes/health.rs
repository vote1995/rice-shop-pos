//! `GET /health` — liveness probe used by ops/CI and (later) the PWA to check
//! the API is reachable. Deliberately cheap: no D1 round-trip.
//!
//! `GET /health/deep` — the readiness probe for EXTERNAL monitors
//! (UptimeRobot / Better Stack, docs/monitoring.md): the same `d1`/`r2` checks
//! the cron monitor runs, live, plus the cron heartbeat. The body is booleans
//! only — no details, versions, ids or error text — and it answers 200 only
//! when everything is true, else 503, so a probe just watches the status code.

use axum::{extract::State, response::{IntoResponse, Response}, Json};
use serde_json::{json, Value};

use crate::{monitor, AppState};

pub async fn health(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// `{ok, d1, r2, cron}` — `cron` is false when the heartbeat row is missing
/// or older than 5 minutes (the every-minute cron stopped). 503 unless all
/// four are true.
#[worker::send]
pub async fn deep(State(state): State<AppState>) -> Response {
    let (d1, _) = monitor::check_d1(&state.env).await;
    let (r2, _) = monitor::check_r2(&state.env).await;
    let cron = monitor::heartbeat_alive(&state.env).await;
    let ok = d1 && r2 && cron;
    let mut res = Json(json!({ "ok": ok, "d1": d1, "r2": r2, "cron": cron })).into_response();
    *res.status_mut() = if ok {
        axum::http::StatusCode::OK
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    res
}
