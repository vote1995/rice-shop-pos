//! PromptPay QR through Beam (3.24, 3.82, 3.84).
//!
//! - `POST /orders/{id}/promptpay` `{payment_id}` (staff): records a
//!   'pending' promptpay payment for the bill's SERVER total and creates the
//!   Beam charge (idempotency key = payment id, so a retry after a network
//!   error never makes a second charge). Returns the QR payload to show.
//! - `GET /orders/{id}/promptpay/{payment_id}` (staff): the pay sheet polls
//!   this. A pending charge is checked with Beam itself, so the bill closes
//!   even when the webhook is late (or cannot reach a local dev server).
//! - `POST /beam/webhook` (Beam, no session): `X-Beam-Signature` checked over
//!   the raw body; `charge.succeeded` closes the bill.
//!
//! A bill is closed only by Beam saying SUCCEEDED for exactly the amount we
//! charged — never by a staff button. Beam being unreachable is undecidable:
//! the payment stays 'pending', nothing is marked failed.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use worker::Env;

use crate::auth::staff::StaffAuth;
use crate::beam::{self, BeamError};
use crate::extract::ApiJson;
use crate::routes::orders::{changes, load_order, transition_refused, OrderJson};
use crate::util::{int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

#[derive(Debug, Deserialize)]
pub struct PromptpayBody {
    /// Client UUID: the payment id, Beam reference id and idempotency key.
    pub payment_id: String,
}

#[derive(Debug, Deserialize)]
struct QrRow {
    id: String,
    order_id: String,
    shop_id: String,
    method: String,
    amount: i64,
    status: String,
    beam_charge_id: Option<String>,
    beam_qr_raw: Option<String>,
    beam_qr_expiry: Option<String>,
}

const QR_COLUMNS: &str =
    "id, order_id, shop_id, method, amount, status, beam_charge_id, beam_qr_raw, beam_qr_expiry";

#[derive(Debug, Serialize)]
pub struct QrPaymentJson {
    pub id: String,
    pub amount: i64,
    /// pending | succeeded | expired
    pub status: String,
    pub qr_raw: Option<String>,
    pub qr_expiry: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct QrJson {
    pub order: OrderJson,
    pub payment: QrPaymentJson,
}

fn qr_json(order: OrderJson, p: QrRow) -> QrJson {
    QrJson {
        order,
        payment: QrPaymentJson {
            id: p.id,
            amount: p.amount,
            status: p.status,
            qr_raw: p.beam_qr_raw,
            qr_expiry: p.beam_qr_expiry,
        },
    }
}

async fn load_qr(env: &Env, payment_id: &str) -> Result<Option<QrRow>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!("SELECT {QR_COLUMNS} FROM payments WHERE id = ?1"))
        .bind(&[txt(payment_id)])?
        .first::<QrRow>(None)
        .await?)
}

async fn load_qr_by_charge(env: &Env, charge_id: &str) -> Result<Option<QrRow>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!(
            "SELECT {QR_COLUMNS} FROM payments WHERE beam_charge_id = ?1"
        ))
        .bind(&[txt(charge_id)])?
        .first::<QrRow>(None)
        .await?)
}

fn beam_to_api(e: BeamError) -> ApiError {
    match e {
        BeamError::Unavailable(d) => ApiError::Unavailable(format!("beam: {d}")),
        BeamError::Config(d) => ApiError::Internal(format!("beam config: {d}")),
        BeamError::Rejected(d) => {
            worker::console_error!("beam rejected: {d}");
            ApiError::coded(
                StatusCode::BAD_GATEWAY,
                "beam_rejected",
                "Beam ปฏิเสธการสร้าง QR — รับเงินสดแทน หรือแจ้งเจ้าของร้าน",
            )
        }
    }
}

