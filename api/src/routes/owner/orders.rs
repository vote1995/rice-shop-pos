//! `/owner/...` bills and refunds (ROADMAP M1-4a; FEATURES 3.28, 3.47, 3.60).
//!
//! Endpoints (all [`OwnerAuth`]; owners have users.shop_id NULL and see every
//! shop - schema 0001 - so the day view scopes by the shop_id path segment
//! and the cancel/payment endpoints by the id in the path):
//! - `GET  /owner/shops/{shop_id}/orders?day=YYYY-MM-DD`  the bills of one
//!   Bangkok (UTC+7) calendar day, newest first, at most 500, each with its
//!   lines and its payments (no `day` = today)
//! - `POST /owner/orders/{id}/cancel`                     void an unpaid bill;
//!   `cancelled_by` is the owner's own user id (3.15, 3.47)
//! - `POST /owner/payments/{id}/refund`                   mark a succeeded
//!   payment refunded - whole or in part, always with a reason (3.28)
//!
//! Reused from `crate::routes::orders` (made `pub(crate)` there, never
//! copied): `load_order` (an owner sees exactly the bill JSON the POS sees),
//! the Bangkok day math, the 1..=200 reason cleaner (a refund reason carries
//! the same bound as a cancel reason), the D1 change counter and the
//! 404/409 transition explainer.
//!
//! Nothing here rewrites the money columns of the append-only order tables
//! (schema 0001: only the server's state machine may); the one discount that
//! remains is the system-set staff-meal one written on orders.discount_amount
//! at order creation in `routes::orders`, which the day view just reports.
//! Refunds (3.28) never touch the order row either: it stays 'paid' and the
//! reports subtract `refund_amount`.

use std::collections::HashMap;

use axum::{
    extract::{Path, RawQuery, State},
    Json,
};
use serde::{Deserialize, Serialize};
use worker::Env;

use super::query_param;
use crate::auth::owner::OwnerAuth;
use crate::extract::ApiJson;
use crate::routes::orders::{
    bangkok_day_start_ms, cancel_with_restock, changes, clean_cancel_reason, load_order,
    transition_refused,
    OrderItemJson, OrderJson, OptionSnapshot,
};
use crate::util::{int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

/// One UTC day in ms. The Bangkok sale day is a fixed UTC+7 slice of it.
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// 12:00 UTC of a calendar date always falls inside that date's Bangkok day
/// (which starts at 17:00 UTC the day before), so the day parser lands noon
/// UTC and lets the shared day math do the offset.
const NOON_MS: i64 = 12 * 60 * 60 * 1000;
/// Day view page: the newest bills of one sale day. One day of one shop
/// cannot reach this, but the query is bounded anyway (and the items /
/// payments subqueries may then read a few rows more than needed).
const MAX_DAY_ORDERS: i64 = 500;

/// Column lists mirror `routes::orders` one-to-one (the same JSON structs are
/// built from them); local consts keep that module's SQL untouched.
/// `order_id` rides along on items and payments only to group them under
/// their bill. The member columns of migration 0011 and the member's name
/// come as scalar subqueries on `orders.customer_id` — the same trick as
/// `routes::orders::ORDER_COLUMNS`, so the day view needs no JOIN and its row
/// count cannot change.
const ORDER_COLUMNS: &str = "id, queue_number, order_type, channel, table_no, note, status, \
     total_amount, discount_amount, created_by, created_at, paid_at, cancelled_at, cancel_reason, \
     served_at, staff_meal, customer_id, points_redeemed, points_earned, \
     (SELECT c.nickname FROM customers c WHERE c.id = orders.customer_id) \
       AS member_name, \
     (SELECT c.points FROM customers c WHERE c.id = orders.customer_id) AS member_points";
const ITEM_COLUMNS: &str = "id, order_id, menu_item_id, item_name, options_json, quantity, \
     note, unit_price, discount_amount, line_total";
const PAYMENT_COLUMNS: &str = "id, order_id, method, amount, cash_received, cash_change, \
     status, refund_amount, refund_reason, refunded_at, created_at";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/// `POST /owner/orders/{id}/cancel` body: a reason is mandatory (3.15).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelBody {
    reason: String,
}

