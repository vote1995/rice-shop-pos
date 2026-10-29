//! `/auth/pin`, `/auth/logout`, `/staff/me` - staff login on a device.
//!
//! Lockout (FEATURES 3.54): 5 attempts lock the account for 5 minutes. Every
//! attempt is RESERVED by one atomic `UPDATE ... WHERE not locked RETURNING`
//! *before* the PIN is checked; a correct PIN then resets the counter. If the
//! check came first, a burst of parallel requests would all pass the "is it
//! locked?" read before any of them counted, i.e. unlimited guesses per burst.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;
use worker::Env;

use crate::auth::{crypto, device::DeviceAuth, env_str, staff::StaffAuth};
use crate::extract::ApiJson;
use crate::util::{int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

/// Wrong PINs before the account locks (FEATURES 3.54).
pub const MAX_PIN_ATTEMPTS: i64 = 5;
/// Lockout duration.
pub const PIN_LOCK_MS: i64 = 5 * 60 * 1000;
/// Session lifetime: 12 h, i.e. "today's shift", re-issued on each login.
pub const SESSION_TTL_MS: i64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinBody {
    pub user_id: String,
    pub pin: String,
}

/// Outcome of one wrong PIN. Mirrors the CASE arms of the atomic UPDATE below
/// (kept as a pure fn so the decision is unit-testable on the host).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FailedPin {
    /// The account just locked: no new attempt before this instant (unix ms).
    Locked(i64),
    /// Still unlocked; wrong PINs left before the next failure locks it.
    AttemptsLeft(i64),
}

#[allow(dead_code)] // unit-tested on the host (wasm builds do not compile tests)
pub(crate) fn failed_pin_outcome(attempts_before: i64, now: i64) -> FailedPin {
    let after = attempts_before + 1;
    if after >= MAX_PIN_ATTEMPTS {
        FailedPin::Locked(now + PIN_LOCK_MS)
    } else {
        FailedPin::AttemptsLeft(MAX_PIN_ATTEMPTS - after)
    }
}

/// Whole seconds left in a lockout, rounded up, never negative.
pub(crate) fn lock_seconds_left(locked_until: i64, now: i64) -> i64 {
    ((locked_until - now).max(0) + 999) / 1000
}

/// PIN login. Only from an approved device, only for an active staff user of
/// that device's shop; a wrong or malformed PIN always counts as a guess.
#[worker::send]
pub async fn pin(
    State(state): State<AppState>,
    device: DeviceAuth,
    ApiJson(body): ApiJson<PinBody>,
) -> Result<Response, ApiError> {
    let shop_id = device.require_approved()?;
    let user_id = parse_uuid(&body.user_id, "user_id")?.to_string();
    let env = &state.env;

    let pepper = env_str(env, "PIN_PEPPER");
    if pepper.is_empty() {
        return Err(ApiError::Internal("PIN_PEPPER not set".into()));
    }

    #[derive(Deserialize)]
    struct UserRow {
        name: String,
        pin_hash: String,
        pin_salt: String,
        locked_until: Option<i64>,
    }
    let user = db::db(env)?
        .prepare(
            "SELECT name, pin_hash, pin_salt, locked_until
             FROM users
             WHERE id = ?1 AND shop_id = ?2 AND role = 'staff' AND status = 'active'",
        )
        .bind(&[txt(&user_id), txt(&shop_id)])?
        .first::<UserRow>(None)
        .await?;
    // Unknown/inactive/other-shop user: 401 without counting an attempt -
    // there is no row to count it on, and it must not leak who exists.
    let Some(user) = user else {
        return Err(ApiError::coded(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "unknown user for this shop",
        ));
    };

    let now = now_ms();
    let Some(attempt) = reserve_attempt(env, &user_id, now).await? else {
        // Locked: nothing reserved, the PIN is never even looked at.
        let locked_until = user.locked_until.filter(|u| *u > now).unwrap_or(now + PIN_LOCK_MS);
        return Ok(locked_response(locked_until, now));
    };

    // Malformed input (e.g. "12a4") counts as a wrong attempt, not a 400:
    // only the shape is invalid, the guess itself was still wrong.
    let correct = crypto::validate_pin(&body.pin)
        && crypto::verify_pin(pepper.as_bytes(), &user.pin_salt, &body.pin, &user.pin_hash);
    if !correct {
        // This reservation may itself have been the one that locked.
        if let Some(locked_until) = attempt.locked_until.filter(|u| *u > now) {
            return Ok(locked_response(locked_until, now));
        }
        let attempts_left = MAX_PIN_ATTEMPTS - attempt.failed_pin_attempts;
        return Err(ApiError::coded(
            StatusCode::UNAUTHORIZED,
            "invalid_pin",
            format!("wrong pin, {attempts_left} attempts left"),
        ));
    }

    // Correct: clear the lockout and open the session in ONE batch, so a
    // failure in between cannot leave a locked-but-valid state behind.
    let (session_token, token_hash) = crypto::new_token();
    let session_id = Uuid::new_v4().to_string();
    let expires_at = now + SESSION_TTL_MS;
    db::db(env)?
        .batch(vec![
            db::db(env)?
                .prepare(
                    "UPDATE users
                     SET failed_pin_attempts = 0, locked_until = NULL, updated_at = ?1
                     WHERE id = ?2",
                )
                .bind(&[int(now), txt(&user_id)])?,
            db::db(env)?
                .prepare(
                    "INSERT INTO staff_sessions
                       (id, token_hash, user_id, shop_id, device_id, created_at, expires_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .bind(&[
                    txt(&session_id),
                    txt(&token_hash),
                    txt(&user_id),
                    txt(&shop_id),
                    txt(&device.device_id),
                    int(now),
                    int(expires_at),
                ])?,
        ])
        .await?;

    Ok(Json(json!({
        "session_token": session_token,
        "expires_at": expires_at,
        "user": { "id": user_id, "name": user.name },
    }))
    .into_response())
}

#[derive(Deserialize)]
struct Attempt {
    failed_pin_attempts: i64,
    locked_until: Option<i64>,
}

/// Counts one attempt atomically, only if the account is not locked right
/// now. `None` = locked (nothing counted). The 5th reservation sets the lock
/// and resets the counter in the same statement (see `failed_pin_outcome`).
async fn reserve_attempt(env: &Env, user_id: &str, now: i64) -> Result<Option<Attempt>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "UPDATE users
             SET failed_pin_attempts = CASE WHEN failed_pin_attempts + 1 >= ?1
                                        THEN 0 ELSE failed_pin_attempts + 1 END,
                 locked_until = CASE WHEN failed_pin_attempts + 1 >= ?1
                              THEN ?2 ELSE NULL END,
                 updated_at = ?3
             WHERE id = ?4 AND (locked_until IS NULL OR locked_until <= ?3)
             RETURNING failed_pin_attempts, locked_until",
        )
        .bind(&[
            int(MAX_PIN_ATTEMPTS),
            int(now + PIN_LOCK_MS),
            int(now),
            txt(user_id),
        ])?
        .first::<Attempt>(None)
        .await?)
}

