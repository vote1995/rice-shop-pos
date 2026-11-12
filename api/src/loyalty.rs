//! Member loyalty points — the core (docs/members-spec.md, migration 0011).
//!
//! Money is satang everywhere; 1 point = 1 baht = 100 satang. This module is
//! the shared core of the members feature, split the same way the rest of the
//! crate is:
//!
//! - the RULES, mechanism-free and unit-tested on the host: phone/name
//!   cleaning for the join form ([`normalize_phone`], [`clean_name`]) and the
//!   earn/redeem math for bills ([`earn_points`], [`max_redeemable`],
//!   [`valid_redeem`]),
//! - the retention windows the PDPA notice promises ([`EXPIRE_AFTER_MS`]:
//!   points cleared after 6 months of no use, [`DELETE_AFTER_MS`]: data
//!   deleted after 1 year) and the consent version it was shown under
//!   ([`CONSENT_VERSION`]),
//! - the SETTLE batch ([`settle_statements`]): the point movement of ONE
//!   bill, appended by a pay path right after its own
//!   `UPDATE orders SET status = 'paid'` in the SAME D1 batch, so a member's
//!   points move exactly when (and because) the payment succeeded — never on
//!   a cancel, refund or open bill,
//! - the SWEEPS ([`sweep`], kept cheap by the hourly gate [`sweep_if_due`])
//!   and [`erase_statements`], the three-statement PDPA erasure shared by
//!   the 1-year sweep and the owner DELETE-on-request endpoint.
//!
//! Points are only RESERVED while a bill is open (`orders.points_redeemed`,
//! checked against the member's balance minus other open bills' reserves);
//! they are deducted once, here, when the bill closes.

// The call sites that use the public rules and statement builders below
// (routes/members.rs, the pay batch, the owner customer DELETE) land with the
// next tickets of the members feature; until then only the host unit tests
// and the cron sweep call into this module — hence the module-level
// dead_code allow (same pattern as `pricing` when M1-2 had not landed yet).
#![allow(dead_code)]

use wasm_bindgen::JsValue;
use worker::{D1PreparedStatement, Env};

use crate::db;
use crate::error::ApiError;
use crate::util::{int, now_ms, txt};

/// The PDPA notice the member accepted (`consent_version` column). The web
/// join page shows the notice of exactly this version and posts it back; a
/// join with any other version is refused, so the stored consent always names
/// the notice the member actually read.
pub const CONSENT_VERSION: &str = "2026-11-v1";

/// Points expire after 6 months (183 days) without a paid bill. The clock is
/// `customers.updated_at`, changed ONLY by [`settle_statements`].
pub const EXPIRE_AFTER_MS: i64 = 183 * 86_400_000;
/// The member's data is erased after 1 year (365 days) without a paid bill.
/// Strictly longer than [`EXPIRE_AFTER_MS`], and [`sweep`] runs expiry
/// first, so data is never deleted while unexpired points sit on it.
pub const DELETE_AFTER_MS: i64 = 365 * 86_400_000;

/// How many members one sweep run may expire / erase (oldest first). Keeps
/// each cron tick well inside the Workers/D1 limits; a bigger backlog simply
/// drains over the next hours.
const SWEEP_LIMIT: i64 = 200;

/// first_name / last_name bound, in characters (Thai names are multibyte;
/// SQLite `length()` counts characters too, so the CHECK of migration 0011
/// agrees with [`clean_name`]).
const MAX_NAME_CHARS: usize = 60;

// ---------------------------------------------------------------------------
// Pure rules (unit-tested below, no D1 / worker types)
// ---------------------------------------------------------------------------

/// A typed-in phone number -> the stored shape `0XXXXXXXXX`, or `None` when
/// it cannot be a Thai mobile number. The separators people actually type
/// (spaces, dashes, dots, parentheses) are dropped; a `+66`/`66` country
/// prefix becomes the leading `0`; the result must match `^0[689]\d{8}$` —
/// mobiles only, because points are told apart by phone at the counter.
pub fn normalize_phone(raw: &str) -> Option<String> {
    let digits: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '.' | '(' | ')'))
        .collect();
    let local = if let Some(rest) = digits.strip_prefix("+66") {
        format!("0{rest}")
    } else if let Some(rest) = digits.strip_prefix("66") {
        format!("0{rest}")
    } else {
        digits
    };
    is_thai_mobile(&local).then_some(local)
}

