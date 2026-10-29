//! JSON error type shared by all handlers.
//!
//! Every error is rendered as `{"error": <machine-readable code>, "message": <human string>}`
//! with an appropriate HTTP status, so clients (and the future PWA) can branch
//! on `error` and display `message`.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum ApiError {
    NotFound,
    BadRequest(String),
    Unauthorized,
    Forbidden,
    /// Duplicate id with different data, invalid state transition, ...
    Conflict(String),
    /// An upstream we depend on (e.g. Access JWKS) failed: the outcome is
    /// undecidable, so this must never be reported as 401/403.
    Unavailable(String),
    /// Unexpected failure (binding missing, D1 error, ...). The detail is only
    /// logged server-side; clients get a generic message.
    Internal(String),
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            ApiError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "upstream_unavailable"),
            ApiError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        let message = match self {
            ApiError::BadRequest(msg) | ApiError::Conflict(msg) => msg,
            ApiError::Unavailable(detail) => {
                worker::console_warn!("upstream_unavailable: {detail}");
                "upstream service unavailable, try again".to_string()
            }
            ApiError::Internal(detail) => {
                // Keep internals out of the response body; console.error shows up in
                // `wrangler dev` / `wrangler tail`.
                worker::console_error!("internal_error: {detail}");
                "internal server error".to_string()
            }
            _ => code.to_string(),
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

impl From<worker::Error> for ApiError {
    fn from(err: worker::Error) -> Self {
        ApiError::Internal(err.to_string())
    }
}
