//! Purchase-receipt ("slip") reader — phase 1: upload, reader gateway, status.
//!
//! The owner photographs a supplier receipt; an AI turns it into JSON lines
//! (phase 2 turns those into stock restocks). Reader priority (the gateway):
//!
//! 1. LOCAL — a Node agent on the owner's PC (tools/slip-agent) running Ollama.
//!    It PULLS work (`/api/slip-agent/claim`), so the PC needs no inbound port.
//!    Online = heartbeat seen within [`LOCAL_ONLINE_MS`].
//! 2. CLOUD — Workers AI, only while today's neuron budget lasts. Workers AI
//!    bills past the free 10,000 neurons/day, so the app caps itself at
//!    [`CLOUD_DAILY_NEURON_CAP`] with an atomic reservation (like R2 in
//!    [`crate::media`]).
//! 3. Neither — the slip stays `queued`; the UI tells the owner to switch the
//!    PC on. The agent drains the queue as soon as it comes up, and the cron
//!    sweep retries the cloud when the budget resets (00:00 UTC).
//!
//! Status machine: draft -> queued -> reading(local|cloud) -> read | failed.
//! A failed read goes back to `queued` until [`MAX_ATTEMPTS`] claims were used.
//! A local claim is a lease ([`LOCAL_LEASE_MS`]): an agent that dies mid-read
//! loses the slip back to the queue; a cloud read stuck past
//! [`CLOUD_STUCK_MS`] (isolate killed mid-request) likewise.

pub mod cloud;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use worker::Env;

use crate::routes::orders::changes;
use crate::util::{int, now_ms, opt_int, txt};
use crate::{db, error::ApiError};

pub const LOCAL_ONLINE_MS: i64 = 30_000;
pub const LOCAL_LEASE_MS: i64 = 300_000;
pub const CLOUD_STUCK_MS: i64 = 600_000;
pub const MAX_ATTEMPTS: i64 = 3;
pub const MAX_PAGES: i64 = 4;
pub const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;

pub const CLOUD_MODEL: &str = "@cf/qwen/qwen3.8-27b";
pub const CLOUD_DAILY_NEURON_CAP: f64 = 8000.0;
/// Reserved per page before a cloud call, settled to the real usage after.
/// Measured on real slips: 160-400 neurons for one page.
pub const CLOUD_EST_NEURONS_PER_PAGE: f64 = 500.0;

/// Workers AI price of [`CLOUD_MODEL`] in neurons: ($/M tokens) / ($0.011 per 1000 neurons).
pub fn neurons_for(prompt_tokens: f64, completion_tokens: f64) -> f64 {
    (prompt_tokens * 0.45 + completion_tokens * 3.2) / 11.0
}

/// Single source of truth for both readers; the local agent gets it from `/claim`.
pub const PROMPT: &str = r#"You read Thai purchase receipts/slips for a small rice & noodle restaurant (Makro, Betagro, Lotus, market vendors, handwritten notes). The photo may be rotated. If several images are given they are pages of ONE receipt.
Return ONLY a JSON object, no prose, no markdown fences:
{"store": string|null, "date": "YYYY-MM-DD"|null, "receipt_no": string|null, "lines": [{"code": string|null, "name": string, "qty": number|null, "unit": string|null, "unit_price": number|null, "total": number|null}], "discount": number|null, "grand_total": number|null}
Rules: copy item names exactly as printed/written (Thai). "code" = the printed article/product number if any. One entry per purchased item only; do NOT add subtotal, total, discount, tax, payment or delivery-method rows as lines (put a discount amount in "discount"). A delivery fee (ค่ารถ/ค่าส่ง) is a line. Thai Buddhist years (2569) -> convert to CE (2026). If a value is unreadable use null."#;

/// R2 key of one page image. Private: never reachable through `/api/media/*`
/// (`valid_media_key` only accepts `menu/...`).
pub fn page_key(shop_id: &str, slip_id: &str, page: i64) -> String {
    format!("slips/{shop_id}/{slip_id}/{page}.jpg")
}

