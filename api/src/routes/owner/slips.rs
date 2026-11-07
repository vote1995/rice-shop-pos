//! Owner slip endpoints (phase 1: upload + read status; see [`crate::slips`]).
//!
//! - `POST   /owner/slips`                    `{id, shop_id}` -> draft
//! - `PUT    /owner/slips/{id}/pages/{page}`  raw JPEG (client resizes first), draft only
//! - `POST   /owner/slips/{id}/submit`        route to a reader (may read in-request via the cloud)
//! - `GET    /owner/slips?shop_id=`           `{reader, slips}` newest first
//! - `GET    /owner/slips/{id}`
//! - `GET    /owner/slips/{id}/pages/{page}`  the JPEG (private, owner only)
//! - `DELETE /owner/slips/{id}`

use axum::{
    body::{Body, Bytes},
    extract::{Path, RawQuery, State},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use worker::Env;

use super::query_param;
use crate::auth::owner::OwnerAuth;
use crate::extract::ApiJson;
use crate::media::{self, OpClass};
use crate::routes::orders::changes;
use crate::slips::{self, cloud, load_slip, page_key, SlipRow, MAX_PAGES, MAX_PAGE_BYTES, SLIP_COLS};
use crate::util::{int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

async fn shop_exists(env: &Env, shop_id: &str) -> Result<bool, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT 1 AS ok FROM shops WHERE id = ?1")
        .bind(&[txt(shop_id)])?
        .first::<i64>(Some("ok"))
        .await?
        .is_some())
}

async fn must_load(env: &Env, id: &str) -> Result<SlipRow, ApiError> {
    load_slip(env, id).await?.ok_or(ApiError::NotFound)
}

fn parse_page(page: i64) -> Result<i64, ApiError> {
    if (1..=MAX_PAGES).contains(&page) {
        Ok(page)
    } else {
        Err(ApiError::BadRequest(format!("page must be 1..={MAX_PAGES}")))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateBody {
    id: String,
    shop_id: String,
}

#[worker::send]
pub async fn create(
    State(state): State<AppState>,
    owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let shop_id = parse_uuid(&body.shop_id, "shop_id")?.to_string();
    let env = &state.env;
    if !shop_exists(env, &shop_id).await? {
        return Err(ApiError::NotFound);
    }
    let now = now_ms();
    db::db(env)?
        .prepare(
            "INSERT INTO slips (id, shop_id, uploaded_by, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'draft', ?4, ?4) ON CONFLICT(id) DO NOTHING",
        )
        .bind(&[txt(&id), txt(&shop_id), txt(&owner.user_id), int(now)])?
        .run()
        .await?;
    let row = must_load(env, &id).await?;
    if row.shop_id != shop_id {
        return Err(ApiError::Conflict(format!("slip {id} exists in another shop")));
    }
    Ok((StatusCode::CREATED, Json(row.to_json())))
}

#[worker::send]
pub async fn put_page(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path((id, page)): Path<(String, i64)>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let page = parse_page(page)?;
    if body.is_empty() || body.len() > MAX_PAGE_BYTES {
        return Err(ApiError::coded(
            StatusCode::PAYLOAD_TOO_LARGE,
            "image_too_large",
            format!("page must be 1..={MAX_PAGE_BYTES} bytes"),
        ));
    }
    if media::sniff_image(&body).map(|(ct, _)| ct) != Some("image/jpeg") {
        return Err(ApiError::BadRequest("page must be a JPEG".into()));
    }
    let env = &state.env;
    let row = must_load(env, &id).await?;
    if row.status != "draft" {
        return Err(ApiError::Conflict(format!("slip is {}, pages are fixed", row.status)));
    }
    let key = page_key(&row.shop_id, &id, page);
    let bytes = body.len() as i64;
    // Storage quota: same bookkeeping as menu images (media_objects = reservation).
    let reserved = db::db(env)?
        .prepare(
            "INSERT INTO media_objects (key, shop_id, bytes, created_at)
             SELECT ?1, ?2, ?3, ?4
             WHERE (SELECT COALESCE(SUM(bytes), 0) FROM media_objects WHERE key <> ?1) + ?3 <= ?5
             ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes",
        )
        .bind(&[txt(&key), txt(&row.shop_id), int(bytes), int(now_ms()), int(media::MAX_TOTAL_BYTES)])?
        .run()
        .await?;
    if changes(&reserved)? == 0 {
        return Err(ApiError::coded(StatusCode::CONFLICT, "media_quota", "image storage quota reached"));
    }
    if !media::reserve_op(env, OpClass::A).await? {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "media_quota",
            "monthly image upload quota reached",
        ));
    }
    db::media(env)?
        .put(key.as_str(), body.to_vec())
        .http_metadata(worker::HttpMetadata {
            content_type: Some("image/jpeg".to_owned()),
            ..Default::default()
        })
        .execute()
        .await?;
    db::db(env)?
        .prepare(
            "UPDATE slips SET page_count = MAX(page_count, ?2), updated_at = ?3
             WHERE id = ?1 AND status = 'draft'",
        )
        .bind(&[txt(&id), int(page), int(now_ms())])?
        .run()
        .await?;
    Ok(Json(must_load(env, &id).await?.to_json()))
}