/// `^0[689]\d{8}$`, checked per character (no regex, and a multibyte lookalike
/// digit can never pass as an ASCII one).
fn is_thai_mobile(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    chars.len() == 10
        && chars[0] == '0'
        && matches!(chars[1], '6' | '8' | '9')
        && chars[2..].iter().all(|c| c.is_ascii_digit())
}

/// A first/last name as it is stored: trimmed, inner whitespace collapsed to
/// single spaces, 1..=60 characters, no control characters. `None` when the
/// input cannot be stored (the join form answers 400 with that).
pub fn clean_name(raw: &str) -> Option<String> {
    if raw.chars().any(char::is_control) {
        return None;
    }
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let len = name.chars().count();
    (1..=MAX_NAME_CHARS).contains(&len).then_some(name)
}

/// Points earned by one bill: `floor(total_satang / 10_000)` — 1 point per
/// whole 100.00 ฿ of the bill total AFTER the redeemed points were deducted,
/// per bill, never fractional, never negative.
pub fn earn_points(total_satang: i64) -> i64 {
    total_satang.max(0) / 10_000
}

/// The largest redemption allowed on a bill whose subtotal (satang, BEFORE
/// points are deducted) is `subtotal_satang`: whole steps of 10 points
/// (10 points = 10.00 ฿ discount), never more than the member's available
/// points and never more than the whole 10-฿ steps the subtotal covers.
/// 0 when no step of 10 fits — a member needs at least 10 points AND a
/// 10.00 ฿ bill to redeem anything.
pub fn max_redeemable(subtotal_satang: i64, available_points: i64) -> i64 {
    if subtotal_satang <= 0 || available_points < 10 {
        return 0;
    }
    let by_subtotal = subtotal_satang / 100 / 10 * 10;
    let by_points = available_points / 10 * 10;
    by_subtotal.min(by_points)
}

/// May a bill redeem exactly `points` of the member's balance? 0 points is
/// always allowed (no member on the bill); anything else must be a whole
/// step of 10 within [`max_redeemable`].
pub fn valid_redeem(points: i64, subtotal_satang: i64, available: i64) -> bool {
    points == 0
        || (points >= 10 && points % 10 == 0 && points <= max_redeemable(subtotal_satang, available))
}

// ---------------------------------------------------------------------------
// Settle (appended to the batch that closes a bill as paid)
// ---------------------------------------------------------------------------

/// Which bills settle points: a REAL counter bill with a member that is
/// closed as paid — never a delivery-app bill, never a staff meal
/// (migration 0007 closes those at insert), and `paid_at` must exist because
/// it becomes the member's `updated_at`. The column names are unqualified on
/// purpose: `orders` is the only table with these columns everywhere the
/// fragment is used, so it drops into the subqueries of the customer UPDATE
/// (alias `o`), the FROM of the ledger INSERTs (`orders o JOIN customers c`)
/// and the plain WHERE of the orders UPDATE below.
const PAID_COUNTER_MEMBER: &str = "customer_id IS NOT NULL AND status = 'paid'
     AND channel = 'counter' AND staff_meal = 0 AND paid_at IS NOT NULL";