/// 'YYYY-MM-DD' (UTC) — the Workers AI free-allocation day.
pub fn day_key(now_ms: i64) -> String {
    let z = now_ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

pub const SLIP_COLS: &str = "id, shop_id, page_count, status, reader, attempts, result_json, \
     error, submitted_at, read_at, created_at";

#[derive(Debug, Deserialize)]
pub struct SlipRow {
    pub id: String,
    pub shop_id: String,
    pub page_count: i64,
    pub status: String,
    pub reader: Option<String>,
    pub attempts: i64,
    pub result_json: Option<String>,
    pub error: Option<String>,
    pub submitted_at: Option<i64>,
    pub read_at: Option<i64>,
    pub created_at: i64,
}

impl SlipRow {
    pub fn to_json(&self) -> Value {
        let result = self
            .result_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok());
        json!({
            "id": self.id,
            "shop_id": self.shop_id,
            "status": self.status,
            "reader": self.reader,
            "page_count": self.page_count,
            "attempts": self.attempts,
            "error": self.error,
            "result": result,
            "submitted_at": self.submitted_at,
            "read_at": self.read_at,
            "created_at": self.created_at,
        })
    }
}

pub async fn load_slip(env: &Env, id: &str) -> Result<Option<SlipRow>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!("SELECT {SLIP_COLS} FROM slips WHERE id = ?1"))
        .bind(&[txt(id)])?
        .first::<SlipRow>(None)
        .await?)
}

// ---------------------------------------------------------------------------
// Reader state + neuron budget
// ---------------------------------------------------------------------------

pub async fn local_seen_at(env: &Env) -> Result<Option<i64>, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT seen_at FROM slip_reader_heartbeat WHERE id = 'local'")
        .first::<i64>(Some("seen_at"))
        .await?)
}

pub fn is_online(seen_at: Option<i64>, now: i64) -> bool {
    seen_at.is_some_and(|t| now - t <= LOCAL_ONLINE_MS)
}

pub async fn local_online(env: &Env) -> Result<bool, ApiError> {
    Ok(is_online(local_seen_at(env).await?, now_ms()))
}

pub async fn touch_heartbeat(env: &Env, info: Option<&str>) -> Result<(), ApiError> {
    let info = info.map(|s| s.chars().take(200).collect::<String>());
    db::db(env)?
        .prepare(
            "INSERT INTO slip_reader_heartbeat (id, seen_at, info) VALUES ('local', ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET seen_at = ?1, info = COALESCE(?2, info)",
        )
        .bind(&[int(now_ms()), info.as_deref().map(txt).unwrap_or(wasm_bindgen::JsValue::NULL)])?
        .run()
        .await?;
    Ok(())
}

pub async fn neurons_today(env: &Env) -> Result<f64, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT neurons FROM ai_usage WHERE day = ?1")
        .bind(&[txt(&day_key(now_ms()))])?
        .first::<f64>(Some("neurons"))
        .await?
        .unwrap_or(0.0))
}

/// Atomically reserve `est` neurons for today; false when it would pass the cap.
pub async fn reserve_neurons(env: &Env, day: &str, est: f64) -> Result<bool, ApiError> {
    let result = db::db(env)?
        .prepare(
            "INSERT INTO ai_usage (day, neurons, calls) SELECT ?1, ?2, 0 WHERE ?2 <= ?3
             ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?2 WHERE neurons + ?2 <= ?3",
        )
        .bind(&[txt(day), est.into(), CLOUD_DAILY_NEURON_CAP.into()])?
        .run()
        .await?;
    Ok(changes(&result)? > 0)
}

/// Replace a reservation by the real usage (`actual`; 0 releases it).
pub async fn settle_neurons(env: &Env, day: &str, est: f64, actual: f64, called: bool) -> Result<(), ApiError> {
    db::db(env)?
        .prepare(
            "UPDATE ai_usage SET neurons = MAX(0, neurons - ?2 + ?3), calls = calls + ?4 WHERE day = ?1",
        )
        .bind(&[txt(day), est.into(), actual.into(), int(i64::from(called))])?
        .run()
        .await?;
    Ok(())
}

