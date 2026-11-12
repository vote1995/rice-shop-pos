//! Members + loyalty points over HTTP (docs/members-spec.md, migration 0011).
//!
//! Endpoints:
//! - `GET  /public/join/{shop_id}`       (NO auth — the join page of one
//!   shop, same origin) the shop name (the PDPA data controller) and the
//!   consent version the notice of the day is shown under
//! - `POST /public/join/{shop_id}`       (NO auth) the join form: consent +
//!   first/last name + phone; the answer is IDENTICAL whether that phone is
//!   already a member, so the endpoint can never be used to probe for a
//!   member (and it never logs or echoes the submitted name/phone)
//! - `POST /members/lookup`              (staff) one member by phone, plus
//!   the points still available after the member's OTHER open bills
//! - `PUT  /orders/{id}/member`          (staff) attach / detach a member on
//!   an open counter bill and set the points to redeem on it
//! - `GET  /owner/shops/{shop_id}/customers?q=` (owner) the member list of a
//!   shop, searchable by name or phone digits
//! - `DELETE /owner/customers/{id}`      (owner) PDPA erasure on request
//!
//! The money rules themselves live in [`crate::loyalty`] (cleaning,
//! earn/redeem math, the settle batch the pay paths append, the sweeps); the
//! bill shape (`OrderJson`, with `customer_id` / `member_name` /
//! `points_redeemed` / `points_earned` / `member_points`) lives in
//! [`crate::routes::orders`] and is reused here as-is, so staff, owner and
//! this module always report the same bill.
//!
//! Everything a client sends is bound as a D1 parameter, never concatenated
//! into SQL — the owner search builds a `LIKE` pattern in Rust but passes it
//! as a bind value, with the LIKE metacharacters (`%`, `_` and the escape
//! character itself) escaped and an `ESCAPE '\'` clause, so a search for
//! "100%" matches the name "100%" and nothing else.

use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use worker::Env;

use crate::auth::owner::OwnerAuth;
use crate::auth::staff::StaffAuth;
use crate::extract::ApiJson;
use crate::routes::owner::query_param;
use crate::routes::orders::{changes, load_order, transition_refused, OrderJson};
use crate::util::{int, now_ms, opt_txt, parse_uuid, txt};
use crate::{db, error::ApiError, loyalty, AppState};

/// One page of the owner member list (docs/members-spec.md: max 100).
const MAX_CUSTOMERS: i64 = 100;
/// The owner search fragment is capped in characters before it is turned
/// into LIKE patterns (a bounded input can never grow an unbounded query).
const MAX_Q_CHARS: usize = 60;
/// A phone longer than this cannot normalize into the 10 stored digits, so it
/// is refused up front instead of being walked character by character.
const MAX_PHONE_INPUT_CHARS: usize = 32;

/// One customers row plus the reservation math of the moment: `reserved` is
/// `SUM(points_redeemed)` of the member's open counter bills EXCEPT `?1` (the
/// bill the caller is about to edit reads its own reservation as still
/// available — `?1` NULL counts every open bill). A scalar subquery, not a
/// JOIN: the customer row count cannot change.
const CUSTOMER_COLUMNS: &str = "id, first_name, last_name, phone, points, \
     COALESCE((SELECT SUM(o.points_redeemed) FROM orders o \
               WHERE o.customer_id = customers.id AND o.channel = 'counter' \
                 AND o.status IN ('preparing', 'served') AND o.id IS NOT ?1), 0) AS reserved";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/// `POST /public/join/{shop_id}` body: the PDPA consent the member accepted
/// (`consent: true` + the version the notice was shown under) plus the data
/// the notice names (first/last name, phone).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinBody {
    pub first_name: String,
    pub last_name: String,
    pub phone: String,
    pub consent: bool,
    pub consent_version: String,
}

/// `GET /public/join/{shop_id}` payload.
#[derive(Debug, Serialize)]
pub struct JoinInfoJson {
    pub shop_name: String,
    pub consent_version: &'static str,
}

/// `POST /members/lookup` body: the phone the member tells the counter, and
/// optionally the bill the points are being considered for (its own
/// reservation then does not count against the member).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LookupBody {
    pub phone: String,
    pub order_id: Option<String>,
}

