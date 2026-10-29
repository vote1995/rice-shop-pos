//! `/device/*` - public device lifecycle endpoints. No owner auth here: a
//! brand-new device has no credentials yet (3.52/3.55); its token IS the
//! credential after registration. `POST /device/register` is the only place a
//! device token is ever minted, and a re-register of the same id is a 409 so a
//! lost token can never be silently replaced. `GET /device/status` answers for
//! EVERY status including revoked - that is the client's signal to wipe local
//! data (3.56).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::auth::{crypto, device::DeviceAuth};
use crate::extract::ApiJson;
use crate::util::{clean_name, int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterBody {
    pub id: String,
    pub name: String,
    pub model: Option<String>,
}

/// Install-time registration. 201 hands the token out exactly once; only its
/// hash is stored. Status starts `pending`: the owner picks the shop at
/// approval time (`/owner/devices/{id}/approve`), so `shop_id` stays NULL here.
#[worker::send]
pub async fn register(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<RegisterBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let name = clean_name(&body.name)?;
    let model = match body.model.as_deref().map(str::trim) {
        Some(model) if !model.is_empty() => {
            if model.chars().count() > 200 {
                return Err(ApiError::BadRequest(
                    "model must be at most 200 characters".into(),
                ));
            }
            Some(model.to_owned())
        }
        _ => None,
    };

    let env = &state.env;
    let existing = db::db(env)?
        .prepare("SELECT id FROM devices WHERE id = ?1")
        .bind(&[txt(&id)])?
        .first::<String>(Some("id"))
        .await?;
    if existing.is_some() {
        return Err(ApiError::Conflict(format!(
            "device {id} already registered; device tokens are never re-issued"
        )));
    }

    let (token, token_hash) = crypto::new_token();
    let now = now_ms();
    db::db(env)?
        .prepare(
            "INSERT INTO devices
               (id, shop_id, name, model, device_token_hash, status,
                registered_at, created_at, updated_at)
             VALUES (?1, NULL, ?2, ?3, ?4, 'pending', ?5, ?5, ?5)",
        )
        .bind(&[
            txt(&id),
            txt(&name),
            model.as_deref().map(txt).unwrap_or(JsValue::NULL),
            txt(&token_hash),
            int(now),
        ])?
        .run()
        .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "device_id": id,
            "device_token": token,
            "status": "pending",
        })),
    )
        .into_response())
}

/// Device bootstrap poll: answers for every status (see module doc). `shop_id`
/// / `shop_name` are null while pending or when revoked before approval.
#[worker::send]
pub async fn status(
    State(state): State<AppState>,
    device: DeviceAuth,
) -> Result<Json<Value>, ApiError> {
    #[derive(Deserialize)]
    struct Row {
        status: String,
        shop_id: Option<String>,
        shop_name: Option<String>,
    }
    let row = db::db(&state.env)?
        .prepare(
            "SELECT d.status AS status, d.shop_id AS shop_id, s.name AS shop_name
             FROM devices d LEFT JOIN shops s ON s.id = d.shop_id
             WHERE d.id = ?1",
        )
        .bind(&[txt(&device.device_id)])?
        .first::<Row>(None)
        .await?
        .ok_or_else(|| {
            ApiError::Internal(format!(
                "device {} vanished between auth and status query",
                device.device_id
            ))
        })?;
    Ok(Json(json!({
        "device_id": device.device_id,
        "status": row.status,
        "shop_id": row.shop_id,
        "shop_name": row.shop_name,
    })))
}

/// The PIN-login staff picker: active staff of this device's shop only. The
/// device must be approved (a pending device must not learn the roster).
#[worker::send]
pub async fn staff(
    State(state): State<AppState>,
    device: DeviceAuth,
) -> Result<Json<Vec<StaffPick>>, ApiError> {
    let shop_id = device.require_approved()?;
    let staff = db::db(&state.env)?
        .prepare(
            "SELECT id, name, locked_until
             FROM users
             WHERE shop_id = ?1 AND role = 'staff' AND status = 'active'
             ORDER BY name",
        )
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<StaffPick>()?;
    Ok(Json(staff))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StaffPick {
    pub id: String,
    pub name: String,
    pub locked_until: Option<i64>,
}