pub async fn reader_state(env: &Env, shop_id: &str) -> Result<Value, ApiError> {
    let now = now_ms();
    let seen = local_seen_at(env).await?;
    let used = neurons_today(env).await?;
    let waiting = db::db(env)?
        .prepare("SELECT COUNT(*) AS n FROM slips WHERE shop_id = ?1 AND status = 'queued'")
        .bind(&[txt(shop_id)])?
        .first::<i64>(Some("n"))
        .await?
        .unwrap_or(0);
    Ok(json!({
        "local_online": is_online(seen, now),
        "local_seen_at": seen,
        "cloud_neurons_today": used.round(),
        "cloud_cap": CLOUD_DAILY_NEURON_CAP,
        "cloud_available": CLOUD_DAILY_NEURON_CAP - used >= CLOUD_EST_NEURONS_PER_PAGE,
        "waiting_count": waiting,
    }))
}

// ---------------------------------------------------------------------------
// Queue transitions (all conditional UPDATEs: concurrent claims never collide)
// ---------------------------------------------------------------------------

/// Rows a reader may take: queued, or a local lease that expired, or a cloud
/// read that has been "reading" for too long (isolate died). `?1` = now.
const CLAIMABLE: &str = "(status = 'queued'
    OR (status = 'reading' AND reader = 'local' AND lease_until < ?1)
    OR (status = 'reading' AND reader = 'cloud' AND updated_at < ?1 - 600000))";

#[derive(Debug, Deserialize)]
pub struct Claimed {
    pub id: String,
    pub shop_id: String,
    pub page_count: i64,
}

/// Claim the oldest claimable slip for `reader` ("local" | "cloud").
pub async fn claim_next(env: &Env, reader: &str) -> Result<Option<Claimed>, ApiError> {
    let now = now_ms();
    let lease = (reader == "local").then_some(now + LOCAL_LEASE_MS);
    Ok(db::db(env)?
        .prepare(format!(
            "UPDATE slips SET status = 'reading', reader = ?2, lease_until = ?3,
                    attempts = attempts + 1, error = NULL, updated_at = ?1
             WHERE id = (SELECT id FROM slips WHERE {CLAIMABLE} ORDER BY submitted_at LIMIT 1)
               AND {CLAIMABLE}
             RETURNING id, shop_id, page_count"
        ))
        .bind(&[int(now), txt(reader), opt_int(lease)])?
        .first::<Claimed>(None)
        .await?)
}

/// Claim one specific slip for the cloud reader (submit path).
pub async fn claim_for_cloud(env: &Env, id: &str) -> Result<Option<Claimed>, ApiError> {
    let now = now_ms();
    Ok(db::db(env)?
        .prepare(format!(
            "UPDATE slips SET status = 'reading', reader = 'cloud', lease_until = NULL,
                    attempts = attempts + 1, error = NULL, updated_at = ?1
             WHERE id = ?2 AND {CLAIMABLE}
             RETURNING id, shop_id, page_count"
        ))
        .bind(&[int(now), txt(id)])?
        .first::<Claimed>(None)
        .await?)
}

/// Oldest claimable slip (id, page_count) without claiming it — the sweep
/// needs the page count to size the neuron reservation first.
pub async fn peek_next(env: &Env) -> Result<Option<Claimed>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!(
            "SELECT id, shop_id, page_count FROM slips WHERE {CLAIMABLE} ORDER BY submitted_at LIMIT 1"
        ))
        .bind(&[int(now_ms())])?
        .first::<Claimed>(None)
        .await?)
}

