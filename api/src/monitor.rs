//! Outage-alert monitor (feat/monitoring, migration 0014, docs/monitoring.md).
//!
//! Runs inside the every-minute cron (`#[event(scheduled)]` in lib.rs) as a
//! third, ISOLATED job next to the slip and loyalty sweeps: `run`'s errors
//! are only `console_error!`'d by the caller and can never affect the other
//! jobs — and inside `run` each check is isolated from the next the same way
//! (a check that itself errors is logged and the loop moves on).
//!
//! Three checks per tick, each answered `(ok, detail)` where `detail` is a
//! short, secret-free string (no ids, no tokens, no error text):
//!
//! - `d1`         — `SELECT 1` through the D1 binding,
//! - `r2`         — `MEDIA.head("app/manifest.json")`; a MISSING object is
//!                  fine (the update flow uploads it, tests may not have), so
//!                  only a binding/IO error fails the check,
//! - `stuck_beam` — payments rows with `status='pending' AND beam_charge_id
//!                  IS NOT NULL` older than [`STUCK_AFTER_MS`] (15 min): a
//!                  Beam charge that never resolved, i.e. the customer may
//!                  have paid while our bill is still open. `detail` is the
//!                  COUNT only.
//!
//! Every tick also upserts the `cron_heartbeat` row (status ok,
//! updated_at=now), which `GET /api/health/deep` reads back: `cron=false`
//! there means the every-minute trigger itself stopped (cron config lost in
//! a deploy, account issue, ...) — see [`cron_alive`].
//!
//! Alert rules are PURE functions ([`decide`], [`next_state`], the message
//! builders) unit-tested on the host, with the state persisted per check in
//! `monitor_state`:
//!
//! - two CONSECUTIVE failing runs before the first alert, so a single blip
//!   (one D1 hiccup) alerts nobody ([`FAILS_BEFORE_ALERT`]),
//! - a reminder every [`REMINDER_EVERY_MS`] while the outage lasts,
//! - ONE "recovered" message when the check clears after an alert was sent,
//! - silence when a never-announced failure clears.
//!
//! Delivery is the optional secrets `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
//! (`env.secret`). Without either, the alert line is `console_log!`'d and
//! nothing else happens — monitoring must work (and never crash) unconfigured.
//! With both, one POST to the Telegram bot API sends the text. The token is
//! part of the request URL and therefore NEVER logged: a send failure is a
//! static `console_error!` line, nothing more.
//!
//! NOTE a full D1 outage cannot be announced from here by construction (the
//! `monitor_state` row can be neither read nor written either) — that case is
//! exactly what the external probe on `/api/health/deep` covers
//! (docs/monitoring.md).
#![allow(clippy::doc_overindented_list_items)]

use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::JsValue;
use worker::{console_error, console_log, Env, Fetch, Headers, Method, Request, RequestInit};

use crate::db;
use crate::error::ApiError;
use crate::util::{int, now_ms, opt_int, txt};

/// Check names (rows in `monitor_state`) and the special heartbeat row.
pub const CHECK_D1: &str = "d1";
pub const CHECK_R2: &str = "r2";
pub const CHECK_STUCK_BEAM: &str = "stuck_beam";
pub const HEARTBEAT: &str = "cron_heartbeat";

const CHECKS: [&str; 3] = [CHECK_D1, CHECK_R2, CHECK_STUCK_BEAM];

/// A payment is "stuck" when it was created strictly longer ago than this:
/// a pending Beam charge older than 15 minutes means Beam took (or thinks it
/// took) the money and never resolved our bill.
pub const STUCK_AFTER_MS: i64 = 15 * 60_000;
/// While a check keeps failing, remind every 30 minutes (measured from the
/// last message actually sent, so an alert just sent resets the clock).
pub const REMINDER_EVERY_MS: i64 = 30 * 60_000;
/// Consecutive failing runs required before the first alert (2 = one blip is
/// tolerated, the second failing run in a row alerts).
pub const FAILS_BEFORE_ALERT: i64 = 2;
/// `/api/health/deep` reports cron=false once the heartbeat is older than
/// 5 minutes (the cron fires every minute; a few missed ticks are noise).
pub const CRON_STALE_MS: i64 = 5 * 60_000;