/// 423 with the standard error shape plus `locked_until`, so the client can
/// run its own countdown. The one error with an extra field, hence a
/// hand-rolled body instead of `ApiError::Coded`.
fn locked_response(locked_until: i64, now: i64) -> Response {
    (
        StatusCode::LOCKED,
        Json(json!({
            "error": "pin_locked",
            "message": format!(
                "too many wrong pins; try again in {}s",
                lock_seconds_left(locked_until, now)
            ),
            "locked_until": locked_until,
        })),
    )
        .into_response()
}

#[worker::send]
pub async fn logout(
    State(state): State<AppState>,
    staff: StaffAuth,
) -> Result<Json<Value>, ApiError> {
    db::db(&state.env)?
        .prepare("UPDATE staff_sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
        .bind(&[int(now_ms()), txt(&staff.session_id)])?
        .run()
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[worker::send]
pub async fn me(
    State(state): State<AppState>,
    staff: StaffAuth,
) -> Result<Json<Value>, ApiError> {
    let name = db::db(&state.env)?
        .prepare("SELECT name FROM users WHERE id = ?1")
        .bind(&[txt(&staff.user_id)])?
        .first::<String>(Some("name"))
        .await?
        .ok_or_else(|| ApiError::Internal(format!("session user {} vanished", staff.user_id)))?;
    Ok(Json(json!({
        "user_id": staff.user_id,
        "name": name,
        "shop_id": staff.shop_id,
        "device_id": staff.device_id,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockout_kicks_in_on_the_nth_wrong_pin() {
        let now = 1_000_000;
        // Guesses 1..4 leave a countdown, none lock yet.
        assert_eq!(failed_pin_outcome(0, now), FailedPin::AttemptsLeft(4));
        assert_eq!(failed_pin_outcome(3, now), FailedPin::AttemptsLeft(1));
        // The 5th locks for exactly PIN_LOCK_MS and resets the counter to 0.
        assert_eq!(failed_pin_outcome(4, now), FailedPin::Locked(now + PIN_LOCK_MS));
        // After an expired lock the counter restarts at 1, not at 5.
        assert_eq!(
            failed_pin_outcome(0, now + PIN_LOCK_MS),
            FailedPin::AttemptsLeft(4)
        );
    }

    #[test]
    fn lock_seconds_round_up_and_clamp_at_zero() {
        assert_eq!(lock_seconds_left(1_000_500, 1_000_000), 1);
        assert_eq!(lock_seconds_left(1_005_000, 1_000_000), 5);
        assert_eq!(lock_seconds_left(1_000_000, 1_000_000), 0);
        assert_eq!(lock_seconds_left(999_000, 1_000_000), 0);
    }
}