/// Marks a promptpay payment succeeded (Beam confirmed `beam_amount` satang)
/// and closes its bill — one batch, idempotent. The payment is only marked
/// when Beam's amount equals what we charged; the bill only closes while it
/// is still open at that same total. Returns whether the payment is now
/// succeeded.
async fn settle(env: &Env, payment_id: &str, beam_amount: Option<i64>) -> Result<bool, ApiError> {
    let Some(p) = load_qr(env, payment_id).await? else {
        return Ok(false);
    };
    if p.status == "succeeded" {
        return Ok(true);
    }
    if beam_amount != Some(p.amount) {
        worker::console_error!(
            "beam amount mismatch for payment {payment_id}: beam {beam_amount:?}, ours {}",
            p.amount
        );
        return Ok(false);
    }
    let now = now_ms();
    let d = db::db(env)?;
    let results = d
        .batch(vec![
            // 'expired' too: the QR timed out on our side but the money is real.
            d.prepare(
                "UPDATE payments SET status = 'succeeded', confirmed_by = 'webhook',
                        confirmed_at = ?2, updated_at = ?2
                 WHERE id = ?1 AND method = 'promptpay' AND status IN ('pending', 'expired')",
            )
            .bind(&[txt(payment_id), int(now)])?,
            d.prepare(
                "UPDATE orders SET status = 'paid', paid_at = ?3, closed_at = ?3, updated_at = ?3
                 WHERE id = ?2 AND status IN ('preparing', 'served') AND total_amount = ?4
                   AND EXISTS (SELECT 1 FROM payments WHERE id = ?1 AND status = 'succeeded')",
            )
            .bind(&[txt(payment_id), txt(&p.order_id), int(now), int(p.amount)])?,
        ])
        .await?;
    if results.last().map(changes).transpose()?.unwrap_or(0) == 0 {
        // Paid twice (e.g. cash after the QR) or the bill changed: the money
        // is recorded on the payment; the owner sorts it out (refund in Beam).
        worker::console_warn!(
            "beam payment {payment_id} succeeded but bill {} did not close",
            p.order_id
        );
    }
    Ok(true)
}

/// Asks Beam about a pending charge and applies the answer. Undecidable
/// (Beam unreachable) leaves everything as it is.
async fn refresh(env: &Env, p: &QrRow) -> Result<(), ApiError> {
    let Some(charge_id) = p.beam_charge_id.as_deref() else {
        return Ok(());
    };
    if p.status != "pending" {
        return Ok(());
    }
    match beam::get_charge(env, charge_id).await {
        Ok(c) if c.status == "SUCCEEDED" => {
            if c.currency.as_deref() == Some("THB") {
                settle(env, &p.id, c.amount).await?;
            }
        }
        Ok(c) if c.status == "FAILED" => {
            db::db(env)?
                .prepare(
                    "UPDATE payments SET status = 'expired', updated_at = ?2
                     WHERE id = ?1 AND status = 'pending'",
                )
                .bind(&[txt(&p.id), int(now_ms())])?
                .run()
                .await?;
        }
        Ok(_) => {}
        Err(BeamError::Unavailable(d)) => worker::console_warn!("beam status check: {d}"),
        Err(e) => worker::console_error!("beam status check: {e:?}"),
    }
    Ok(())
}

