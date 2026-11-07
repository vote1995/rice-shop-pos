//! `/slip-agent/*` — the LOCAL slip reader (tools/slip-agent on the owner's
//! PC). It pulls work, so the PC never needs an inbound port. Auth is one
//! shared secret, `SLIP_AGENT_TOKEN` (wrangler secret / .dev.vars), sent as
//! `X-Slip-Agent-Token`. Unset secret = the agent API is closed (503).
//!
//! - `POST /slip-agent/heartbeat`              `{info?}` -> `{ok}`
//! - `POST /slip-agent/claim`                  -> `{job: null | {slip_id, page_count, prompt}}`
//! - `GET  /slip-agent/slips/{id}/pages/{n}`   JPEG, only while that slip is being read locally
//! - `POST /slip-agent/slips/{id}/result`      `{ok:true,result}` | `{ok:false,error}`

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use worker::Env;

use crate::auth::env_str;
use crate::extract::ApiJson;
use crate::routes::owner::slips::jpeg_response;
use crate::slips::{self, cloud, load_slip, validate_result, MAX_PAGES, PROMPT};
use crate::util::parse_uuid;
use crate::{error::ApiError, AppState};

const TOKEN_HEADER: &str = "x-slip-agent-token";

/// Constant-time token check (compares SHA-256 digests, so length leaks nothing).
fn check_agent(env: &Env, headers: &HeaderMap) -> Result<(), ApiError> {
    let expected = env_str(env, "SLIP_AGENT_TOKEN");
    if expected.len() < 32 {
        return Err(ApiError::Unavailable(
            "SLIP_AGENT_TOKEN is not configured (min 32 chars)".into(),
        ));
    }
    let given = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let a = Sha256::digest(expected.as_bytes());
    let b = Sha256::digest(given.as_bytes());
    let diff = a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    if diff == 0 {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

#[derive(Deserialize, Default)]
pub struct HeartbeatBody {
    info: Option<String>,
}

#[worker::send]
pub async fn heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    check_agent(&state.env, &headers)?;
    // Body is optional; a malformed one only loses the info text.
    let info = serde_json::from_slice::<HeartbeatBody>(&body).ok().and_then(|b| b.info);
    slips::touch_heartbeat(&state.env, info.as_deref()).await?;
    Ok(Json(json!({ "ok": true })))
}

#[worker::send]
pub async fn claim(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let env = &state.env;
    check_agent(env, &headers)?;
    slips::touch_heartbeat(env, None).await?;
    let job = slips::claim_next(env, "local").await?.map(|c| {
        json!({ "slip_id": c.id, "page_count": c.page_count, "prompt": PROMPT })
    });
    Ok(Json(json!({ "job": job })))
}

async fn reading_locally(env: &Env, id: &str) -> Result<slips::SlipRow, ApiError> {
    let row = load_slip(env, id).await?.ok_or(ApiError::NotFound)?;
    if row.status != "reading" || row.reader.as_deref() != Some("local") {
        return Err(ApiError::Conflict(format!(
            "slip is {} ({}), not being read locally",
            row.status,
            row.reader.as_deref().unwrap_or("-")
        )));
    }
    Ok(row)
}

#[worker::send]
pub async fn page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((id, page)): Path<(String, i64)>,
) -> Result<Response, ApiError> {
    let env = &state.env;
    check_agent(env, &headers)?;
    let id = parse_uuid(&id, "id")?.to_string();
    let row = reading_locally(env, &id).await?;
    if !(1..=MAX_PAGES.min(row.page_count)).contains(&page) {
        return Err(ApiError::NotFound);
    }
    jpeg_response(cloud::load_page(env, &row.shop_id, &id, page).await?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultBody {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

#[worker::send]
pub async fn result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ResultBody>,
) -> Result<Json<Value>, ApiError> {
    let env = &state.env;
    check_agent(env, &headers)?;
    let id = parse_uuid(&id, "id")?.to_string();
    reading_locally(env, &id).await?;
    let outcome = if body.ok {
        validate_result(body.result.unwrap_or(Value::Null))
            .map_err(|e| format!("invalid reader output: {e}"))
    } else {
        Err(body.error.unwrap_or_else(|| "local reader failed".into()))
    };
    let accepted = outcome.is_ok();
    if !slips::finish(env, &id, "local", outcome).await? {
        return Err(ApiError::Conflict("slip is no longer being read locally".into()));
    }
    Ok(Json(json!({ "ok": true, "accepted": accepted })))
}
