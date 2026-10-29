//! `/owner/staff` — staff users of one shop (schema `users`, role='staff'):
//! list, create with a PIN, reset PIN, revoke. `pin_hash`/`pin_salt` are never
//! selected by these handlers — they must not leave the server.

use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use worker::Env;

use super::{clean_name, int, now_ms, parse_uuid, query_param, txt};
use crate::auth::{crypto, env_str, owner::OwnerAuth};
use crate::extract::ApiJson;
use crate::{db, error::ApiError, AppState};

#[derive(Debug, Serialize, Deserialize)]
pub struct Staff {
    pub id: String,
    pub shop_id: String,
    pub name: String,
    pub status: String,
    pub locked_until: Option<i64>,
    pub created_at: i64,
}


#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateStaffBody {
    pub id: String,
    pub shop_id: String,
    pub name: String,
    pub pin: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetPinBody {
    pub pin: String,
}

#[worker::send]
pub async fn list(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    RawQuery(query): RawQuery,
) -> Result<Json<Vec<Staff>>, ApiError> {
    // Required: staff always belong to exactly one shop (users table CHECK).
    let Some(shop_id) = query_param(&query, "shop_id") else {
        return Err(ApiError::BadRequest(
            "shop_id query parameter is required".into(),
        ));
    };
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();

    let staff = db::db(&state.env)?
        .prepare(
            "SELECT id, shop_id, name, status, locked_until, created_at
             FROM users
             WHERE shop_id = ?1 AND role = 'staff'
             ORDER BY created_at, id",
        )
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<Staff>()?;
    Ok(Json(staff))
}

/// Create a staff user. The PIN never travels back; only salt+hash are stored
/// (users table, crypto module).
#[worker::send]
pub async fn create(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateStaffBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let shop_id = parse_uuid(&body.shop_id, "shop_id")?.to_string();
    let name = clean_name(&body.name)?;
    if !crypto::validate_pin(&body.pin) {
        return Err(ApiError::BadRequest(
            "pin must be 4-6 digits (FEATURES 3.53)".into(),
        ));
    }
    let env = &state.env;

    let shop = db::db(env)?
        .prepare("SELECT id FROM shops WHERE id = ?1")
        .bind(&[txt(&shop_id)])?
        .first::<String>(Some("id"))
        .await?;
    if shop.is_none() {
        return Err(ApiError::NotFound);
    }

    let existing = db::db(env)?
        .prepare("SELECT id FROM users WHERE id = ?1")
        .bind(&[txt(&id)])?
        .first::<String>(Some("id"))
        .await?;
    if existing.is_some() {
        return Err(ApiError::Conflict(format!("user {id} already exists")));
    }

    let (salt, hash) = pin_credentials(env, &body.pin)?;
    let now = now_ms();
    db::db(env)?
        .prepare(
            "INSERT INTO users
               (id, shop_id, name, role, pin_hash, pin_salt,
                failed_pin_attempts, locked_until, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'staff', ?4, ?5, 0, NULL, 'active', ?6, ?6)",
        )
        .bind(&[
            txt(&id),
            txt(&shop_id),
            txt(&name),
            txt(&hash),
            txt(&salt),
            int(now),
        ])?
        .run()
        .await?;

    let staff = Staff {
        id,
        shop_id,
        name,
        status: "active".into(),
        locked_until: None,
        created_at: now,
    };
    Ok((StatusCode::CREATED, Json(staff)).into_response())
}

/// New salt+hash, clear the lockout, and revoke every live session of that
/// user in the SAME batch — an old device must not keep the old PIN alive.
#[worker::send]
pub async fn reset_pin(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ResetPinBody>,
) -> Result<Json<Staff>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    if !crypto::validate_pin(&body.pin) {
        return Err(ApiError::BadRequest(
            "pin must be 4-6 digits (FEATURES 3.53)".into(),
        ));
    }
    let env = &state.env;
    let row = load_staff(env, &id).await?.ok_or(ApiError::NotFound)?;

    let (salt, hash) = pin_credentials(env, &body.pin)?;
    let now = now_ms();
    db::db(env)?
        .batch(vec![
            db::db(env)?
                .prepare(
                    "UPDATE users
                     SET pin_hash = ?1, pin_salt = ?2, failed_pin_attempts = 0,
                         locked_until = NULL, updated_at = ?3
                     WHERE id = ?4",
                )
                .bind(&[txt(&hash), txt(&salt), int(now), txt(&id)])?,
            db::db(env)?
                .prepare(
                    "UPDATE staff_sessions
                     SET revoked_at = ?1
                     WHERE user_id = ?2 AND revoked_at IS NULL",
                )
                .bind(&[int(now), txt(&id)])?,
        ])
        .await?;

    Ok(Json(Staff {
        id: row.id,
        shop_id: row.shop_id,
        name: row.name,
        status: row.status,
        locked_until: None,
        created_at: row.created_at,
    }))
}

/// status='revoked' + revoke live sessions in one batch. Re-revoking is a
/// no-op that still answers 200.
#[worker::send]
pub async fn revoke(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Staff>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let mut row = load_staff(env, &id).await?.ok_or(ApiError::NotFound)?;

    let now = now_ms();
    if row.status != "revoked" {
        db::db(env)?
            .batch(vec![
                db::db(env)?
                    .prepare(
                        "UPDATE users
                         SET status = 'revoked', updated_at = ?1
                         WHERE id = ?2",
                    )
                    .bind(&[int(now), txt(&id)])?,
                db::db(env)?
                    .prepare(
                        "UPDATE staff_sessions
                         SET revoked_at = ?1
                         WHERE user_id = ?2 AND revoked_at IS NULL",
                    )
                    .bind(&[int(now), txt(&id)])?,
            ])
            .await?;
        row.status = "revoked".into();
    }

    Ok(Json(row))
}

/// Fresh salt+hash for `pin`. An empty `PIN_PEPPER` is a deployment error
/// (500), not a client error.
fn pin_credentials(env: &Env, pin: &str) -> Result<(String, String), ApiError> {
    let pepper = env_str(env, "PIN_PEPPER");
    if pepper.is_empty() {
        return Err(ApiError::Internal("PIN_PEPPER not set".into()));
    }
    let salt = crypto::new_salt_hex();
    let hash = crypto::hash_pin(pepper.as_bytes(), &salt, pin)
        .ok_or_else(|| ApiError::Internal("pin hashing failed".into()))?;
    Ok((salt, hash))
}

async fn load_staff(env: &Env, id: &str) -> Result<Option<Staff>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT id, shop_id, name, status, locked_until, created_at
             FROM users
             WHERE id = ?1 AND role = 'staff'",
        )
        .bind(&[txt(id)])?
        .first::<Staff>(None)
        .await?)
}