/// The `customer` object of the lookup response. `phone_last4` is all the
/// counter needs to confirm the member ("คุณสมชาย ...5678 ใช่ไหมครับ").
#[derive(Debug, Serialize)]
pub struct MemberJson {
    pub id: String,
    pub first_name: String,
    pub last_name: String,
    pub phone_last4: String,
    pub points: i64,
    pub available_points: i64,
}

/// `POST /members/lookup` payload.
#[derive(Debug, Serialize)]
pub struct LookupJson {
    pub customer: MemberJson,
}

/// `PUT /orders/{id}/member` body: the member to put on the bill (null =
/// detach, and then `points` must be 0) and the points to redeem on it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderMemberBody {
    pub customer_id: Option<String>,
    pub points: i64,
}

/// One row of the owner member list (no `consent_version`: the owner console
/// does not re-display the notice, only the join page does).
#[derive(Debug, Serialize, Deserialize)]
pub struct OwnerCustomerRow {
    id: String,
    first_name: String,
    last_name: String,
    phone: String,
    points: i64,
    consent_at: i64,
    /// The member's LAST service use (a paid bill) — the clock of the
    /// 6-month expiry and the 1-year erasure.
    updated_at: i64,
}

/// `GET /owner/shops/{shop_id}/customers` payload.
#[derive(Debug, Serialize)]
pub struct CustomersJson {
    customers: Vec<OwnerCustomerRow>,
}

/// One customers row as D1 returns it, with the reservation sum.
#[derive(Debug, Deserialize)]
struct CustomerRow {
    id: String,
    first_name: String,
    last_name: String,
    phone: String,
    points: i64,
    reserved: i64,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested on the host, see `mod tests` below)
// ---------------------------------------------------------------------------

/// The points a member may still put on a bill: the balance minus what the
/// member's OTHER open counter bills already reserve, never below 0.
fn available_points(points: i64, reserved: i64) -> i64 {
    (points - reserved).max(0)
}

/// The last four characters of a stored phone (it is normalized to 10 ASCII
/// digits before it is ever stored, but this cannot panic on a shorter one).
fn phone_last4(phone: &str) -> String {
    phone.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect()
}

/// The typed-in phone of the join/lookup forms: bounded up front, then
/// normalized to the stored `0XXXXXXXXX` shape (see [`loyalty::normalize_phone`]).
fn clean_phone(raw: &str) -> Result<String, ApiError> {
    let bad = || {
        ApiError::BadRequest("phone must be a Thai mobile number, e.g. 0812345678".into())
    };
    if raw.chars().count() > MAX_PHONE_INPUT_CHARS {
        return Err(bad());
    }
    loyalty::normalize_phone(raw).ok_or_else(bad)
}

/// The LIKE metacharacters of `raw` (`%`, `_`) and the escape character
/// itself, each prefixed with the escape character — so with
/// `... LIKE ? ESCAPE '\'` a `100%` in the search text matches a literal
/// "100%" in the data and never acts as a wildcard.
fn escape_like(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `%fragment%` with every metacharacter escaped, the shape both owner search
/// branches bind as a LIKE pattern.
fn like_pattern(fragment: &str) -> String {
    format!("%{}%", escape_like(fragment))
}

/// The ASCII digits of a search fragment: people type `081-234-5678` while
/// the phone is stored as `0812345678`, so the phone branch searches the
/// digits only. Empty when the fragment has none, which skips the branch.
fn digits_only(raw: &str) -> String {
    raw.chars().filter(|c| c.is_ascii_digit()).collect()
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

/// 404 code `member_not_found` (the pay sheet says "ไม่พบสมาชิก" on it).
fn member_not_found() -> ApiError {
    ApiError::coded(
        StatusCode::NOT_FOUND,
        "member_not_found",
        "no member of this shop has that phone number",
    )
}

/// The shop's display name — the PDPA notice names it as the data
/// controller — or None when the id is not a shop.
async fn shop_name(env: &Env, shop_id: &str) -> Result<Option<String>, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT name FROM shops WHERE id = ?1")
        .bind(&[txt(shop_id)])?
        .first::<String>(Some("name"))
        .await?)
}

