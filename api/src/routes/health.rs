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

use std::cell::Cell;

use crate::{monitor, util::now_ms, AppState};

/// How long one isolate reuses a probe result. The endpoint is unauthenticated, so
/// without this anyone could make every hit cost 2 D1 reads + 1 R2 read. A 30 s
/// window keeps an external monitor (1-5 min) accurate and bounds the cost to at
/// most one live probe per isolate per 30 s however often it is hit.
pub const DEEP_CACHE_MS: i64 = 30_000;

/// Is a result stored at `stored_at` still usable at `now`? Pure, unit-tested.
pub fn cache_fresh(stored_at: i64, now: i64) -> bool {
    now >= stored_at && now - stored_at < DEEP_CACHE_MS
}

#[derive(Clone, Copy)]
struct Probe {
    at: i64,
    d1: bool,
    r2: bool,
    cron: bool,
}

thread_local! {
    static DEEP_CACHE: Cell<Option<Probe>> = const { Cell::new(None) };
}

pub async fn health(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({ "ok": true }))
}

/// `{ok, d1, r2, cron}` — `cron` is false when the heartbeat row is missing
/// or older than 5 minutes (the every-minute cron stopped). 503 unless all
/// four are true.
#[worker::send]
pub async fn deep(State(state): State<AppState>) -> Response {
    let now = now_ms();
    let probe = match DEEP_CACHE.with(Cell::get) {
        Some(p) if cache_fresh(p.at, now) => p,
        _ => {
            let (d1, _) = monitor::check_d1(&state.env).await;
            let (r2, _) = monitor::check_r2(&state.env).await;
            let cron = monitor::heartbeat_alive(&state.env).await;
            let p = Probe { at: now, d1, r2, cron };
            DEEP_CACHE.with(|c| c.set(Some(p)));
            p
        }
    };
    let (d1, r2, cron) = (probe.d1, probe.r2, probe.cron);
    let ok = d1 && r2 && cron;
    let mut res = Json(json!({ "ok": ok, "d1": d1, "r2": r2, "cron": cron })).into_response();
    *res.status_mut() = if ok {
        axum::http::StatusCode::OK
    } else {
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    };
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_result_is_reused_for_thirty_seconds_only() {
        assert!(cache_fresh(1_000, 1_000));
        assert!(cache_fresh(1_000, 1_000 + DEEP_CACHE_MS - 1));
        assert!(!cache_fresh(1_000, 1_000 + DEEP_CACHE_MS));
        // a clock that went backwards never serves a stale entry
        assert!(!cache_fresh(5_000, 4_000));
    }
}
