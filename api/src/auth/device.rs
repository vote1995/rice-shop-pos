//! Device auth: a shop tablet/phone identifies itself with the opaque
//! `X-Device-Token` handed out exactly once by `POST /device/register`
//! (FEATURES 3.55, 3.71). Only the SHA-256 hash of that token is stored, so
//! the lookup below is hash -> row; a DB leak does not leak tokens.
//!
//! Error semantics: missing/unknown token -> 401 `invalid_device`. The row is
//! returned for EVERY status: `GET /device/status` must answer for revoked
//! devices too (the client then wipes local data, 3.56). Endpoints that do
//! real POS work gate on [`DeviceAuth::require_approved`] instead.

use axum::{extract::FromRequestParts, http::request::Parts, http::StatusCode};
use serde::Deserialize;
use worker::{send::SendFuture, Env};

use super::crypto;
use crate::{db, error::ApiError, util::txt, AppState};

#[derive(Debug, Clone)]
pub struct DeviceAuth {
    pub device_id: String,
    pub shop_id: Option<String>,
    pub status: String,
}

impl DeviceAuth {
    /// Only an owner-approved device tied to a shop may serve POS traffic
    /// (3.55). Returns that shop id; 403 `device_pending`/`device_revoked`
    /// otherwise.
    pub fn require_approved(&self) -> Result<String, ApiError> {
        match self.status.as_str() {
            "approved" => self.shop_id.clone().ok_or_else(|| {
                // Unreachable given the devices table CHECK, kept for safety.
                ApiError::Internal(format!("device {} approved without a shop", self.device_id))
            }),
            "pending" => Err(ApiError::coded(
                StatusCode::FORBIDDEN,
                "device_pending",
                "device is awaiting owner approval",
            )),
            _ => Err(ApiError::coded(
                StatusCode::FORBIDDEN,
                "device_revoked",
                "device has been revoked by the owner",
            )),
        }
    }
}

impl FromRequestParts<AppState> for DeviceAuth {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        let token = parts
            .headers
            .get("x-device-token")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let env = state.env.clone();
        SendFuture::new(async move { device_by_token(&env, token.as_deref()).await })
    }
}

/// Token -> device row (any status). Also the device half of staff auth, so
/// both extractors share one lookup shape.
pub(crate) async fn device_by_token(
    env: &Env,
    token: Option<&str>,
) -> Result<DeviceAuth, ApiError> {
    let Some(token) = token.filter(|t| !t.is_empty()) else {
        return Err(ApiError::coded(
            StatusCode::UNAUTHORIZED,
            "invalid_device",
            "missing X-Device-Token header",
        ));
    };
    #[derive(Deserialize)]
    struct Row {
        id: String,
        shop_id: Option<String>,
        status: String,
    }
    let row = db::db(env)?
        .prepare("SELECT id, shop_id, status FROM devices WHERE device_token_hash = ?1")
        .bind(&[txt(&crypto::sha256_hex(token))])?
        .first::<Row>(None)
        .await?;
    match row {
        Some(Row { id, shop_id, status }) => Ok(DeviceAuth {
            device_id: id,
            shop_id,
            status,
        }),
        None => Err(ApiError::coded(
            StatusCode::UNAUTHORIZED,
            "invalid_device",
            "unknown device token",
        )),
    }
}