/// `POST /owner/payments/{id}/refund` body (3.28): the reason is mandatory,
/// `amount` null = the whole payment.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefundBody {
    reason: String,
    amount: Option<i64>,
}

/// One payments row as the owner API reports it - with the refund fields the
/// staff pay endpoint never reads (3.28).
#[derive(Debug, Serialize)]
pub struct PaymentJson {
    id: String,
    method: String,
    amount: i64,
    cash_received: Option<i64>,
    cash_change: Option<i64>,
    status: String,
    refund_amount: Option<i64>,
    refund_reason: Option<String>,
    refunded_at: Option<i64>,
    created_at: i64,
}

/// One bill of the day view: exactly the order JSON the POS sees, flattened,
/// plus the payments that closed it (a paid bill has one, a refunded one
/// still shows it as refunded).
#[derive(Debug, Serialize)]
pub struct DayOrderJson {
    #[serde(flatten)]
    order: OrderJson,
    payments: Vec<PaymentJson>,
}

/// `GET /owner/shops/{shop_id}/orders` payload.
#[derive(Debug, Serialize)]
pub struct DayOrdersJson {
    orders: Vec<DayOrderJson>,
}

/// One orders row of the day window: exactly the fields [`OrderJson`] needs.
#[derive(Debug, Deserialize)]
struct OrderRow {
    id: String,
    queue_number: i64,
    order_type: String,
    channel: String,
    table_no: Option<String>,
    note: Option<String>,
    status: String,
    total_amount: i64,
    discount_amount: i64,
    created_by: String,
    created_at: i64,
    paid_at: Option<i64>,
    cancelled_at: Option<i64>,
    cancel_reason: Option<String>,
    served_at: Option<i64>,
    staff_meal: i64,
    /// The member columns of migration 0011; the member's name and CURRENT
    /// balance arrive as the two scalar subqueries of [`ORDER_COLUMNS`].
    customer_id: Option<String>,
    points_redeemed: i64,
    points_earned: i64,
    member_name: Option<String>,
    member_points: Option<i64>,
}

/// One order_items row of the day window.
#[derive(Debug, Deserialize)]
struct ItemRow {
    id: String,
    order_id: String,
    menu_item_id: String,
    item_name: String,
    options_json: String,
    quantity: i64,
    note: Option<String>,
    unit_price: i64,
    discount_amount: i64,
    line_total: i64,
}

/// One payments row of the day window / the refund path.
#[derive(Debug, Deserialize)]
struct PaymentRow {
    id: String,
    order_id: String,
    method: String,
    amount: i64,
    cash_received: Option<i64>,
    cash_change: Option<i64>,
    status: String,
    refund_amount: Option<i64>,
    refund_reason: Option<String>,
    refunded_at: Option<i64>,
    created_at: i64,
}

// ---------------------------------------------------------------------------
// Pure validation / math (unit-tested on the host, see `mod tests` below)
// ---------------------------------------------------------------------------

/// The `len` ASCII digits starting at `from`, as a number (None when any of
/// them is not a digit or the slice does not exist).
fn digits(raw: &str, from: usize, len: usize) -> Option<i64> {
    let bytes = raw.as_bytes().get(from..from + len)?;
    let mut value = 0_i64;
    for &byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + i64::from(byte - b'0');
    }
    Some(value)
}