/// The member of this shop with that phone (`?1` = the order whose own
/// reservation must not count, `?2` = shop, `?3` = phone).
async fn customer_by_phone(
    env: &Env,
    shop_id: &str,
    phone: &str,
    except_order: Option<&str>,
) -> Result<Option<CustomerRow>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!(
            "SELECT {CUSTOMER_COLUMNS} FROM customers WHERE shop_id = ?2 AND phone = ?3"
        ))
        .bind(&[opt_txt(except_order), txt(shop_id), txt(phone)])?
        .first::<CustomerRow>(None)
        .await?)
}

/// The member of this shop with that id (same parameter order as
/// [`customer_by_phone`]).
async fn customer_by_id(
    env: &Env,
    shop_id: &str,
    customer_id: &str,
    except_order: Option<&str>,
) -> Result<Option<CustomerRow>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!(
            "SELECT {CUSTOMER_COLUMNS} FROM customers WHERE shop_id = ?2 AND id = ?3"
        ))
        .bind(&[opt_txt(except_order), txt(shop_id), txt(customer_id)])?
        .first::<CustomerRow>(None)
        .await?)
}

/// The bill's subtotal in satang: the sum of its line totals (what the
/// plates cost after every line discount), BEFORE the bill-wide discount and
/// before redeemed points — the base the redemption cap is computed from.
async fn order_subtotal(env: &Env, order_id: &str) -> Result<i64, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT COALESCE(SUM(line_total), 0) AS subtotal
             FROM order_items WHERE order_id = ?1",
        )
        .bind(&[txt(order_id)])?
        .first::<i64>(Some("subtotal"))
        .await?
        .unwrap_or(0))
}

/// Does a PromptPay QR await payment on this bill? Once it does, the member
/// and the points on the bill are frozen (the QR is for one exact amount).
async fn has_pending_qr(env: &Env, order_id: &str) -> Result<bool, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT 1 AS pending FROM payments
             WHERE order_id = ?1 AND method = 'promptpay' AND status = 'pending'
             LIMIT 1",
        )
        .bind(&[txt(order_id)])?
        .first::<i64>(Some("pending"))
        .await?
        .is_some())
}

// ---------------------------------------------------------------------------
// Public join page (NO auth — same origin, shop by path)
// ---------------------------------------------------------------------------

/// `GET /api/public/join/{shop_id}`: what the join page needs before the form
/// — the shop's name (shown in the PDPA notice as the data controller) and
/// the consent version of the notice to render and POST back. 404 for an
/// unknown shop, 400 for a shop id that is not a UUID.
#[worker::send]
pub async fn join_info(
    State(state): State<AppState>,
    Path(shop_id): Path<String>,
) -> Result<Json<JoinInfoJson>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let shop_name = shop_name(&state.env, &shop_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(JoinInfoJson {
        shop_name,
        consent_version: loyalty::CONSENT_VERSION,
    }))
}