/// The Thai hint appended to every `stuck_beam` message: what the shop should
/// DO while Beam is unreachable — take cash/transfer instead.
pub const STUCK_HINT: &str = "Beam อาจมีปัญหา — แจ้งร้านให้รับเงินสด/โอน";

/// `status` column values (migration 0014 CHECK constraint).
pub const STATUS_OK: &str = "ok";
pub const STATUS_FAILING: &str = "failing";

/// One check's outcome: healthy + a short, secret-free detail string.
pub type CheckResult = (bool, String);

/// The R2 object whose head proves the bucket binding answers. The object
/// itself may be absent (that is NOT a failure) — any key would do.
const R2_PROBE_KEY: &str = "app/manifest.json";

/// The stuck-payment query, kept as a constant so a test can pin its guards
/// (same pattern as `PAID_COUNTER_MEMBER` in loyalty.rs): strictly older than
/// the cutoff (`created_at < ?1`), pending, and a Beam charge.
const STUCK_SQL: &str = "SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE p.status = 'pending' AND p.beam_charge_id IS NOT NULL AND p.created_at < ?1
       AND o.status IN ('preparing', 'served')";

// ---------------------------------------------------------------------------
// Pure rules (unit-tested on the host, no D1 / worker types)
// ---------------------------------------------------------------------------

/// What `monitor_state` remembers about one check: the current status, the
/// length and start of the current streak, and when the last alert went out
/// (`None` = nothing sent for this streak — the marker `decide` uses to tell
/// "recover silently" from "announce the recovery").
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct State {
    pub status: String,
    pub fail_count: i64,
    pub since: i64,
    pub last_alert_at: Option<i64>,
}

impl State {
    pub fn is_failing(&self) -> bool {
        self.status == STATUS_FAILING
    }
}

/// What to send (if anything) for a check that just ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Say nothing (first failure of a streak, blip tolerated, reminder not
    /// due yet, or steady ok).
    None,
    /// The streak reached [`FAILS_BEFORE_ALERT`] — announce the outage.
    AlertFailing,
    /// Still failing and the last message is [`REMINDER_EVERY_MS`] old.
    Reminder,
    /// Back to ok after an alert was sent — announce it once.
    AlertRecovered,
}

/// Should this run send anything? Pure: `prev` is the stored state (absent on
/// the very first run), `now_ok` this run's outcome, `now_ms` the run's clock.
///
/// - ok now: announce [`Action::AlertRecovered`] only if the check WAS failing
///   AND an alert went out for that streak; a failure that never alerted
///   recovers silently.
/// - failing now, was ok/absent: [`Action::None`] — the streak begins (its
///   first failing run; `next_state` records fail_count 1).
/// - failing now, was failing: alert once the streak reaches
///   [`FAILS_BEFORE_ALERT`]; after that, [`Action::Reminder`] only when the
///   last sent message is [`REMINDER_EVERY_MS`] old.
pub fn decide(prev: Option<&State>, now_ok: bool, now_ms: i64) -> Action {
    let Some(p) = prev else {
        return Action::None;
    };
    if now_ok {
        return if p.is_failing() && p.last_alert_at.is_some() {
            Action::AlertRecovered
        } else {
            Action::None
        };
    }
    if !p.is_failing() {
        return Action::None; // first failing run of a new streak
    }
    match p.last_alert_at {
        // Nothing sent yet for this streak: wait for the Nth consecutive fail.
        None if p.fail_count + 1 >= FAILS_BEFORE_ALERT => Action::AlertFailing,
        None => Action::None,
        // Already announced: remind on a timer, measured from the last send.
        Some(last) if now_ms - last >= REMINDER_EVERY_MS => Action::Reminder,
        Some(_) => Action::None,
    }
}