/// Store a reader's outcome. Only applies while the slip is still `reading`
/// by that `reader`; false otherwise (lease lost / already finished).
pub async fn finish(
    env: &Env,
    id: &str,
    reader: &str,
    outcome: Result<Value, String>,
) -> Result<bool, ApiError> {
    let now = now_ms();
    let stmt = match outcome {
        Ok(result) => db::db(env)?
            .prepare(
                "UPDATE slips SET status = 'read', result_json = ?3, error = NULL, read_at = ?4,
                        lease_until = NULL, updated_at = ?4
                 WHERE id = ?1 AND status = 'reading' AND reader = ?2",
            )
            .bind(&[txt(id), txt(reader), txt(&result.to_string()), int(now)])?,
        Err(error) => {
            let error: String = error.chars().take(500).collect();
            db::db(env)?
                .prepare(
                    "UPDATE slips SET
                        status = CASE WHEN attempts >= ?5 THEN 'failed' ELSE 'queued' END,
                        reader = CASE WHEN attempts >= ?5 THEN reader ELSE NULL END,
                        error = ?3, lease_until = NULL, updated_at = ?4
                     WHERE id = ?1 AND status = 'reading' AND reader = ?2",
                )
                .bind(&[txt(id), txt(reader), txt(&error), int(now), int(MAX_ATTEMPTS)])?
        }
    };
    Ok(changes(&stmt.run().await?)? > 0)
}