/// Gregorian leap year (the calendar the sale day runs on).
fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Days in that month of that year (0 for a month number that is not one).
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days between 1970-01-01 and the civil date (Howard Hinnant's
/// `days_from_civil`; exact over the whole proleptic Gregorian calendar, so
/// no month/year tables are needed anywhere).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_from_march = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `?day=` -> the start (unix ms) of that Bangkok calendar day, or of the day
/// `now` falls in when the parameter is absent (the queue numbers and the
/// sale day share that clock, 3.11/3.33). Strict `YYYY-MM-DD` and a real
/// calendar date; anything else is a 400 rather than a silently wrong day.
pub(super) fn day_param_start_ms(raw: Option<&str>, now: i64) -> Result<i64, ApiError> {
    let Some(raw) = raw else {
        return Ok(bangkok_day_start_ms(now));
    };
    let bad = || ApiError::BadRequest(format!("day must be a YYYY-MM-DD date, got '{raw}'"));
    let bytes = raw.as_bytes();
    if raw.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(bad());
    }
    // Every byte of the string is covered by the three digit runs, so the
    // whole input is ASCII once these parse.
    let year = digits(raw, 0, 4).ok_or_else(bad)?;
    let month = digits(raw, 5, 2).ok_or_else(bad)?;
    let day = digits(raw, 8, 2).ok_or_else(bad)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(bad());
    }
    Ok(bangkok_day_start_ms(days_from_civil(year, month, day) * DAY_MS + NOON_MS))
}

