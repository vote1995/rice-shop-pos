//! `GET /media/{*key}` - menu images from R2 (FEATURES 3.2, 3.79).
//!
//! No auth on purpose: the staff POS on `pos.` renders these, and a key is
//! two random uuids (unguessable), not an enumerable id. Only keys of the
//! exact shape the app writes are looked up ([`media::valid_media_key`]).
//!
//! Keys are immutable, so responses are cacheable forever and a revalidation
//! (`If-None-Match`) is answered 304 without touching R2 or the read quota.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use crate::media::{self, OpClass};
use crate::{db, error::ApiError, AppState};

#[worker::send]
pub async fn get_media(
    State(state): State<AppState>,
    Path(key): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if !media::valid_media_key(&key) {
        return Err(ApiError::NotFound);
    }
    let etag = format!("\"{key}\"");
    let revalidating = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    if revalidating {
        return Ok((
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, media::CACHE_CONTROL.to_owned()),
            ],
        )
            .into_response());
    }

    let env = &state.env;
    if !media::reserve_op(env, OpClass::B).await? {
        // Monthly read quota spent: the POS shows the dish without its photo.
        return Err(ApiError::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "media_quota",
            "monthly image read quota reached",
        ));
    }
    let object = db::media(env)?
        .get(key.as_str())
        .execute()
        .await?
        .ok_or(ApiError::NotFound)?;
    let content_type = object
        .http_metadata()
        .content_type
        .unwrap_or_else(|| media::content_type_for_key(&key).to_owned());
    let bytes = object
        .body()
        .ok_or_else(|| ApiError::Internal(format!("R2 object {key} has no body")))?
        .bytes()
        .await?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, media::CACHE_CONTROL.to_owned()),
            (header::ETAG, etag),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        ],
        Body::from(bytes),
    )
        .into_response())
}