/// The state to persist for this run: `prev` the stored state (absent on the
/// first run), `now_ok` this run's outcome, `action` what `decide` said, and
/// `now_ms` the run's clock. An ok run resets the streak (and clears
/// `last_alert_at`, so a later streak starts unannounced); a failing run
/// counts one more fail, keeps the streak's `since`, and stamps
/// `last_alert_at` exactly when a message was sent.
pub fn next_state(prev: Option<&State>, now_ok: bool, action: Action, now_ms: i64) -> State {
    if now_ok {
        return State {
            status: STATUS_OK.to_owned(),
            fail_count: 0,
            since: now_ms,
            last_alert_at: None,
        };
    }
    let (fail_count, since, last_alert_at) = match prev {
        Some(p) if p.is_failing() => (p.fail_count + 1, p.since, p.last_alert_at),
        _ => (1, now_ms, None), // the streak starts with this run
    };
    let last_alert_at = if matches!(action, Action::AlertFailing | Action::Reminder) {
        Some(now_ms)
    } else {
        last_alert_at
    };
    State {
        status: STATUS_FAILING.to_owned(),
        fail_count,
        since,
        last_alert_at,
    }
}

/// Cutoff for [`STUCK_SQL`]: bills created strictly before this are stuck.
pub fn stuck_cutoff(now_ms: i64) -> i64 {
    now_ms - STUCK_AFTER_MS
}

/// Is a `cron_heartbeat.updated_at` still fresh? Missing (`None`) or older
/// than [`CRON_STALE_MS`] means the cron is not running.
pub fn cron_alive(last_beat: Option<i64>, now_ms: i64) -> bool {
    match last_beat {
        Some(t) => now_ms - t <= CRON_STALE_MS,
        None => false,
    }
}

/// Whole minutes a streak has lasted (rounded down, never negative) — the
/// number the reminder message shows.
pub fn outage_minutes(since: i64, now_ms: i64) -> i64 {
    (now_ms - since).max(0) / 60_000
}

/// "🔴 rice-pos: <check> failing — <detail>", plus the cash/transfer hint
/// when it is the stuck-Beam check.
pub fn alert_failing_text(check: &str, detail: &str) -> String {
    let mut text = format!("🔴 rice-pos: {check} failing — {detail}");
    if check == CHECK_STUCK_BEAM {
        text.push('\n');
        text.push_str(STUCK_HINT);
    }
    text
}

/// "⏰ rice-pos: still failing (<minutes> min): <check> — <detail>".
pub fn reminder_text(check: &str, detail: &str, minutes: i64) -> String {
    let mut text = format!("⏰ rice-pos: still failing ({minutes} min): {check} — {detail}");
    if check == CHECK_STUCK_BEAM {
        text.push('\n');
        text.push_str(STUCK_HINT);
    }
    text
}

/// "🟢 rice-pos: <check> recovered".
pub fn recovered_text(check: &str) -> String {
    format!("🟢 rice-pos: {check} recovered")
}

/// The message for an action: pure, and only ever built from check name,
/// secret-free detail and streak clock.
fn message(action: Action, check: &str, detail: &str, minutes: i64) -> String {
    match action {
        Action::None => String::new(),
        Action::AlertFailing => alert_failing_text(check, detail),
        Action::Reminder => reminder_text(check, detail, minutes),
        Action::AlertRecovered => recovered_text(check),
    }
}

// ---------------------------------------------------------------------------
// Probes (thin: the Workers bindings, error-safe, never leak into details)
// ---------------------------------------------------------------------------

/// D1 answers a trivial query?
pub async fn check_d1(env: &Env) -> CheckResult {
    match d1_probe(env).await {
        Ok(_) => (true, "ok".to_owned()),
        Err(_) => (false, "unavailable".to_owned()),
    }
}

async fn d1_probe(env: &Env) -> Result<i64, ApiError> {
    db::db(env)?
        .prepare("SELECT 1 AS one")
        .first::<i64>(None)
        .await?
        .ok_or_else(|| ApiError::Internal("SELECT 1 returned no row".into()))
}

/// The R2 binding answers a HEAD (the object itself may be missing).
pub async fn check_r2(env: &Env) -> CheckResult {
    match r2_probe(env).await {
        Ok(()) => (true, "ok".to_owned()),
        Err(_) => (false, "io error".to_owned()),
    }
}