/// Draft -> queued, then the gateway: PC online -> leave it for the agent;
/// else cloud budget -> read now (10-60 s, in this request); else it waits.
#[worker::send]
pub async fn submit(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let now = now_ms();
    let result = db::db(env)?
        .prepare(
            "UPDATE slips SET status = 'queued', submitted_at = ?2, updated_at = ?2
             WHERE id = ?1 AND status = 'draft' AND page_count >= 1",
        )
        .bind(&[txt(&id), int(now)])?
        .run()
        .await?;
    if changes(&result)? == 0 {
        let row = must_load(env, &id).await?;
        return Err(ApiError::Conflict(if row.page_count == 0 {
            "add at least one page first".into()
        } else {
            format!("slip is already {}", row.status)
        }));
    }
    let row = must_load(env, &id).await?;
    if !slips::local_online(env).await? {
        cloud::read_if_budget(env, &id, row.page_count).await?;
    }
    Ok(Json(must_load(env, &id).await?.to_json()))
}

#[worker::send]
pub async fn list(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    RawQuery(query): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let shop_id = query_param(&query, "shop_id").unwrap_or_default();
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let env = &state.env;
    let rows = db::db(env)?
        .prepare(format!(
            "SELECT {SLIP_COLS} FROM slips WHERE shop_id = ?1 ORDER BY created_at DESC LIMIT 50"
        ))
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<SlipRow>()?;
    Ok(Json(json!({
        "reader": slips::reader_state(env, &shop_id).await?,
        "slips": rows.iter().map(SlipRow::to_json).collect::<Vec<_>>(),
    })))
}

#[worker::send]
pub async fn get_slip(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    Ok(Json(must_load(&state.env, &id).await?.to_json()))
}

pub(crate) fn jpeg_response(bytes: Vec<u8>) -> Result<Response, ApiError> {
    Response::builder()
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))
        .map_err(|e| ApiError::Internal(format!("response build: {e}")))
}

#[worker::send]
pub async fn get_page(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path((id, page)): Path<(String, i64)>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let page = parse_page(page)?;
    let env = &state.env;
    let row = must_load(env, &id).await?;
    if page > row.page_count {
        return Err(ApiError::NotFound);
    }
    jpeg_response(cloud::load_page(env, &row.shop_id, &id, page).await?)
}

#[worker::send]
pub async fn delete(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let row = must_load(env, &id).await?;
    let result = db::db(env)?
        .prepare("DELETE FROM slips WHERE id = ?1 AND status <> 'reading'")
        .bind(&[txt(&id)])?
        .run()
        .await?;
    if changes(&result)? == 0 {
        return Err(ApiError::Conflict("slip is being read right now, try again shortly".into()));
    }
    for page in 1..=MAX_PAGES {
        crate::routes::owner::media::remove_object(env, &page_key(&row.shop_id, &id, page)).await;
    }
    Ok(StatusCode::NO_CONTENT)
}