/// The refund amount (3.28): null = the whole payment, else 1..=payment
/// amount in satang (a partial refund is a keyed satang figure, and 0 satang
/// refunds nothing).
fn refund_amount(requested: Option<i64>, payment_amount: i64) -> Result<i64, ApiError> {
    match requested {
        None => Ok(payment_amount),
        Some(amount) if amount >= 1 && amount <= payment_amount => Ok(amount),
        Some(amount) => Err(ApiError::BadRequest(format!(
            "amount must be between 1 and {payment_amount} satang, \
             or null to refund the whole payment (got {amount})"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Row -> JSON
// ---------------------------------------------------------------------------

/// One order_items row -> its JSON. options_json was written by
/// `routes::orders`, so anything unparsable is a corrupt row (500, not a
/// client error).
fn item_json(row: ItemRow) -> Result<OrderItemJson, ApiError> {
    let options: Vec<OptionSnapshot> = serde_json::from_str(&row.options_json).map_err(|e| {
        ApiError::Internal(format!("order item {} has invalid options_json: {e}", row.id))
    })?;
    Ok(OrderItemJson {
        id: row.id,
        menu_item_id: row.menu_item_id,
        item_name: row.item_name,
        options,
        quantity: row.quantity,
        note: row.note,
        unit_price: row.unit_price,
        discount_amount: row.discount_amount,
        line_total: row.line_total,
    })
}

/// One orders row plus its lines -> the order JSON of every endpoint here.
fn order_json(row: OrderRow, items: Vec<OrderItemJson>) -> OrderJson {
    OrderJson {
        id: row.id,
        queue_number: row.queue_number,
        order_type: row.order_type,
        channel: row.channel,
        table_no: row.table_no,
        note: row.note,
        status: row.status,
        total_amount: row.total_amount,
        discount_amount: row.discount_amount,
        created_by: row.created_by,
        created_at: row.created_at,
        paid_at: row.paid_at,
        cancelled_at: row.cancelled_at,
        cancel_reason: row.cancel_reason,
        served_at: row.served_at,
        staff_meal: row.staff_meal != 0,
        customer_id: row.customer_id,
        member_name: row.member_name,
        points_redeemed: row.points_redeemed,
        points_earned: row.points_earned,
        member_points: row.member_points,
        items,
    }
}

/// PaymentRow -> the owner payment JSON (order_id was only used to group).
fn payment_json(row: PaymentRow) -> PaymentJson {
    PaymentJson {
        id: row.id,
        method: row.method,
        amount: row.amount,
        cash_received: row.cash_received,
        cash_change: row.cash_change,
        status: row.status,
        refund_amount: row.refund_amount,
        refund_reason: row.refund_reason,
        refunded_at: row.refunded_at,
        created_at: row.created_at,
    }
}

/// Joins the three day-window queries: lines and payments under their own
/// bill (in query order), orders kept in the order the query sorted them.
fn assemble_day(
    orders: Vec<OrderRow>,
    items: Vec<ItemRow>,
    payments: Vec<PaymentRow>,
) -> Result<Vec<DayOrderJson>, ApiError> {
    let mut lines: HashMap<String, Vec<OrderItemJson>> = HashMap::new();
    for row in items {
        lines.entry(row.order_id.clone()).or_default().push(item_json(row)?);
    }
    let mut bills: HashMap<String, Vec<PaymentJson>> = HashMap::new();
    for row in payments {
        bills
            .entry(row.order_id.clone())
            .or_default()
            .push(payment_json(row));
    }
    Ok(orders
        .into_iter()
        .map(|order| {
            let id = order.id.clone();
            let items = lines.remove(&id).unwrap_or_default();
            let payments = bills.remove(&id).unwrap_or_default();
            DayOrderJson {
                order: order_json(order, items),
                payments,
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

/// shop_id of the order with this id, if any. The owner role spans every shop
/// (schema 0001), so these endpoints resolve the shop from the bill itself
/// and then reuse the shop-scoped helpers of `routes::orders`.
async fn order_shop(env: &Env, order_id: &str) -> Result<Option<String>, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT shop_id FROM orders WHERE id = ?1")
        .bind(&[txt(order_id)])?
        .first::<String>(Some("shop_id"))
        .await?)
}

/// One payments row by id (any shop), with the refund fields.
async fn load_payment(env: &Env, payment_id: &str) -> Result<Option<PaymentRow>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!(
            "SELECT {PAYMENT_COLUMNS} FROM payments WHERE id = ?1"
        ))
        .bind(&[txt(payment_id)])?
        .first::<PaymentRow>(None)
        .await?)
}

/// Why the refund UPDATE matched no row: the payment vanished (404) or sits
/// in another status (409 naming it, so the owner app can say what to do -
/// a pending charge cannot be refunded from here).
async fn refund_refused(env: &Env, payment_id: &str) -> ApiError {
    match load_payment(env, payment_id).await {
        Ok(Some(row)) => ApiError::Conflict(format!("payment is {}", row.status)),
        Ok(None) => ApiError::NotFound,
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// The bills of one sale day (3.47, 3.60): every order created inside the
/// Bangkok calendar day of `?day=` (default today), newest first with its
/// lines and payments. Exactly three queries - the orders of the window, then
/// the items and payments of those orders, each fetched through one subquery
/// on the same shop + time window, never per order.
#[worker::send]
pub async fn day_list(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(shop_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<DayOrdersJson>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let start = day_param_start_ms(query_param(&query, "day").as_deref(), now_ms())?;
    let end = start + DAY_MS;
    let env = &state.env;

    let orders = db::db(env)?
        .prepare(format!(
            "SELECT {ORDER_COLUMNS}
             FROM orders
             WHERE shop_id = ?1 AND created_at >= ?2 AND created_at < ?3
             ORDER BY created_at DESC, id DESC
             LIMIT {MAX_DAY_ORDERS}"
        ))
        .bind(&[txt(&shop_id), int(start), int(end)])?
        .all()
        .await?
        .results::<OrderRow>()?;
    let items = db::db(env)?
        .prepare(format!(
            "SELECT {ITEM_COLUMNS}
             FROM order_items
             WHERE shop_id = ?1
               AND order_id IN (SELECT id FROM orders
                                WHERE shop_id = ?1 AND created_at >= ?2 AND created_at < ?3)
             ORDER BY rowid"
        ))
        .bind(&[txt(&shop_id), int(start), int(end)])?
        .all()
        .await?
        .results::<ItemRow>()?;
    let payments = db::db(env)?
        .prepare(format!(
            "SELECT {PAYMENT_COLUMNS}
             FROM payments
             WHERE shop_id = ?1
               AND order_id IN (SELECT id FROM orders
                                WHERE shop_id = ?1 AND created_at >= ?2 AND created_at < ?3)
             ORDER BY created_at, id"
        ))
        .bind(&[txt(&shop_id), int(start), int(end)])?
        .all()
        .await?
        .results::<PaymentRow>()?;

    Ok(Json(DayOrdersJson {
        orders: assemble_day(orders, items, payments)?,
    }))
}

/// Void an unpaid bill as the owner (3.15, 3.47): the same conditional
/// transition as the staff cancel, only `cancelled_by` is the OWNER's user
/// id, so the owner app's "cancelled bills" list shows who voided it. A paid
/// bill is refused with 409 - 3.28 (the refund endpoint) is that path.
#[worker::send]
pub async fn cancel(
    State(state): State<AppState>,
    owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CancelBody>,
) -> Result<Json<OrderJson>, ApiError> {
    let order_id = parse_uuid(&id, "id")?.to_string();
    let reason = clean_cancel_reason(&body.reason)?;
    let shop_id = order_shop(&state.env, &order_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let env = &state.env;

    if !cancel_with_restock(env, &shop_id, &order_id, &owner.user_id, &reason).await? {
        return Err(transition_refused(env, &shop_id, &order_id).await);
    }
    let order = load_order(env, &shop_id, &order_id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("order {order_id} vanished")))?;
    Ok(Json(order))
}

/// Mark a succeeded payment refunded (3.28, owner only): status 'refunded',
/// the reason, who refunded it, when and how much (null in the body = the
/// whole payment). One conditional UPDATE on `status = 'succeeded'`, so two
/// taps can never refund twice and a payment that never succeeded (pending /
/// expired) is refused with 409. The ORDER row is deliberately not touched:
/// it stays 'paid' and the reports subtract refund_amount - which is also why
/// a partly refunded payment keeps the original amount and carries the
/// refunded part in refund_amount.
#[worker::send]
pub async fn refund(
    State(state): State<AppState>,
    owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RefundBody>,
) -> Result<Json<PaymentJson>, ApiError> {
    let payment_id = parse_uuid(&id, "id")?.to_string();
    let reason = clean_cancel_reason(&body.reason)?;
    let env = &state.env;

    let row = load_payment(env, &payment_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let amount = refund_amount(body.amount, row.amount)?;

    let now = now_ms();
    let result = db::db(env)?
        .prepare(
            "UPDATE payments
             SET status = 'refunded', refund_reason = ?1, refunded_by = ?2,
                 refunded_at = ?3, refund_amount = ?4, updated_at = ?3
             WHERE id = ?5 AND status = 'succeeded'",
        )
        .bind(&[
            txt(&reason),
            txt(&owner.user_id),
            int(now),
            int(amount),
            txt(&payment_id),
        ])?
        .run()
        .await?;
    if changes(&result)? == 0 {
        return Err(refund_refused(env, &payment_id).await);
    }

    Ok(Json(PaymentJson {
        status: "refunded".to_owned(),
        refund_amount: Some(amount),
        refund_reason: Some(reason),
        refunded_at: Some(now),
        ..payment_json(row)
    }))
}

// ---------------------------------------------------------------------------
// Host unit tests (pure fns only - handlers need D1/the Workers runtime)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn bad<T: std::fmt::Debug>(result: Result<T, ApiError>) -> String {
        match result {
            Err(ApiError::BadRequest(msg)) => msg,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    // -- ?day= parsing ------------------------------------------------------

    #[test]
    fn absent_day_defaults_to_today_in_bangkok() {
        let now = 1_705_276_800_000_i64; // 2024-01-15T00:00:00Z
        assert_eq!(day_param_start_ms(None, now).unwrap(), bangkok_day_start_ms(now));
        // Any instant of the same sale day maps to the same start.
        let start = bangkok_day_start_ms(now);
        assert_eq!(day_param_start_ms(None, start).unwrap(), start);
        assert_eq!(day_param_start_ms(None, start + DAY_MS - 1).unwrap(), start);
    }

    #[test]
    fn a_day_string_pins_its_own_bangkok_day() {
        // 2024-01-15 Bangkok starts 2024-01-14T17:00:00Z.
        const JAN_15_BKK: i64 = 1_705_276_800_000 - 7 * 60 * 60 * 1000;
        assert_eq!(day_param_start_ms(Some("2024-01-15"), 0).unwrap(), JAN_15_BKK);
        // ... whatever "now" is, and from either side of the boundary.
        assert_eq!(
            day_param_start_ms(Some("2024-01-15"), JAN_15_BKK - 1).unwrap(),
            JAN_15_BKK
        );
        assert_eq!(
            day_param_start_ms(Some("2024-01-15"), JAN_15_BKK + DAY_MS - 1).unwrap(),
            JAN_15_BKK
        );
        // Consecutive day strings are exactly one sale day apart and the last
        // ms of a day still belongs to it.
        let jan_16 = day_param_start_ms(Some("2024-01-16"), 0).unwrap();
        assert_eq!(jan_16 - JAN_15_BKK, DAY_MS);
        assert_eq!(bangkok_day_start_ms(jan_16 - 1), JAN_15_BKK);
    }

    #[test]
    fn bad_day_strings_are_a_400() {
        for day in [
            "",
            "2024-1-5",
            "2024-01-5",
            "2024-1-05",
            "24-01-05",
            "2024/01/05",
            "20240105",
            "2024-01-05T00:00:00Z",
            " 2024-01-05",
            "2024-01-05 ",
            "abcd-01-05",
            "2024-aa-05",
            "2024-01-bb",
            "2024-00-05",
            "2024-13-05",
            "2024-01-00",
            "2024-01-32",
            "2023-02-29", // 2023 is not a leap year
            "1900-02-29", // ... and 1900 is not either (century rule)
            "2024-04-31",
            "2024-06-31",
        ] {
            assert!(
                bad(day_param_start_ms(Some(day), 0)).contains("YYYY-MM-DD"),
                "{day} should be rejected"
            );
        }
    }

    #[test]
    fn real_calendar_dates_are_accepted_including_leap_days() {
        for day in ["1970-01-01", "2024-02-29", "2000-02-29", "2023-12-31", "2024-11-30"] {
            assert!(day_param_start_ms(Some(day), 0).is_ok(), "{day}");
        }
        // The whole year round, every day start is 17:00 UTC sharp and
        // consecutive days are one day apart.
        for month in 1..=12 {
            for day in 1..=days_in_month(2024, month) {
                let day_str = format!("2024-{month:02}-{day:02}");
                let start = day_param_start_ms(Some(&day_str), 0).unwrap();
                assert_eq!(start.rem_euclid(DAY_MS), 17 * 60 * 60 * 1000, "{day_str}");
                if day < days_in_month(2024, month) {
                    let next = format!("2024-{month:02}-{:02}", day + 1);
                    assert_eq!(day_param_start_ms(Some(&next), 0).unwrap() - start, DAY_MS);
                }
            }
        }
    }

    #[test]
    fn days_from_civil_matches_the_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2024, 1, 15), 19_737);
        // 2024-01-01T00:00:00Z, and a date before the epoch goes negative.
        assert_eq!(days_from_civil(2024, 1, 1) * DAY_MS, 1_704_067_200_000);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
    }

    // -- refunds (3.28) -----------------------------------------------------

    #[test]
    fn refund_amount_is_whole_or_partial_never_empty() {
        assert_eq!(refund_amount(None, 4500).unwrap(), 4500);
        assert_eq!(refund_amount(Some(1), 4500).unwrap(), 1);
        assert_eq!(refund_amount(Some(4500), 4500).unwrap(), 4500);
        for requested in [0, -5, 4501] {
            assert!(
                bad(refund_amount(Some(requested), 4500)).contains("between 1 and 4500"),
                "{requested} should be rejected"
            );
        }
        // A zero payment (a fully discounted bill) can only be "refunded" whole.
        assert_eq!(refund_amount(None, 0).unwrap(), 0);
        assert!(bad(refund_amount(Some(1), 0)).contains("between 1 and 0"));
    }

    // -- day view assembly --------------------------------------------------

    fn day_order(id: &str, status: &str) -> OrderRow {
        OrderRow {
            id: id.to_owned(),
            queue_number: 41,
            order_type: "dine_in".to_owned(),
            channel: "counter".to_owned(),
            table_no: Some("3".to_owned()),
            note: None,
            status: status.to_owned(),
            total_amount: 10_000,
            discount_amount: 0,
            created_by: "staff-1".to_owned(),
            created_at: 1_705_276_800_000,
            paid_at: None,
            cancelled_at: None,
            cancel_reason: None,
            served_at: None,
            staff_meal: 0,
            customer_id: None,
            points_redeemed: 0,
            points_earned: 0,
            member_name: None,
            member_points: None,
        }
    }

    fn day_item(id: &str, order_id: &str) -> ItemRow {
        ItemRow {
            id: id.to_owned(),
            order_id: order_id.to_owned(),
            menu_item_id: "menu-1".to_owned(),
            item_name: "rice with curry".to_owned(),
            options_json: r#"[{"id":"op-1","name":"egg","price_add":1000}]"#.to_owned(),
            quantity: 2,
            note: None,
            unit_price: 5000,
            discount_amount: 0,
            line_total: 10_000,
        }
    }

    fn day_payment(id: &str, order_id: &str, status: &str, refund_amount: Option<i64>) -> PaymentRow {
        PaymentRow {
            id: id.to_owned(),
            order_id: order_id.to_owned(),
            method: "cash".to_owned(),
            amount: 10_000,
            cash_received: Some(10_000),
            cash_change: Some(0),
            status: status.to_owned(),
            refund_amount,
            refund_reason: None,
            refunded_at: None,
            created_at: 1_705_276_800_000,
        }
    }

    #[test]
    fn day_view_buckets_lines_and_payments_under_their_bill() {
        let orders = assemble_day(
            vec![day_order("o-1", "paid"), day_order("o-2", "preparing")],
            vec![day_item("l-1", "o-2"), day_item("l-2", "o-1")],
            vec![
                day_payment("p-1", "o-1", "succeeded", None),
                day_payment("p-2", "o-1", "refunded", Some(10_000)),
                day_payment("p-3", "o-9", "succeeded", None),
            ],
        )
        .unwrap();
        // The query's order (newest first) is kept.
        assert_eq!(
            orders.iter().map(|o| o.order.id.as_str()).collect::<Vec<_>>(),
            vec!["o-1", "o-2"]
        );
        // Each bill keeps only its own lines and payments.
        assert_eq!(orders[0].order.items.len(), 1);
        assert_eq!(orders[0].order.items[0].id, "l-2");
        assert_eq!(
            orders[0]
                .payments
                .iter()
                .map(|p| (p.id.as_str(), p.status.as_str()))
                .collect::<Vec<_>>(),
            vec![("p-1", "succeeded"), ("p-2", "refunded")]
        );
        assert_eq!(orders[0].payments[1].refund_amount, Some(10_000));
        assert_eq!(orders[1].order.items[0].id, "l-1");
        // An unpaid bill has no payments; a payment of a bill outside the
        // window is simply dropped.
        assert!(orders[1].payments.is_empty());
        // The option snapshot comes back as the stored JSON.
        assert_eq!(orders[0].order.items[0].options.len(), 1);
        assert_eq!(orders[0].order.items[0].options[0].price_add, 1000);
    }
}