/// The point settlement of ONE bill: the statements a pay path appends to its
/// D1 batch right AFTER its own `UPDATE orders SET status = 'paid'`, so the
/// statements below see the bill as already paid. They settle the bill's
/// redemption (negative ledger row) and earn (positive ledger row), move
/// `customers.points` to `MAX(0, points - redeemed) + earned`, stamp
/// `customers.updated_at = paid_at` (the ONLY place that ever writes it — it
/// is the expiry/erasure "last used" clock) and backfill
/// `orders.points_earned`.
///
/// Every statement is a no-op unless the bill is a paid, non-staff-meal
/// counter bill with a member ([`PAID_COUNTER_MEMBER`]), and a REPLAY of the
/// whole batch is a no-op too. The order of the four statements is what makes
/// that true, so it is spelled out here:
///
/// 1. `UPDATE customers` — guarded by "no earn/redeem ledger row for this
///    bill exists". The ledger is still empty on a FIRST run (nothing before
///    this in the batch writes it), so the balance moves; on any replay the
///    rows exist, so the guard fails and the balance cannot move twice.
/// 2. the two `point_ledger` INSERTs — guarded by "no ledger row of this
///    (order, kind) yet", which `idx_point_ledger_order_kind` keeps true
///    forever after the first insert. These guards read only `point_ledger`,
///    which statement 1 does not write, so on a first run they still see
///    "nothing settled" (both rows insert) and on a replay they see the rows
///    (neither inserts). `balance_after` is read from the customer row AS
///    statement 1 left it, i.e. the post-settle balance: the earn row shows
///    the final balance, the redeem row shows `balance - earned` — the two
///    rows agree with each other and with `customers.points`.
/// 3. `UPDATE orders SET points_earned = total_amount / 10000` — recomputes
///    an absolute value from the same row, so it is idempotent by
///    construction; it writes nothing the guards above depend on.
pub fn settle_statements(
    env: &Env,
    order_id: &str,
    now: i64,
) -> Result<Vec<D1PreparedStatement>, ApiError> {
    let d1 = db::db(env)?;
    Ok(vec![
        // (a) the balance: redeem what was reserved, earn what was paid for.
        d1.prepare(format!(
            "UPDATE customers
             SET points = MAX(0, points - (SELECT o.points_redeemed FROM orders o WHERE o.id = ?1))
                        + (SELECT o.total_amount FROM orders o WHERE o.id = ?1) / 10000,
                 updated_at = (SELECT o.paid_at FROM orders o WHERE o.id = ?1)
             WHERE id = (SELECT o.customer_id FROM orders o
                         WHERE o.id = ?1 AND {PAID_COUNTER_MEMBER})
               AND NOT EXISTS (SELECT 1 FROM point_ledger pl
                               WHERE pl.order_id = ?1 AND pl.kind IN ('earn', 'redeem'))"
        ))
        .bind(&[txt(order_id)])?,
        // (b1) the redemption: negative, only when points were actually used,
        //      and consistent with the earn row (balance_before_earn).
        d1.prepare(format!(
            "INSERT INTO point_ledger
               (id, customer_id, shop_id, order_id, kind, points, balance_after, created_at)
             SELECT lower(hex(randomblob(16))), o.customer_id, o.shop_id, o.id, 'redeem',
                    -o.points_redeemed, c.points - o.total_amount / 10000, ?2
             FROM orders o JOIN customers c ON c.id = o.customer_id
             WHERE o.id = ?1 AND {PAID_COUNTER_MEMBER} AND o.points_redeemed > 0
               AND NOT EXISTS (SELECT 1 FROM point_ledger pl
                               WHERE pl.order_id = ?1 AND pl.kind = 'redeem')"
        ))
        .bind(&[txt(order_id), int(now)])?,
        // (b2) the earn: positive, only when a whole point was paid for, and
        //      the member's final balance.
        d1.prepare(format!(
            "INSERT INTO point_ledger
               (id, customer_id, shop_id, order_id, kind, points, balance_after, created_at)
             SELECT lower(hex(randomblob(16))), o.customer_id, o.shop_id, o.id, 'earn',
                    o.total_amount / 10000, c.points, ?2
             FROM orders o JOIN customers c ON c.id = o.customer_id
             WHERE o.id = ?1 AND {PAID_COUNTER_MEMBER} AND o.total_amount / 10000 > 0
               AND NOT EXISTS (SELECT 1 FROM point_ledger pl
                               WHERE pl.order_id = ?1 AND pl.kind = 'earn')"
        ))
        .bind(&[txt(order_id), int(now)])?,
        // (c) what the bill earned, for the receipt and the day view.
        d1.prepare(format!(
            "UPDATE orders SET points_earned = total_amount / 10000
             WHERE id = ?1 AND {PAID_COUNTER_MEMBER}"
        ))
        .bind(&[txt(order_id)])?,
    ])
}

// ---------------------------------------------------------------------------
// Retention sweeps (cron): expire at 183 days, erase at 365
// ---------------------------------------------------------------------------

