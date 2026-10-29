//! Request extractors that reject with [`ApiError`] (JSON body) instead of
//! axum's plain-text rejections, so clients always get `{"error","message"}`.

use axum::{
    extract::{FromRequest, Request},
    Json,
};
use serde::de::DeserializeOwned;

use crate::error::ApiError;

/// Drop-in for `axum::Json` in request position. Malformed JSON, wrong
/// content-type and unknown/missing fields all become 400 `bad_request`.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(ApiError::BadRequest(rejection.body_text())),
        }
    }
}
