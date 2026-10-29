//! Staff auth = an approved device (`X-Device-Token`) plus the session bearer
//! token from `POST /auth/pin` (`Authorization: Bearer <session_token>`).
//! Both halves must belong together: the session row's `device_id` must equal
//! the device presenting it, so a session token copied to another (even
//! approved) tablet is worthless. A single join re-checks session, user and
//! device state, so revoked users / revoked devices / PIN resets kill the
//! session on the very next request.

use axum::{extract::FromRequestParts, http::request::Parts, http::StatusCode};
use serde::Deserialize;
use worker::{send::SendFuture, Env};

use super::{crypto, device::device_by_token};
use crate::error::ApiError;
use crate::util::{int, now_ms, txt};
use crate::{db, AppState};

#[derive(Debug, Clone)]
pub struct StaffAuth {
    pub session_id: String,
    pub user_id: String,
    pub shop_id: String,
    pub device_id: String,
}

fn session_invalid() -> ApiError {
    ApiError::coded(
        StatusCode::UNAUTHORIZED,
        "session_invalid",
        "staff session missing, expired or revoked; log in again",
    )
}

impl FromRequestParts<AppState> for StaffAuth {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let device_token = parts
            .headers
            .get("x-device-token")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let session_token = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_owned);
        let env = state.env.clone();
        SendFuture::new(async move {
            authenticate(&env, device_token.as_deref(), session_token.as_deref()).await
        })
    }
}

async fn authenticate(
    env: &Env,
    device_token: Option<&str>,
    session_token: Option<&str>,
) -> Result<StaffAuth, ApiError> {
    // 403 device_pending/device_revoked if the device half is not approved.
    let device = device_by_token(env, device_token).await?;
    let shop_id = device.require_approved()?;

    let Some(session_token) = session_token.filter(|t| !t.is_empty()) else {
        return Err(session_invalid());
    };

    #[derive(Deserialize)]
    struct Row {
        id: String,
        user_id: String,
        shop_id: String,
        device_id: String,
    }
    let row = db::db(env)?
        .prepare(
            "SELECT s.id AS id, s.user_id AS user_id, s.shop_id AS shop_id,
                    s.device_id AS device_id
             FROM staff_sessions s
             JOIN users u   ON u.id = s.user_id
             JOIN devices d ON d.id = s.device_id
             WHERE s.token_hash = ?1
               AND s.revoked_at IS NULL
               AND s.expires_at > ?2
               AND s.device_id = ?3
               AND s.shop_id = ?4
               AND u.status = 'active'
               AND d.status = 'approved'",
        )
        .bind(&[
            txt(&crypto::sha256_hex(session_token)),
            int(now_ms()),
            txt(&device.device_id),
            txt(&shop_id),
        ])?
        .first::<Row>(None)
        .await?;
    match row {
        Some(Row {
            id,
            user_id,
            shop_id,
            device_id,
        }) => Ok(StaffAuth {
            session_id: id,
            user_id,
            shop_id,
            device_id,
        }),
        None => Err(session_invalid()),
    }
}