/// The expiry half of [`sweep`], one batch: for up to [`SWEEP_LIMIT`] members
/// whose last paid bill is older than [`EXPIRE_AFTER_MS`], write one `expire`
/// ledger row (the whole balance, no order, `balance_after` 0) and zero the
/// balance. `updated_at` is deliberately NOT rewritten — it is the "last
/// used" clock only settle writes, and resetting it here would restart the
/// member's 1-year erasure countdown every expiry.
///
/// Idempotent: once a balance is 0 the INSERT matches nothing, and the UPDATE
/// keys on the ledger rows THIS run wrote (`created_at = ?1`, a fresh unix-ms
/// stamp per run), so it zeroes exactly the members the INSERT covered even
/// when more than [`SWEEP_LIMIT`] are stale — the rest come back next hour.
async fn expire_batch(env: &Env, now: i64) -> Result<(), ApiError> {
    let cutoff = now - EXPIRE_AFTER_MS;
    db::db(env)?
        .batch(vec![
            db::db(env)?
                .prepare(format!(
                    "INSERT INTO point_ledger
                       (id, customer_id, shop_id, order_id, kind, points, balance_after, created_at)
                     SELECT lower(hex(randomblob(16))), id, shop_id, NULL, 'expire', -points, 0, ?1
                     FROM customers
                     WHERE points > 0 AND updated_at < ?2
                     ORDER BY updated_at, id
                     LIMIT {SWEEP_LIMIT}"
                ))
                .bind(&[int(now), int(cutoff)])?,
            db::db(env)?
                .prepare(
                    "UPDATE customers SET points = 0
                     WHERE points > 0
                       AND id IN (SELECT customer_id FROM point_ledger
                                  WHERE kind = 'expire' AND order_id IS NULL
                                    AND created_at = ?1)",
                )
                .bind(&[int(now)])?,
        ])
        .await?;
    Ok(())
}

/// The three-statement PDPA erasure of whichever members `scope` selects
/// (with `params` bound to it): the point history, then the member link on
/// every bill (detached, its reservation returned to 0 — the bills stay,
/// money and all), then the member row itself, LAST, so nothing references
/// it any more by the time it goes. Shared by [`sweep`] (a set of stale
/// member ids) and [`erase_statements`] (one id, owner DELETE on request);
/// each of the three re-evaluates `scope`, which only reads `customers` and
/// is therefore the same set in all three.
fn erase_statements_for(
    env: &Env,
    scope: &str,
    params: &[JsValue],
) -> Result<Vec<D1PreparedStatement>, ApiError> {
    let d1 = db::db(env)?;
    Ok(vec![
        d1.prepare(format!(
            "DELETE FROM point_ledger WHERE customer_id IN ({scope})"
        ))
        .bind(params)?,
        d1.prepare(format!(
            "UPDATE orders SET customer_id = NULL, points_redeemed = 0
             WHERE customer_id IN ({scope})"
        ))
        .bind(params)?,
        d1.prepare(format!("DELETE FROM customers WHERE id IN ({scope})"))
            .bind(params)?,
    ])
}

/// PDPA erasure of ONE member (the owner DELETE endpoint): the same three
/// statements as the 1-year sweep, scoped to a single id. Run them as one
/// batch; a replay is a no-op (the member row is gone, so nothing matches).
pub fn erase_statements(
    env: &Env,
    customer_id: &str,
) -> Result<Vec<D1PreparedStatement>, ApiError> {
    erase_statements_for(env, "?1", &[txt(customer_id)])
}

/// The retention sweep (cron): (1) EXPIRE the points of members idle for
/// [`EXPIRE_AFTER_MS`], then (2) ERASE members idle for [`DELETE_AFTER_MS`].
/// Expiry runs first — 365 > 183, and both halves take the OLDEST
/// [`SWEEP_LIMIT`] members, so every member the eraser looks at has already
/// had its points expired. Both steps are single batches and idempotent:
/// after (1) the balance is 0 (nothing matches), after (2) the member row is
/// gone (nothing matches).
pub async fn sweep(env: &Env) -> Result<(), ApiError> {
    let now = now_ms();
    expire_batch(env, now).await?;
    let cutoff = now - DELETE_AFTER_MS;
    let scope = format!(
        "SELECT id FROM customers WHERE updated_at < ?1 ORDER BY updated_at, id LIMIT {SWEEP_LIMIT}"
    );
    db::db(env)?
        .batch(erase_statements_for(env, &scope, &[int(cutoff)])?)
        .await?;
    Ok(())
}

/// Cron gate: `[triggers]` fires every minute, but retention only needs an
/// hourly heartbeat — so [`sweep`] runs on the :10 tick of every UTC hour
/// and every other tick returns immediately (the slip sweep it shares the
/// cron with still runs every minute).
pub async fn sweep_if_due(env: &Env) -> Result<(), ApiError> {
    if !is_due(now_ms()) {
        return Ok(());
    }
    sweep(env).await
}