/// `POST /orders/{id}/promptpay`
#[worker::send]
pub async fn create(
    State(state): State<AppState>,
    staff: StaffAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PromptpayBody>,
) -> Result<Json<QrJson>, ApiError> {
    let order_id = parse_uuid(&id, "id")?.to_string();
    let payment_id = parse_uuid(&body.payment_id, "payment_id")?.to_string();
    let shop_id = staff.shop_id;
    let env = &state.env;

    let order = load_order(env, &shop_id, &order_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let existing = load_qr(env, &payment_id).await?;
    if let Some(p) = &existing {
        if p.order_id != order_id || p.shop_id != shop_id || p.method != "promptpay" {
            return Err(ApiError::Conflict(format!(
                "payment {payment_id} belongs to another order"
            )));
        }
    } else {
        if order.channel != "counter" {
            return Err(ApiError::BadRequest(
                "PromptPay QR is for counter bills".into(),
            ));
        }
        if !matches!(order.status.as_str(), "preparing" | "served") {
            return Err(ApiError::Conflict(format!("order is {}", order.status)));
        }
        if order.total_amount <= 0 {
            return Err(ApiError::BadRequest(
                "nothing to pay: use cash for a 0 bill".into(),
            ));
        }
        let now = now_ms();
        let r = db::db(env)?
            .prepare(
                "INSERT INTO payments
                   (id, shop_id, order_id, method, amount, beam_reference_id,
                    status, created_by, created_at, updated_at)
                 SELECT ?1, ?3, ?2, 'promptpay', total_amount, ?1,
                        'pending', ?4, ?5, ?5
                 FROM orders
                 WHERE id = ?2 AND shop_id = ?3 AND status IN ('preparing', 'served')
                   AND channel = 'counter' AND total_amount = ?6",
            )
            .bind(&[
                txt(&payment_id),
                txt(&order_id),
                txt(&shop_id),
                txt(&staff.user_id),
                int(now),
                int(order.total_amount),
            ])?
            .run()
            .await?;
        if changes(&r)? == 0 {
            return Err(transition_refused(env, &shop_id, &order_id).await);
        }
    }

    let p = load_qr(env, &payment_id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("payment {payment_id} vanished")))?;

    if p.status == "pending" && p.beam_charge_id.is_none() {
        // First attempt, or a retry after an undecidable failure: the same
        // idempotency key returns the same charge.
        match beam::create_qr_charge(env, p.amount, &payment_id).await {
            Ok(qr) => {
                db::db(env)?
                    .prepare(
                        "UPDATE payments SET beam_charge_id = ?2, beam_qr_raw = ?3,
                                beam_qr_expiry = ?4, updated_at = ?5
                         WHERE id = ?1 AND beam_charge_id IS NULL",
                    )
                    .bind(&[
                        txt(&payment_id),
                        txt(&qr.charge_id),
                        txt(&qr.qr_raw),
                        qr.expiry
                            .as_deref()
                            .map(txt)
                            .unwrap_or(wasm_bindgen::JsValue::NULL),
                        int(now_ms()),
                    ])?
                    .run()
                    .await?;
            }
            Err(BeamError::Rejected(d)) => {
                db::db(env)?
                    .prepare(
                        "UPDATE payments SET status = 'expired', updated_at = ?2
                         WHERE id = ?1 AND status = 'pending' AND beam_charge_id IS NULL",
                    )
                    .bind(&[txt(&payment_id), int(now_ms())])?
                    .run()
                    .await?;
                return Err(beam_to_api(BeamError::Rejected(d)));
            }
            Err(e) => return Err(beam_to_api(e)),
        }
    }

    let p = load_qr(env, &payment_id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("payment {payment_id} vanished")))?;
    let order = load_order(env, &shop_id, &order_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(qr_json(order, p)))
}

/// `GET /orders/{id}/promptpay/{payment_id}`
#[worker::send]
pub async fn status(
    State(state): State<AppState>,
    staff: StaffAuth,
    Path((id, pid)): Path<(String, String)>,
) -> Result<Json<QrJson>, ApiError> {
    let order_id = parse_uuid(&id, "id")?.to_string();
    let payment_id = parse_uuid(&pid, "payment_id")?.to_string();
    let env = &state.env;

    let p = load_qr(env, &payment_id).await?.ok_or(ApiError::NotFound)?;
    if p.order_id != order_id || p.shop_id != staff.shop_id || p.method != "promptpay" {
        return Err(ApiError::NotFound);
    }
    refresh(env, &p).await?;

    let p = load_qr(env, &payment_id).await?.ok_or(ApiError::NotFound)?;
    let order = load_order(env, &staff.shop_id, &order_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(qr_json(order, p)))
}