/// Cron (every minute): return dead leases to the queue so the UI shows the
/// truth, then — only if the PC is offline — let the cloud take up to 2 slips.
pub async fn sweep(env: &Env) -> Result<(), ApiError> {
    let now = now_ms();
    db::db(env)?
        .prepare(
            "UPDATE slips SET
                status = CASE WHEN attempts >= ?2 THEN 'failed' ELSE 'queued' END,
                error = COALESCE(error, 'reader stopped responding'),
                reader = CASE WHEN attempts >= ?2 THEN reader ELSE NULL END,
                lease_until = NULL, updated_at = ?1
             WHERE status = 'reading' AND (
                (reader = 'local' AND lease_until < ?1) OR
                (reader = 'cloud' AND updated_at < ?1 - ?3))",
        )
        .bind(&[int(now), int(MAX_ATTEMPTS), int(CLOUD_STUCK_MS)])?
        .run()
        .await?;
    if local_online(env).await? {
        return Ok(());
    }
    for _ in 0..2 {
        let Some(next) = peek_next(env).await? else { break };
        if !cloud::read_if_budget(env, &next.id, next.page_count).await? {
            break; // budget exhausted (or someone else took it): try next minute
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reader output validation
// ---------------------------------------------------------------------------

fn num_or_null(v: Option<&Value>, field: &str) -> Result<Value, String> {
    match v {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::Number(n)) => Ok(Value::Number(n.clone())),
        Some(Value::String(s)) => {
            let cleaned: String = s.chars().filter(|c| !matches!(c, ',' | ' ' | '฿')).collect();
            if cleaned.is_empty() || cleaned == "-" {
                return Ok(Value::Null);
            }
            cleaned
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .ok_or_else(|| format!("{field}: not a number: {s:?}"))
        }
        Some(other) => Err(format!("{field}: not a number: {other}")),
    }
}

fn str_or_null(v: Option<&Value>, field: &str) -> Result<Value, String> {
    match v {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Value::Null),
        Some(Value::String(s)) => Ok(Value::String(s.trim().chars().take(300).collect())),
        Some(Value::Number(n)) => Ok(Value::String(n.to_string())),
        Some(other) => Err(format!("{field}: not a string: {other}")),
    }
}

/// Normalise a reader's JSON into the canonical result shape, or explain why not.
/// Accepts the object itself or a string containing it (optionally in ``` fences).
pub fn validate_result(raw: Value) -> Result<Value, String> {
    let raw = match raw {
        Value::String(s) => {
            let t = s.trim();
            let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
            let t = t.strip_suffix("```").unwrap_or(t).trim();
            serde_json::from_str::<Value>(t).map_err(|e| format!("reader output is not JSON: {e}"))?
        }
        v => v,
    };
    let obj = raw.as_object().ok_or("reader output is not an object")?;
    let lines = obj
        .get("lines")
        .and_then(Value::as_array)
        .ok_or("reader output has no lines array")?;
    if lines.len() > 200 {
        return Err("too many lines".into());
    }
    let mut out_lines = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        let l = line.as_object().ok_or(format!("line {i} is not an object"))?;
        let name = str_or_null(l.get("name"), "name")?;
        if name.is_null() {
            continue; // nothing to review on a nameless, empty row
        }
        let mut m = Map::new();
        m.insert("code".into(), str_or_null(l.get("code"), "code")?);
        m.insert("name".into(), name);
        m.insert("qty".into(), num_or_null(l.get("qty"), "qty")?);
        m.insert("unit".into(), str_or_null(l.get("unit"), "unit")?);
        m.insert("unit_price".into(), num_or_null(l.get("unit_price"), "unit_price")?);
        m.insert("total".into(), num_or_null(l.get("total"), "total")?);
        out_lines.push(Value::Object(m));
    }
    Ok(json!({
        "store": str_or_null(obj.get("store"), "store")?,
        "date": str_or_null(obj.get("date"), "date")?,
        "receipt_no": str_or_null(obj.get("receipt_no"), "receipt_no")?,
        "lines": out_lines,
        "discount": num_or_null(obj.get("discount"), "discount")?,
        "grand_total": num_or_null(obj.get("grand_total"), "grand_total")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_key_is_utc_date() {
        assert_eq!(day_key(0), "1970-01-01");
        // 2026-11-07T23:59:59.999Z and the next ms
        assert_eq!(day_key(1_794_095_999_999), "2026-11-07");
        assert_eq!(day_key(1_794_096_000_000), "2026-11-08");
        assert_eq!(day_key(1_709_164_800_000), "2024-02-29");
    }

    #[test]
    fn neurons_match_price() {
        // 1M input tokens = $0.45 = 40.9k neurons
        assert!((neurons_for(1_000_000.0, 0.0) - 40_909.09).abs() < 0.1);
    }

    #[test]
    fn claimable_uses_stuck_constant() {
        assert!(CLAIMABLE.contains(&format!("?1 - {CLOUD_STUCK_MS}")));
    }

    #[test]
    fn online_window() {
        assert!(!is_online(None, 100_000));
        assert!(is_online(Some(70_000), 100_000));
        assert!(!is_online(Some(69_999), 100_000));
    }

    #[test]
    fn validates_and_coerces() {
        let v = validate_result(json!({
            "store": "makro", "date": "2026-10-29", "grand_total": "1,148.00", "discount": null,
            "lines": [
                {"code": 193431, "name": " ตราฉัตร ข้าว 15 กก. ", "qty": "1", "unit": "EACH", "unit_price": 401, "total": "401.00"},
                {"name": "", "qty": 1}
            ]
        }))
        .unwrap();
        assert_eq!(v["grand_total"], json!(1148.0));
        assert_eq!(v["receipt_no"], Value::Null);
        assert_eq!(v["lines"].as_array().unwrap().len(), 1);
        assert_eq!(v["lines"][0]["code"], json!("193431"));
        assert_eq!(v["lines"][0]["name"], json!("ตราฉัตร ข้าว 15 กก."));
        assert_eq!(v["lines"][0]["total"], json!(401.0));
    }

    #[test]
    fn accepts_fenced_string() {
        let v = validate_result(Value::String("```json\n{\"lines\":[]}\n```".into())).unwrap();
        assert_eq!(v["lines"], json!([]));
    }

    #[test]
    fn rejects_bad_shapes() {
        assert!(validate_result(json!([1, 2])).is_err());
        assert!(validate_result(json!({"store": "x"})).is_err());
        assert!(validate_result(json!({"lines": [{"name": "a", "qty": "abc"}]})).is_err());
        assert!(validate_result(Value::String("not json".into())).is_err());
    }
}