/// Is `now` inside the 10th minute of a UTC hour? Pure, so the gate is
/// unit-tested on the host like the rules above.
fn is_due(now: i64) -> bool {
    (now / 60_000) % 60 == 10
}

// ---------------------------------------------------------------------------
// Host unit tests (pure fns only — the D1 helpers need the Workers runtime)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_notice_and_the_schema() {
        assert_eq!(CONSENT_VERSION, "2026-11-v1");
        // 6 months / 1 year of no use, as the PDPA notice words it.
        assert_eq!(EXPIRE_AFTER_MS, 183 * 86_400_000);
        assert_eq!(DELETE_AFTER_MS, 365 * 86_400_000);
        // "Cleared after 6 months, deleted after 1 year" only holds because
        // erasure waits strictly longer than expiry (and sweep runs expiry
        // first).
        assert!(DELETE_AFTER_MS > EXPIRE_AFTER_MS);
    }

    #[test]
    fn phones_accept_the_formats_people_actually_type() {
        for (raw, want) in [
            ("0812345678", "0812345678"),
            ("081-234-5678", "0812345678"),
            ("081.234.5678", "0812345678"),
            ("(081) 234 5678", "0812345678"),
            ("  081 234 5678\t", "0812345678"),
            ("+66 81 234 5678", "0812345678"),
            ("+66-81-234-5678", "0812345678"),
            ("+66812345678", "0812345678"),
            ("66812345678", "0812345678"),
            ("66 9 1234 5678", "0912345678"),
        ] {
            assert_eq!(normalize_phone(raw).as_deref(), Some(want), "{raw:?}");
        }
    }

    #[test]
    fn phones_refuse_everything_that_is_not_a_thai_mobile() {
        for bad in [
            "0212345678",            // Bangkok landline (0 2x)
            "12345",                 // too short
            "",                      // nothing
            "   ",                   // still nothing
            "081234567",             // 9 digits only
            "08123456789",           // 11 digits
            "912345678",             // no leading 0 / country prefix
            "+66 2 123 4567",        // +66 landline
            "+66",                   // country prefix alone
            "081234567a",            // a letter
            "abcdefghij",            // not digits at all
            "๐๘๑๒๓๔๕๖๗๘",            // Thai digits are not stored digits
            "08-1234-5678 ext 5",    // trailing junk
        ] {
            assert_eq!(normalize_phone(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn names_are_trimmed_collapsed_and_bounded_in_characters() {
        assert_eq!(clean_name("  Somchai   Meechai ").as_deref(), Some("Somchai Meechai"));
        assert_eq!(clean_name("สมชาย ใจดี").as_deref(), Some("สมชาย ใจดี"));
        // 1..=60 CHARACTERS, not bytes: 60 Thai chars are 180 bytes and fit.
        let sixty: String = "ม".repeat(MAX_NAME_CHARS);
        assert_eq!(clean_name(&sixty).as_deref(), Some(sixty.as_str()));
        assert_eq!(clean_name(&sixty).map(|s| s.len()), Some(MAX_NAME_CHARS * 3));
        // Whitespace collapses before the bound is checked, so 30 + 1 + 29
        // single spaces still fit ...
        let spaced = format!("{} {}", "a".repeat(30), "b".repeat(29));
        assert_eq!(clean_name(&spaced).map(|s| s.chars().count()), Some(60));
        // ... but 61 characters (however many bytes) do not.
        assert_eq!(clean_name(&"m".repeat(MAX_NAME_CHARS + 1)), None);
        let over = format!("{}   {}", "a".repeat(30), "b".repeat(31));
        assert_eq!(clean_name(&over), None);
        // Empty / whitespace-only cannot be stored.
        assert_eq!(clean_name(""), None);
        assert_eq!(clean_name("   "), None);
        // Control characters never reach the DB.
        for control in ["Som\x00chai", "Som\nchai", "Som\tchai", "\u{7f}"] {
            assert_eq!(clean_name(control), None, "{control:?} must be refused");
        }
    }

    #[test]
    fn earn_is_one_point_per_hundred_baht_floored() {
        assert_eq!(earn_points(9_999), 0); // 99.99 ฿
        assert_eq!(earn_points(10_000), 1); // 100.00 ฿
        assert_eq!(earn_points(10_001), 1);
        assert_eq!(earn_points(19_999), 1);
        assert_eq!(earn_points(20_000), 2);
        assert_eq!(earn_points(25_000), 2); // 250.00 ฿
        // A free bill (or a nonsense negative one) earns nothing, never
        // fractional, never negative.
        assert_eq!(earn_points(0), 0);
        assert_eq!(earn_points(-10_000), 0);
        assert_eq!(earn_points(5_000), 0);
    }

    #[test]
    fn redemption_moves_in_whole_steps_of_ten_points() {
        // 250.00 ฿ subtotal: floor(25000/100) = 250 points of headroom, but
        // the balance of 100 caps the step.
        assert_eq!(max_redeemable(25_000, 100), 100);
        // The balance itself only leaves whole steps of 10 (15 -> one step).
        assert_eq!(max_redeemable(25_000, 15), 10);
        assert_eq!(max_redeemable(25_000, 20), 20);
        assert_eq!(max_redeemable(25_000, 9), 0);
        // A huge balance lets the bill be the cap: 45.00 ฿ is 45 points of
        // headroom -> 40.
        assert_eq!(max_redeemable(4_500, 1_000), 40);
        // The bill must cover the step: 10.00 ฿ exactly is one step, 9.99 ฿
        // is none, 19.99 ฿ is still one, 20.00 ฿ is two.
        assert_eq!(max_redeemable(1_000, 100), 10);
        assert_eq!(max_redeemable(999, 100), 0);
        assert_eq!(max_redeemable(1_999, 100), 10);
        assert_eq!(max_redeemable(2_000, 100), 20);
        // A free (or nonsense negative) bill redeems nothing at all.
        assert_eq!(max_redeemable(0, 100), 0);
        assert_eq!(max_redeemable(-5_000, 100), 0);
        assert_eq!(max_redeemable(25_000, 0), 0);
        assert_eq!(max_redeemable(25_000, -3), 0);
    }

    #[test]
    fn valid_redeem_is_zero_or_a_whole_step_within_the_bounds() {
        // 0 points is always fine: that is "no member on this bill".
        assert!(valid_redeem(0, 0, 0));
        let subtotal = 25_000; // 250.00 ฿: the balance caps each case below
        assert!(valid_redeem(10, subtotal, 20));
        assert!(valid_redeem(20, subtotal, 20));
        assert!(valid_redeem(10, subtotal, 1_000));
        // Not a step of 10, below the minimum, above the balance, above the
        // bill, or negative: all refused.
        assert!(!valid_redeem(5, subtotal, 20));
        assert!(!valid_redeem(15, subtotal, 20));
        assert!(!valid_redeem(25, subtotal, 20));
        assert!(!valid_redeem(20, subtotal, 19));
        assert!(!valid_redeem(-10, subtotal, 20));
        // A 45.00 ฿ bill gives 40 points of headroom (floor 45 -> 40).
        assert!(valid_redeem(40, 4_500, 100));
        assert!(!valid_redeem(50, 4_500, 100));
        // Less than 10.00 ฿ on the bill redeems nothing, whatever the card.
        assert!(!valid_redeem(10, 999, 1_000));
    }

    #[test]
    fn the_sweep_is_gated_to_one_utc_minute_per_hour() {
        const MINUTE: i64 = 60_000;
        // The :10 tick of any hour runs the sweep ...
        assert!(is_due(10 * MINUTE));
        assert!(is_due((24 * 60 + 10) * MINUTE));
        assert!(is_due((3 * 60 + 10) * MINUTE + 59_999));
        // ... and nothing before or after it does.
        assert!(!is_due(0));
        assert!(!is_due(9 * MINUTE));
        assert!(!is_due(9 * MINUTE + 59_999));
        assert!(!is_due(10 * MINUTE + 60_000)); // :11
        assert!(!is_due(69 * MINUTE)); // 01:09
        assert!(!is_due(1)); // sub-minute noise
    }

    #[test]
    fn settle_only_ever_touches_paid_counter_member_bills() {
        // The eligibility fragment every settle statement shares: no member
        // or not paid or a delivery bill or a staff meal -> all no-ops.
        for needle in [
            "customer_id IS NOT NULL",
            "status = 'paid'",
            "channel = 'counter'",
            "staff_meal = 0",
            "paid_at IS NOT NULL",
        ] {
            assert!(PAID_COUNTER_MEMBER.contains(needle), "lost guard {needle}");
        }
    }
}