/// `POST /api/public/join/{shop_id}`: the join form. The consent must be
/// `true` and name the version of the notice the member actually read; the
/// names and the phone are cleaned by the shared rules ([`loyalty::clean_name`],
/// [`loyalty::normalize_phone`]). The insert is `ON CONFLICT(shop_id, phone)
/// DO NOTHING` and the response is the same whether it inserted or not, so
/// a duplicate phone silently changes nothing and nobody can tell from the
/// outside whether a phone number is already a member. The submitted name and
/// phone are never logged and never echoed back — not even in an error.
#[worker::send]
pub async fn join(
    State(state): State<AppState>,
    Path(shop_id): Path<String>,
    ApiJson(body): ApiJson<JoinBody>,
) -> Result<Json<Value>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    // Unknown shop = 404 whatever the body says: the page cannot even show
    // the notice for it.
    shop_name(&state.env, &shop_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    // PDPA: a stored consent must name the notice the member saw.
    if !body.consent {
        return Err(ApiError::BadRequest(
            "consent must be true to join the membership".into(),
        ));
    }
    if body.consent_version != loyalty::CONSENT_VERSION {
        return Err(ApiError::BadRequest(format!(
            "consent_version must be '{}' — open the join page again and \
             accept the current notice",
            loyalty::CONSENT_VERSION
        )));
    }
    let first_name = loyalty::clean_name(&body.first_name).ok_or_else(|| {
        ApiError::BadRequest("first_name must be 1-60 characters, no control characters".into())
    })?;
    let last_name = loyalty::clean_name(&body.last_name).ok_or_else(|| {
        ApiError::BadRequest("last_name must be 1-60 characters, no control characters".into())
    })?;
    let phone = clean_phone(&body.phone)?;

    // Server-generated id (the public form has no client id to be idempotent
    // with); the whole row is stamped once, so consent_at = created_at =
    // updated_at = now. updated_at is the "last service use" clock and is
    // rewritten ONLY by a successful payment (crate::loyalty).
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    db::db(&state.env)?
        .prepare(
            "INSERT INTO customers
               (id, shop_id, first_name, last_name, phone, points,
                consent_version, consent_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?7, ?7)
             ON CONFLICT(shop_id, phone) DO NOTHING",
        )
        .bind(&[
            txt(&id),
            txt(&shop_id),
            txt(&first_name),
            txt(&last_name),
            txt(&phone),
            txt(loyalty::CONSENT_VERSION),
            int(now),
        ])?
        .run()
        .await?;
    // The change count is deliberately NOT read: the answer is the same for
    // a new member and for an already-member (whose stored row, consent and
    // all, stays exactly as it was).
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Staff: lookup + attach/detach on a bill
// ---------------------------------------------------------------------------

/// `POST /api/members/lookup`: the member of the session shop with that phone
/// number, their balance and the points still available (the balance minus
/// the reservations of the member's OTHER open counter bills — `order_id`'s
/// own reservation does not count). 404 `member_not_found` otherwise.
#[worker::send]
pub async fn lookup(
    State(state): State<AppState>,
    staff: StaffAuth,
    ApiJson(body): ApiJson<LookupBody>,
) -> Result<Json<LookupJson>, ApiError> {
    let phone = clean_phone(&body.phone)?;
    let except_order = match body.order_id {
        Some(raw) => Some(parse_uuid(&raw, "order_id")?.to_string()),
        None => None,
    };
    let row = customer_by_phone(&state.env, &staff.shop_id, &phone, except_order.as_deref())
        .await?
        .ok_or_else(member_not_found)?;
    Ok(Json(LookupJson {
        customer: MemberJson {
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            phone_last4: phone_last4(&row.phone),
            points: row.points,
            available_points: available_points(row.points, row.reserved),
        },
    }))
}

/// `PUT /api/orders/{id}/member`: attach a member to an open counter bill and
/// reserve `points` of their balance on it, or detach (`customer_id` null,
/// `points` 0). The bill must belong to the session shop, be a real counter
/// bill that is still open, and have no PromptPay QR pending on it; the
/// points must satisfy the redemption rules ([`loyalty::valid_redeem`])
/// against the member's available points and the bill's subtotal. The whole
/// change is ONE guarded UPDATE (still open, this shop), so a bill that was
/// paid/cancelled underneath the request changes nothing and answers 409.
#[worker::send]
pub async fn set_member(
    State(state): State<AppState>,
    staff: StaffAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<OrderMemberBody>,
) -> Result<Json<OrderJson>, ApiError> {
    let order_id = parse_uuid(&id, "id")?.to_string();
    let shop_id = staff.shop_id;
    let env = &state.env;

    let order = load_order(env, &shop_id, &order_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    // Points are a counter thing (delivery apps settle their own bills) and
    // never a staff benefit (migration 0007 closes those at insert, but the
    // check is explicit anyway).
    if order.channel != "counter" {
        return Err(ApiError::Conflict(
            "members and points are for counter orders".into(),
        ));
    }
    if order.staff_meal {
        return Err(ApiError::Conflict("a staff meal has no member".into()));
    }
    if !matches!(order.status.as_str(), "preparing" | "served") {
        return Err(ApiError::Conflict(format!("order is {}", order.status)));
    }
    if has_pending_qr(env, &order_id).await? {
        return Err(ApiError::coded(
            StatusCode::CONFLICT,
            "qr_pending",
            "a PromptPay QR is pending on this bill — let it finish or expire \
             before changing the member",
        ));
    }

    let customer_id = match body.customer_id {
        // Detach: the member link goes and no points may stay reserved.
        None => {
            if body.points != 0 {
                return Err(ApiError::BadRequest(
                    "points must be 0 when the member is removed from the bill".into(),
                ));
            }
            None
        }
        Some(raw) => {
            let customer_id = parse_uuid(&raw, "customer_id")?.to_string();
            // The member must belong to THIS shop (a member belongs to one
            // shop only, migration 0011); the bill's own current reservation
            // does not count against what is available for it.
            let member = customer_by_id(env, &shop_id, &customer_id, Some(&order_id))
                .await?
                .ok_or_else(member_not_found)?;
            let available = available_points(member.points, member.reserved);
            // The redemption cap: the bill's lines minus the bill-wide
            // discount, before points.
            let subtotal = order_subtotal(env, &order_id).await? - order.discount_amount;
            if !loyalty::valid_redeem(body.points, subtotal, available) {
                return Err(ApiError::BadRequest(format!(
                    "points must be 0 or a whole step of 10, at most the \
                     member's available {available} points and at most the \
                     bill subtotal ({subtotal} satang)"
                )));
            }
            Some(customer_id)
        }
    };

    // One guarded UPDATE: the total is recomputed from the stored lines, the
    // stored bill discount AND the new reservation (1 point = 100 satang) —
    // the same shape every total recompute uses (docs/members-spec.md). A
    // lost race (the bill closed underneath) changes nothing and is reported
    // by the shared 404/409 explainer.
    let result = db::db(env)?
        .prepare(
            "UPDATE orders
             SET customer_id = ?1, points_redeemed = ?2,
                 total_amount = MAX(0, (SELECT COALESCE(SUM(line_total), 0)
                                        FROM order_items WHERE order_id = ?3)
                                       - discount_amount - ?2 * 100),
                 updated_at = ?4
             WHERE id = ?3 AND shop_id = ?5 AND status IN ('preparing', 'served')",
        )
        .bind(&[
            opt_txt(customer_id.as_deref()),
            int(body.points),
            txt(&order_id),
            int(now_ms()),
            txt(&shop_id),
        ])?
        .run()
        .await?;
    if changes(&result)? == 0 {
        return Err(transition_refused(env, &shop_id, &order_id).await);
    }

    let order = load_order(env, &shop_id, &order_id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("order {order_id} vanished")))?;
    Ok(Json(order))
}

// ---------------------------------------------------------------------------
// Owner: member list + erasure on request
// ---------------------------------------------------------------------------

/// `GET /api/owner/shops/{shop_id}/customers?q=`: the members of one shop,
/// newest `updated_at` (last service use) first, at most 100. `q` matches the
/// phone (its digits — people type dashes) or the first/last name; the
/// pattern is BOUND as a parameter with the LIKE metacharacters escaped and
/// an explicit `ESCAPE '\'` clause, so no search text ever reaches the SQL
/// text and "100%" searches for the name "100%", not for everything.
#[worker::send]
pub async fn owner_list(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(shop_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<CustomersJson>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    // Trimmed, bounded, absent when empty: `chars().take()` keeps whole
    // characters (a cut Thai grapheme would never match anything).
    let q = query_param(&query, "q")
        .map(|q| q.trim().to_owned())
        .filter(|q| !q.is_empty())
        .map(|q| q.chars().take(MAX_Q_CHARS).collect::<String>());
    // Each branch is disabled by binding NULL: the SQL text stays the same
    // for every search, and only the bound pattern changes.
    let name_pattern = q.as_deref().map(like_pattern);
    let phone_pattern = q
        .as_deref()
        .map(digits_only)
        .filter(|digits| !digits.is_empty())
        .as_deref()
        .map(like_pattern);
    let customers = db::db(&state.env)?
        .prepare(format!(
            "SELECT id, first_name, last_name, phone, points, consent_at, updated_at
             FROM customers
             WHERE shop_id = ?1
               AND (?2 IS NULL OR first_name LIKE ?2 ESCAPE '\\' OR last_name LIKE ?2 ESCAPE '\\')
               AND (?3 IS NULL OR phone LIKE ?3 ESCAPE '\\')
             ORDER BY updated_at DESC, id DESC
             LIMIT {MAX_CUSTOMERS}"
        ))
        .bind(&[
            txt(&shop_id),
            opt_txt(name_pattern.as_deref()),
            opt_txt(phone_pattern.as_deref()),
        ])?
        .all()
        .await?
        .results::<OwnerCustomerRow>()?;
    Ok(Json(CustomersJson { customers }))
}

/// `DELETE /api/owner/customers/{id}`: the member's PDPA erasure on request —
/// exactly the three statements of the 1-year sweep ([`loyalty::erase_statements`],
/// one batch: point history, then the member link on every bill — its
/// reservations returned to 0 — then the member row last). A replay is a
/// no-op but the first call answers `{"ok": true}`; an unknown id is a 404.
#[worker::send]
pub async fn owner_delete(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let customer_id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let exists = db::db(env)?
        .prepare("SELECT id FROM customers WHERE id = ?1")
        .bind(&[txt(&customer_id)])?
        .first::<String>(Some("id"))
        .await?
        .is_some();
    if !exists {
        return Err(ApiError::NotFound);
    }
    db::db(env)?
        .batch(loyalty::erase_statements(env, &customer_id)?)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Host unit tests (pure fns only — handlers need D1/the Workers runtime)
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

    #[test]
    fn available_points_is_the_balance_minus_other_bills_never_negative() {
        assert_eq!(available_points(120, 0), 120);
        // One other open bill reserves 30 of a 120-point balance.
        assert_eq!(available_points(120, 30), 90);
        // Several other bills reserve together, not per bill.
        assert_eq!(available_points(120, 20 + 40), 60);
        // Over-reserved (two bills raced): floored at 0, never negative.
        assert_eq!(available_points(10, 40), 0);
        assert_eq!(available_points(0, 0), 0);
    }

    #[test]
    fn phone_last4_is_the_stored_tail() {
        assert_eq!(phone_last4("0812345678"), "5678");
        assert_eq!(phone_last4("0890000000"), "0000");
        // Cannot panic on an unexpectedly short value.
        assert_eq!(phone_last4("12"), "12");
        assert_eq!(phone_last4(""), "");
    }

    #[test]
    fn phones_are_bounded_then_normalized() {
        assert_eq!(clean_phone("081-234-5678").unwrap(), "0812345678");
        assert_eq!(clean_phone("+66 81 234 5678").unwrap(), "0812345678");
        // A landline, junk, or an empty string is a clear 400 that never
        // echoes the input.
        assert!(bad(clean_phone("0212345678")).contains("Thai mobile"));
        assert!(bad(clean_phone("")).contains("Thai mobile"));
        assert!(bad(clean_phone("not a phone")).contains("Thai mobile"));
        // And a novel-length "phone" is refused before it is even walked.
        let huge = "0".repeat(MAX_PHONE_INPUT_CHARS + 1);
        assert!(bad(clean_phone(&huge)).contains("Thai mobile"));
    }

    #[test]
    fn like_patterns_escape_the_metacharacters() {
        // A literal % or _ must not act as a wildcard.
        assert_eq!(escape_like("100%"), "100\\%");
        assert_eq!(escape_like("a_b"), "a\\_b");
        // The escape character itself is escaped too, so a stored backslash
        // cannot swallow the next character of the pattern.
        assert_eq!(escape_like("a\\b"), "a\\\\b");
        assert_eq!(escape_like("plain"), "plain");
        // The bound pattern is the fragment between two unescaped wildcards.
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("สมชาย"), "%สมชาย%");
        assert_eq!(like_pattern(""), "%%");
        // Everything else passes through untouched.
        assert_eq!(escape_like("Somchai Meechai"), "Somchai Meechai");
    }

    #[test]
    fn digits_only_keeps_what_people_type_in_phone_searches() {
        assert_eq!(digits_only("081-234-5678"), "0812345678");
        assert_eq!(digits_only("+66812345678"), "66812345678");
        assert_eq!(digits_only("081"), "081");
        // A name search has no digits: the phone branch is skipped.
        assert_eq!(digits_only("สมชาย"), "");
        assert_eq!(digits_only(""), "");
        // Thai digits are not ASCII digits, so they never join the pattern.
        assert_eq!(digits_only("๐๘๑"), "");
    }
}