async fn r2_probe(env: &Env) -> Result<(), ApiError> {
    // Ok(None) — object absent — is a PASS: only binding/IO errors fail.
    db::media(env)?.head(R2_PROBE_KEY).await.map(|_| ())?;
    Ok(())
}

/// How many payments are stuck (pending Beam charge, older than the cutoff)?
/// The detail is the COUNT only; a query error fails the check as "unknown".
pub async fn check_stuck_beam(env: &Env, now: i64) -> CheckResult {
    match stuck_count(env, stuck_cutoff(now)).await {
        Ok(n) => (n <= 0, n.to_string()),
        Err(_) => (false, "unknown".to_owned()),
    }
}

async fn stuck_count(env: &Env, cutoff: i64) -> Result<i64, ApiError> {
    db::db(env)?
        .prepare(STUCK_SQL)
        .bind(&[int(cutoff)])?
        .first::<i64>(Some("n"))
        .await?
        .ok_or_else(|| ApiError::Internal("COUNT returned no row".into()))
}

/// Is the cron heartbeat fresh? Used by `GET /api/health/deep`.
pub async fn heartbeat_alive(env: &Env) -> bool {
    cron_alive(heartbeat_at(env).await.ok().flatten(), now_ms())
}

async fn heartbeat_at(env: &Env) -> Result<Option<i64>, ApiError> {
    db::db(env)?
        .prepare("SELECT updated_at FROM monitor_state WHERE check_name = ?1")
        .bind(&[txt(HEARTBEAT)])?
        .first::<i64>(Some("updated_at"))
        .await
        .map_err(|e| ApiError::Internal(format!("monitor_state heartbeat read: {e:?}")))
}

// ---------------------------------------------------------------------------
// Cron entry point
// ---------------------------------------------------------------------------

/// One cron tick: heartbeat upsert first (so `/api/health/deep` sees the cron
/// is alive even when every check errors), then each check isolated from the
/// others — a check that errors is logged and the loop moves on. Never
/// panics; the caller (lib.rs) only `console_error!`s our `Err`s.
pub async fn run(env: &Env) -> Result<(), ApiError> {
    let now = now_ms();
    if let Err(e) = write_heartbeat(env, now).await {
        console_error!("monitor: cron heartbeat write failed: {e:?}");
    }
    for check in CHECKS {
        if let Err(e) = run_check(env, check, now).await {
            console_error!("monitor: check '{check}' failed: {e:?}");
        }
    }
    Ok(())
}

/// Probe one check, decide + send the alert, persist the state.
async fn run_check(env: &Env, check: &str, now: i64) -> Result<(), ApiError> {
    let (ok, detail) = probe(env, check, now).await;
    let prev = load_state(env, check).await?;
    let action = decide(prev.as_ref(), ok, now);
    if action != Action::None {
        let minutes = outage_minutes(prev.as_ref().map_or(now, |p| p.since), now);
        let text = message(action, check, &detail, minutes);
        dispatch_alert(env, &text).await;
    }
    let state = next_state(prev.as_ref(), ok, action, now);
    persist_state(env, check, &state, &detail, now).await?;
    Ok(())
}

async fn probe(env: &Env, check: &str, now: i64) -> CheckResult {
    match check {
        CHECK_D1 => check_d1(env).await,
        CHECK_R2 => check_r2(env).await,
        CHECK_STUCK_BEAM => check_stuck_beam(env, now).await,
        _ => (false, "unknown check".to_owned()),
    }
}

async fn load_state(env: &Env, check: &str) -> Result<Option<State>, ApiError> {
    db::db(env)?
        .prepare(
            "SELECT status, fail_count, since, last_alert_at
             FROM monitor_state WHERE check_name = ?1",
        )
        .bind(&[txt(check)])?
        .first::<State>(None)
        .await
        .map_err(|e| ApiError::Internal(format!("monitor_state read: {e:?}")))
}

