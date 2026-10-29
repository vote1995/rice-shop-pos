//! `GET|POST /owner/shops` — the shops an owner manages (multi-shop: FEATURES 3.64).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::util::{clean_name, int, now_ms, parse_uuid, txt};
use crate::auth::owner::OwnerAuth;
use crate::extract::ApiJson;
use crate::{db, error::ApiError, AppState};

#[derive(Debug, Serialize, Deserialize)]
pub struct Shop {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateShopBody {
    pub id: String,
    pub name: String,
}

#[worker::send]
pub async fn list(
    State(state): State<AppState>,
    _owner: OwnerAuth,
) -> Result<Json<Vec<Shop>>, ApiError> {
    let shops = db::db(&state.env)?
        .prepare("SELECT id, name, created_at FROM shops ORDER BY created_at, id")
        .all()
        .await?
        .results::<Shop>()?;
    Ok(Json(shops))
}

/// Create with a client-generated id. Idempotent (offline retries, 3.70):
/// same id + same name replays as `200` with the same body; same id with a
/// different name is a `409`.
#[worker::send]
pub async fn create(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateShopBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let name = clean_name(&body.name)?;
    let now = now_ms();

    let existing = db::db(&state.env)?
        .prepare("SELECT id, name, created_at FROM shops WHERE id = ?1")
        .bind(&[txt(&id)])?
        .first::<Shop>(None)
        .await?;
    if let Some(shop) = existing {
        return if shop.name == name {
            Ok(Json(shop).into_response())
        } else {
            Err(ApiError::Conflict(format!(
                "shop {id} already exists with a different name"
            )))
        };
    }

    let shop = Shop {
        id: id.clone(),
        name: name.clone(),
        created_at: now,
    };
    db::db(&state.env)?
        .prepare(
            "INSERT INTO shops (id, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)",
        )
        .bind(&[txt(&id), txt(&name), int(now)])?
        .run()
        .await?;
    Ok((StatusCode::CREATED, Json(shop)).into_response())
}