/// `POST /beam/webhook` — Beam's charge events. 401 on a bad signature; 200
/// for every authenticated event (also ones we do not track) so Beam stops
/// retrying; 5xx only when our side failed and a retry can help.
#[worker::send]
pub async fn webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let env = &state.env;
    let key = beam::webhook_key(env).map_err(beam_to_api)?;
    let sig = headers
        .get("x-beam-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !beam::verify_signature(&key, &body, sig) {
        worker::console_warn!("beam webhook: bad signature");
        return Err(ApiError::Unauthorized);
    }
    let event = headers
        .get("x-beam-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let charge: beam::Charge = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(e) => {
            worker::console_warn!("beam webhook {event}: unparsable body: {e}");
            return Ok(StatusCode::OK);
        }
    };
    let ours = beam::merchant_id(env).map_err(beam_to_api)?;
    if charge
        .merchant_id
        .as_deref()
        .is_some_and(|m| m != ours.trim())
    {
        worker::console_warn!("beam webhook: other merchant");
        return Ok(StatusCode::OK);
    }
    let Some(p) = load_qr_by_charge(env, &charge.charge_id).await? else {
        worker::console_warn!(
            "beam webhook {event}: unknown charge {} (ref {:?})",
            charge.charge_id,
            charge.reference_id
        );
        return Ok(StatusCode::OK);
    };
    match charge.status.as_str() {
        "SUCCEEDED" if charge.currency.as_deref() == Some("THB") => {
            settle(env, &p.id, charge.amount).await?;
        }
        "FAILED" => {
            db::db(env)?
                .prepare(
                    "UPDATE payments SET status = 'expired', updated_at = ?2
                     WHERE id = ?1 AND status = 'pending'",
                )
                .bind(&[txt(&p.id), int(now_ms())])?
                .run()
                .await?;
        }
        other => worker::console_log!(
            "beam webhook {event}: charge {} is {other}",
            charge.charge_id
        ),
    }
    Ok(StatusCode::OK)
}

/// Look-back cap of `GET /payments/recent`: a counter that was asleep does
/// not replay an hour of "ได้รับเงิน" when it wakes up.
const RECENT_WINDOW_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Deserialize, Serialize)]
pub struct RecentPayment {
    pub id: String,
    pub amount: i64,
    pub queue_number: i64,
    pub confirmed_at: i64,
}

#[derive(Debug, Serialize)]
pub struct RecentJson {
    pub payments: Vec<RecentPayment>,
    /// Next `since`.
    pub cursor: i64,
}

/// `GET /payments/recent?since=ms` (staff): PromptPay payments of this shop
/// that Beam confirmed after `since` — what the counter's "เงินเข้า"
/// announcement speaks. Read-only; confirming stays with the webhook and the
/// pay sheet's status check.
#[worker::send]
pub async fn recent(
    State(state): State<AppState>,
    staff: StaffAuth,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
) -> Result<Json<RecentJson>, ApiError> {
    let now = now_ms();
    // `since`: confirmed_at of the last payment already announced; absent =
    // first call, nothing returned, only the cursor to start from.
    let since = query
        .as_deref()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("since=")))
        .map(|v| v.parse::<i64>().map_err(|_| ApiError::BadRequest("since must be ms".into())))
        .transpose()?;
    let Some(since) = since else {
        return Ok(Json(RecentJson { payments: vec![], cursor: now }));
    };
    let from = since.max(now - RECENT_WINDOW_MS);
    let payments = db::db(&state.env)?
        .prepare(
            "SELECT p.id, p.amount, o.queue_number, p.confirmed_at
             FROM payments p JOIN orders o ON o.id = p.order_id
             WHERE p.shop_id = ?1 AND p.method = 'promptpay'
               AND p.status IN ('succeeded', 'refunded') AND p.confirmed_at > ?2
             ORDER BY p.confirmed_at, p.id
             LIMIT 20",
        )
        .bind(&[txt(&staff.shop_id), int(from)])?
        .all()
        .await?
        .results::<RecentPayment>()?;
    let cursor = payments.last().map(|p| p.confirmed_at).unwrap_or(since.max(from));
    Ok(Json(RecentJson { payments, cursor }))
}