async fn persist_state(
    env: &Env,
    check: &str,
    state: &State,
    detail: &str,
    now: i64,
) -> Result<(), ApiError> {
    db::db(env)?
        .prepare(
            "INSERT INTO monitor_state
               (check_name, status, fail_count, since, last_alert_at, detail, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(check_name) DO UPDATE SET
               status = excluded.status,
               fail_count = excluded.fail_count,
               since = excluded.since,
               last_alert_at = excluded.last_alert_at,
               detail = excluded.detail,
               updated_at = excluded.updated_at",
        )
        .bind(&[
            txt(check),
            txt(&state.status),
            int(state.fail_count),
            int(state.since),
            opt_int(state.last_alert_at),
            txt(detail),
            int(now),
        ])?
        .run()
        .await
        .map_err(|e| ApiError::Internal(format!("monitor_state write: {e:?}")))?;
    Ok(())
}

/// Every tick: the heartbeat row that `/api/health/deep` (and any operator
/// peeking at the table) reads back.
async fn write_heartbeat(env: &Env, now: i64) -> Result<(), ApiError> {
    db::db(env)?
        .prepare(
            "INSERT INTO monitor_state
               (check_name, status, fail_count, since, last_alert_at, detail, updated_at)
             VALUES (?1, 'ok', 0, ?2, NULL, NULL, ?2)
             ON CONFLICT(check_name) DO UPDATE SET
               status = 'ok', fail_count = 0, last_alert_at = NULL, detail = NULL,
               since = ?2, updated_at = ?2",
        )
        .bind(&[txt(HEARTBEAT), int(now)])?
        .run()
        .await
        .map_err(|e| ApiError::Internal(format!("monitor_state heartbeat: {e:?}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Telegram delivery (optional; must never crash or leak the token)
// ---------------------------------------------------------------------------

const TELEGRAM_TOKEN_VAR: &str = "TELEGRAM_BOT_TOKEN";
const TELEGRAM_CHAT_VAR: &str = "TELEGRAM_CHAT_ID";

/// Both Telegram secrets, or `None` when either is absent/empty (monitoring
/// still runs — the alert just goes to the log instead).
fn telegram_creds(env: &Env) -> Option<(String, String)> {
    let token = env.secret(TELEGRAM_TOKEN_VAR).ok()?.to_string();
    let chat_id = env.secret(TELEGRAM_CHAT_VAR).ok()?.to_string();
    (!token.trim().is_empty() && !chat_id.trim().is_empty()).then_some((token, chat_id))
}

/// Send one message. Without the secrets: `console_log!` the alert line and
/// stop. With them: one POST to the bot API — the token is part of the URL,
/// so neither it nor the URL is EVER logged; a failure at any step is a
/// single static `console_error!` line (the next reminder retries anyway).
async fn dispatch_alert(env: &Env, text: &str) {
    let Some((token, chat_id)) = telegram_creds(env) else {
        console_log!("monitor alert: {text}");
        return;
    };
    let body = json!({ "chat_id": chat_id, "text": text }).to_string();
    let headers = Headers::new();
    if headers.set("Content-Type", "application/json").is_err() {
        console_error!("monitor: telegram send failed");
        return;
    }
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(JsValue::from_str(&body)));
    // Never log this URL or the request — both contain the token.
    let request = Request::new_with_init(
        &format!("https://api.telegram.org/bot{token}/sendMessage"),
        &init,
    );
    let sent = match request {
        Ok(req) => Fetch::Request(req).send().await,
        Err(_) => {
            console_error!("monitor: telegram send failed");
            return;
        }
    };
    match sent {
        Ok(resp) if (200..300).contains(&resp.status_code()) => {}
        _ => console_error!("monitor: telegram send failed"),
    }
}

// ---------------------------------------------------------------------------
// Host unit tests (pure fns only — the D1/R2/fetch parts stay thin above)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const T0: i64 = 1_700_000_000_000;

    fn ok_state(now: i64) -> State {
        State {
            status: STATUS_OK.to_owned(),
            fail_count: 0,
            since: now,
            last_alert_at: None,
        }
    }

    fn failing(fail_count: i64, since: i64, last_alert_at: Option<i64>) -> State {
        State {
            status: STATUS_FAILING.to_owned(),
            fail_count,
            since,
            last_alert_at,
        }
    }

    #[test]
    fn constants_are_the_documented_windows() {
        assert_eq!(FAILS_BEFORE_ALERT, 2);
        assert_eq!(REMINDER_EVERY_MS, 30 * MIN);
        assert_eq!(STUCK_AFTER_MS, 15 * MIN);
        assert_eq!(CRON_STALE_MS, 5 * MIN);
    }

    #[test]
    fn the_first_failing_run_is_silent() {
        // No state at all (first ever run) or a previously ok check: the
        // streak begins, nothing is sent — one blip must not wake anybody.
        assert_eq!(decide(None, false, T0), Action::None);
        assert_eq!(decide(Some(&ok_state(T0)), false, T0), Action::None);
    }

    #[test]
    fn the_second_consecutive_failing_run_alerts() {
        let first = failing(1, T0, None); // one failing run recorded, no alert
        assert_eq!(decide(Some(&first), false, T0 + MIN), Action::AlertFailing);
    }

    #[test]
    fn a_single_blip_that_clears_never_alerts() {
        // fail once -> silent; ok -> silent; fail again -> that is the FIRST
        // fail of a NEW streak, not the second consecutive one.
        let after_fail = next_state(Some(&ok_state(T0)), false, Action::None, T0 + MIN);
        assert_eq!(decide(Some(&after_fail), true, T0 + 2 * MIN), Action::None);
        let reset = next_state(Some(&after_fail), true, Action::None, T0 + 2 * MIN);
        assert_eq!(reset.fail_count, 0);
        assert_eq!(decide(Some(&reset), false, T0 + 3 * MIN), Action::None);
    }

    #[test]
    fn reminders_come_every_30_minutes_not_before() {
        let last_alert = T0 + 2 * MIN;
        let state = failing(5, T0, Some(last_alert));
        // 29 minutes after the last message: stay quiet.
        assert_eq!(
            decide(Some(&state), false, last_alert + 29 * MIN),
            Action::None
        );
        // exactly 30 minutes: remind ...
        assert_eq!(
            decide(Some(&state), false, last_alert + 30 * MIN),
            Action::Reminder
        );
        // ... and keep reminding while it stays down.
        assert_eq!(
            decide(Some(&state), false, last_alert + 45 * MIN),
            Action::Reminder
        );
    }

    #[test]
    fn recovery_after_an_alert_is_announced_once() {
        let announced = failing(2, T0, Some(T0 + MIN));
        assert_eq!(
            decide(Some(&announced), true, T0 + 5 * MIN),
            Action::AlertRecovered
        );
        // The ok run resets the state, so the next ok run is quiet again.
        let reset = next_state(Some(&announced), true, Action::AlertRecovered, T0 + 5 * MIN);
        assert_eq!(decide(Some(&reset), true, T0 + 6 * MIN), Action::None);
    }

    #[test]
    fn recovery_without_an_alert_is_silent() {
        // Failed once (never announced) and came back: nobody was told it
        // broke, nobody is told it healed.
        let blip = failing(1, T0, None);
        assert_eq!(decide(Some(&blip), true, T0 + MIN), Action::None);
    }

    #[test]
    fn steady_ok_is_quiet() {
        assert_eq!(decide(None, true, T0), Action::None);
        assert_eq!(decide(Some(&ok_state(T0)), true, T0), Action::None);
    }

    #[test]
    fn next_state_tracks_the_streak_and_the_last_send() {
        // ok -> fail: the streak starts at 1, since = now, nothing sent.
        let first = next_state(Some(&ok_state(T0)), false, Action::None, T0 + MIN);
        assert_eq!(first, failing(1, T0 + MIN, None));
        // fail -> fail: the streak grows, `since` is preserved.
        let second = next_state(Some(&first), false, Action::None, T0 + 2 * MIN);
        assert_eq!(second, failing(2, T0 + MIN, None));
        // the run that alerts stamps last_alert_at ...
        let alerted = next_state(Some(&second), false, Action::AlertFailing, T0 + 3 * MIN);
        assert_eq!(alerted, failing(3, T0 + MIN, Some(T0 + 3 * MIN)));
        // ... and so does a reminder (it resets the 30-minute clock).
        let reminded = next_state(Some(&alerted), false, Action::Reminder, T0 + 35 * MIN);
        assert_eq!(reminded, failing(4, T0 + MIN, Some(T0 + 35 * MIN)));
        // ok: full reset, alert marker cleared for the next streak.
        let reset = next_state(Some(&reminded), true, Action::AlertRecovered, T0 + 40 * MIN);
        assert_eq!(reset, ok_state(T0 + 40 * MIN));
        // A first-ever failing run starts a streak of 1 on its own.
        assert_eq!(next_state(None, false, Action::None, T0), failing(1, T0, None));
    }

    #[test]
    fn stuck_cutoff_is_fifteen_minutes_back() {
        assert_eq!(stuck_cutoff(T0), T0 - 15 * MIN);
        // The SQL pins the three guards: pending, a Beam charge, and STRICTLY
        // older than the bound cutoff (`<`, so exactly 15:00 old is not stuck).
        for needle in [
            "status = 'pending'",
            "beam_charge_id IS NOT NULL",
            "created_at < ?1",
            "o.status IN ('preparing', 'served')",
            "o.status IN ('preparing', 'served')",
        ] {
            assert!(STUCK_SQL.contains(needle), "lost guard {needle}");
        }
    }

    #[test]
    fn heartbeat_is_fresh_for_five_minutes() {
        assert!(cron_alive(Some(T0), T0));
        assert!(cron_alive(Some(T0), T0 + 5 * MIN)); // not OLDER than 5 min
        assert!(!cron_alive(Some(T0), T0 + 5 * MIN + 1));
        assert!(!cron_alive(Some(T0), T0 + 6 * MIN));
        // A missing heartbeat row means the cron never ran: not alive.
        assert!(!cron_alive(None, T0));
    }

    #[test]
    fn outage_minutes_round_down_and_never_go_negative() {
        assert_eq!(outage_minutes(T0, T0), 0);
        assert_eq!(outage_minutes(T0, T0 + 90 * MIN), 90);
        assert_eq!(outage_minutes(T0, T0 + 89 * MIN + 59_999), 89);
        // clock skew / stored future stamps must not print a negative age
        assert_eq!(outage_minutes(T0, T0 - 10 * MIN), 0);
    }

    #[test]
    fn failing_and_reminder_messages_have_the_expected_text() {
        assert_eq!(
            alert_failing_text("d1", "unavailable"),
            "🔴 rice-pos: d1 failing — unavailable"
        );
        assert_eq!(
            reminder_text("d1", "unavailable", 45),
            "⏰ rice-pos: still failing (45 min): d1 — unavailable"
        );
        assert_eq!(recovered_text("r2"), "🟢 rice-pos: r2 recovered");
    }

    #[test]
    fn stuck_beam_messages_carry_the_cash_transfer_hint() {
        let text = alert_failing_text(CHECK_STUCK_BEAM, "3");
        assert!(text.starts_with("🔴 rice-pos: stuck_beam failing — 3\n"));
        assert!(text.contains(STUCK_HINT));
        assert!(reminder_text(CHECK_STUCK_BEAM, "2", 30).contains(STUCK_HINT));
        // Other checks never carry the Beam hint.
        assert!(!alert_failing_text(CHECK_D1, "unavailable").contains("Beam"));
        assert!(!alert_failing_text(CHECK_R2, "io error").contains("Beam"));
        // Recovery is a plain one-liner, hint included nowhere.
        assert_eq!(
            recovered_text(CHECK_STUCK_BEAM),
            "🟢 rice-pos: stuck_beam recovered"
        );
    }

    #[test]
    fn messages_never_contain_secrets_or_urls() {
        for text in [
            alert_failing_text(CHECK_D1, "unavailable"),
            alert_failing_text(CHECK_STUCK_BEAM, "7"),
            reminder_text(CHECK_STUCK_BEAM, "7", 120),
            recovered_text(CHECK_STUCK_BEAM),
        ] {
            assert!(!text.contains("api.telegram.org"), "{text}");
            assert!(!text.to_ascii_lowercase().contains("token"), "{text}");
            assert!(!text.contains("http"), "{text}");
            assert!(!text.contains("chat_id"), "{text}");
        }
    }
}
