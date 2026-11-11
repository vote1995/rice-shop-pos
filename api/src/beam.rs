//! Beam Checkout (https://docs.beamcheckout.com) — PromptPay QR charges.
//!
//! Everything about the upstream call is pinned HERE, server-side: base URL,
//! payment method, currency, amount (always the bill's server total) and the
//! credentials. Nothing in a client request reaches Beam except through the
//! validated fields below.
//!
//! Credentials are PER SHOP: the `BEAM_SHOPS` secret is a JSON object
//! `{"<shop id or shop name>": {"merchant_id", "api_key", "webhook_hmac_key"}}`
//! (local file `api/.dev.vars`, never committed; prod via `wrangler secret
//! put`). Once `BEAM_SHOPS` exists a shop without an entry has NO Beam QR.
//! Without `BEAM_SHOPS` the old single set (`BEAM_MERCHANT_ID` /
//! `BEAM_API_KEY` / `BEAM_WEBHOOK_HMAC_KEY`) serves every shop.
//!
//! Outcomes are three-way on purpose: a network error, a 5xx or a 429 from
//! Beam is [`BeamError::Unavailable`] — UNDECIDABLE, the caller must not mark
//! anything failed on it — while only a definitive 4xx is
//! [`BeamError::Rejected`].
//!
//! Webhooks are authenticated by `X-Beam-Signature`: base64(HMAC-SHA256(raw
//! body, base64-decoded `BEAM_WEBHOOK_HMAC_KEY`)), checked over the body bytes
//! exactly as received.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use sha2::Sha256;
use wasm_bindgen::JsValue;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit};

use crate::util::now_ms;

/// Production API. Pinned: never taken from a request or a var.
const BEAM_BASE_URL: &str = "https://api.beamcheckout.com";

// ---------------------------------------------------------------------------
// Dev-only fake Beam.
//
// `BEAM_MOCK=1` (a plain var, set ONLY under [env.dev.vars] in wrangler.toml)
// replaces every call to Beam with a local fake, so dev needs no Beam account.
// - create: returns a QR payload "MOCK-DEV ..." that is NOT a PromptPay EMV
//   string, so no banking app can pay it.
// - status: the charge reads PENDING for MOCK_PAID_AFTER_MS, then SUCCEEDED, so
//   the status poll in the PWA settles the bill the way a real payment would.
// Fails closed: if a real BEAM_API_KEY is configured too, the mock refuses to
// run (that combination means it was switched on in the wrong environment).
// ---------------------------------------------------------------------------
/// The PWA shows a "test mode" banner for QR payloads starting with this.
pub const MOCK_PREFIX: &str = "MOCK-DEV";
const MOCK_PAID_AFTER_MS: i64 = 12_000;
const MOCK_MERCHANT_ID: &str = "mock-merchant";

fn mock_mode(env: &Env) -> Result<bool, BeamError> {
    let on = env
        .var("BEAM_MOCK")
        .map(|v| v.to_string().trim() == "1")
        .unwrap_or(false);
    if on && (secret(env, "BEAM_API_KEY").is_ok() || secret(env, SHOPS_VAR).is_ok()) {
        return Err(BeamError::Config(
            "BEAM_MOCK=1 refused: real Beam credentials are also configured".into(),
        ));
    }
    Ok(on)
}

fn mock_charge_id(now_ms: i64, amount_satang: i64) -> String {
    format!("mock_{now_ms}_{amount_satang}")
}

/// `mock_<created ms>_<amount satang>` -> (created ms, amount).
fn mock_parse(charge_id: &str) -> Option<(i64, i64)> {
    let rest = charge_id.strip_prefix("mock_")?;
    let (ms, amount) = rest.split_once('_')?;
    Some((ms.parse().ok()?, amount.parse().ok()?))
}

fn mock_charge(charge_id: &str, now_ms: i64) -> Option<Charge> {
    let (created, amount) = mock_parse(charge_id)?;
    let paid = now_ms.saturating_sub(created) >= MOCK_PAID_AFTER_MS;
    Some(Charge {
        charge_id: charge_id.to_string(),
        merchant_id: Some(MOCK_MERCHANT_ID.to_string()),
        reference_id: None,
        status: (if paid { "SUCCEEDED" } else { "PENDING" }).to_string(),
        currency: Some("THB".to_string()),
        amount: Some(amount),
    })
}

#[derive(Debug)]
pub enum BeamError {
    /// Network failure / 5xx / 429 / unparsable 2xx: outcome unknown.
    Unavailable(String),
    /// Beam definitively refused the request (4xx).
    Rejected(String),
    /// Our own configuration is missing (secret not set).
    Config(String),
}

/// What the counter needs to show a QR.
#[derive(Debug)]
pub struct QrCharge {
    pub charge_id: String,
    /// The EMV PromptPay payload; the PWA renders it as a QR.
    pub qr_raw: String,
    /// Beam's expiry timestamp (RFC 3339), passed through as-is.
    pub expiry: Option<String>,
}

/// The fields of a charge we act on (GET /charges/{id} and webhook bodies).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Charge {
    pub charge_id: String,
    #[serde(default)]
    pub merchant_id: Option<String>,
    #[serde(default)]
    pub reference_id: Option<String>,
    /// PENDING | SUCCEEDED | FAILED
    pub status: String,
    #[serde(default)]
    pub currency: Option<String>,
    /// Satang.
    #[serde(default)]
    pub amount: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateResponse {
    charge_id: String,
    #[serde(default)]
    encoded_image: Option<EncodedImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodedImage {
    #[serde(default)]
    expiry: Option<String>,
    #[serde(default)]
    raw_data: Option<String>,
}

fn secret(env: &Env, name: &str) -> Result<String, BeamError> {
    env.secret(name)
        .map(|s| s.to_string())
        .or_else(|_| env.var(name).map(|v| v.to_string()))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| BeamError::Config(format!("{name} is not set")))
}

const SHOPS_VAR: &str = "BEAM_SHOPS";

/// One merchant's Beam credentials. No `Debug`: it must never reach a log.
#[derive(Clone, Deserialize)]
pub struct Creds {
    pub merchant_id: String,
    pub api_key: String,
    #[serde(default)]
    pub webhook_hmac_key: String,
}

fn mock_creds() -> Creds {
    Creds {
        merchant_id: MOCK_MERCHANT_ID.to_string(),
        api_key: String::new(),
        webhook_hmac_key: String::new(),
    }
}

/// Parses BEAM_SHOPS. Entries without a merchant id or key count as "not
/// set". The error never echoes the value (it holds secrets).
fn parse_shops(raw: &str) -> Result<Vec<(String, Creds)>, BeamError> {
    let map: BTreeMap<String, Creds> = serde_json::from_str(raw).map_err(|_| {
        BeamError::Config(
            "BEAM_SHOPS is not valid: expected an object of shop -> {merchant_id, api_key, webhook_hmac_key}"
                .into(),
        )
    })?;
    Ok(map
        .into_iter()
        .filter(|(_, c)| !c.merchant_id.trim().is_empty() && !c.api_key.trim().is_empty())
        .collect())
}

fn shops_config(env: &Env) -> Result<Option<Vec<(String, Creds)>>, BeamError> {
    match secret(env, SHOPS_VAR) {
        Ok(raw) => parse_shops(&raw).map(Some),
        Err(_) => Ok(None),
    }
}

/// The entry for a shop: the key is the shop's id or its name (case and
/// surrounding spaces ignored).
fn pick_shop(list: &[(String, Creds)], shop_id: &str, shop_name: &str) -> Option<Creds> {
    let id = shop_id.trim().to_lowercase();
    let name = shop_name.trim().to_lowercase();
    list.iter()
        .find(|(k, _)| {
            let k = k.trim().to_lowercase();
            !k.is_empty() && (k == id || k == name)
        })
        .map(|(_, c)| c.clone())
}

fn legacy_creds(env: &Env) -> Result<Creds, BeamError> {
    Ok(Creds {
        merchant_id: secret(env, "BEAM_MERCHANT_ID")?,
        api_key: secret(env, "BEAM_API_KEY")?,
        webhook_hmac_key: secret(env, "BEAM_WEBHOOK_HMAC_KEY").unwrap_or_default(),
    })
}

/// Beam credentials of one shop. Ok(None) = this shop has no Beam QR.
pub fn creds_for_shop(
    env: &Env,
    shop_id: &str,
    shop_name: &str,
) -> Result<Option<Creds>, BeamError> {
    if mock_mode(env)? {
        return Ok(Some(mock_creds()));
    }
    match shops_config(env)? {
        Some(list) => Ok(pick_shop(&list, shop_id, shop_name)),
        None => legacy_creds(env).map(Some),
    }
}

/// Every credential set whose webhook key could have signed a webhook. The
/// caller keeps the one whose signature verifies: that is the merchant.
pub fn webhook_candidates(env: &Env) -> Result<Vec<Creds>, BeamError> {
    if mock_mode(env)? {
        return Ok(vec![]);
    }
    let all: Vec<Creds> = match shops_config(env)? {
        Some(list) => list.into_iter().map(|(_, c)| c).collect(),
        None => vec![legacy_creds(env)?],
    };
    let with_key: Vec<Creds> = all
        .into_iter()
        .filter(|c| !c.webhook_hmac_key.trim().is_empty())
        .collect();
    if with_key.is_empty() {
        return Err(BeamError::Config("no Beam webhook_hmac_key is set".into()));
    }
    Ok(with_key)
}

fn auth_header(creds: &Creds) -> String {
    format!(
        "Basic {}",
        B64.encode(format!(
            "{}:{}",
            creds.merchant_id.trim(),
            creds.api_key.trim()
        ))
    )
}

async fn call(
    creds: &Creds,
    method: Method,
    path: &str,
    body: Option<String>,
    idempotency_key: Option<&str>,
) -> Result<String, BeamError> {
    let headers = Headers::new();
    let set = |k: &str, v: &str| {
        headers
            .set(k, v)
            .map_err(|e| BeamError::Config(format!("header {k}: {e}")))
    };
    set("Authorization", &auth_header(creds))?;
    set("Accept", "application/json")?;
    if body.is_some() {
        set("Content-Type", "application/json")?;
    }
    if let Some(k) = idempotency_key {
        set("x-beam-idempotency-key", k)?;
    }
    let mut init = RequestInit::new();
    init.with_method(method).with_headers(headers);
    if let Some(b) = body {
        init.with_body(Some(JsValue::from_str(&b)));
    }
    let req = Request::new_with_init(&format!("{BEAM_BASE_URL}{path}"), &init)
        .map_err(|e| BeamError::Config(format!("build request: {e}")))?;
    let mut resp = Fetch::Request(req)
        .send()
        .await
        .map_err(|e| BeamError::Unavailable(format!("fetch {path}: {e}")))?;
    let status = resp.status_code();
    let text = resp.text().await.unwrap_or_default();
    classify(status, path, text)
}

/// 2xx -> body; 5xx/429 -> undecidable; other 4xx -> rejected.
fn classify(status: u16, path: &str, text: String) -> Result<String, BeamError> {
    let snippet: String = text.chars().take(300).collect();
    match status {
        200..=299 => Ok(text),
        429 | 500..=599 => Err(BeamError::Unavailable(format!(
            "{path} -> {status}: {snippet}"
        ))),
        400..=499 => Err(BeamError::Rejected(format!(
            "{path} -> {status}: {snippet}"
        ))),
        _ => Err(BeamError::Unavailable(format!(
            "{path} -> unexpected {status}: {snippet}"
        ))),
    }
}

/// Creates a PromptPay QR charge. `reference_id` doubles as the idempotency
/// key, so retrying with the same payment id never creates a second charge
/// (Beam keeps keys 12 h).
pub async fn create_qr_charge(
    env: &Env,
    creds: &Creds,
    amount_satang: i64,
    reference_id: &str,
) -> Result<QrCharge, BeamError> {
    if mock_mode(env)? {
        return Ok(QrCharge {
            charge_id: mock_charge_id(now_ms(), amount_satang),
            qr_raw: format!(
                "{MOCK_PREFIX} NOT-A-REAL-PAYMENT ref={reference_id} amount={amount_satang}"
            ),
            expiry: None,
        });
    }
    let body = json!({
        "amount": amount_satang,
        "currency": "THB",
        "referenceId": reference_id,
        "paymentMethod": { "paymentMethodType": "QR_PROMPT_PAY", "qrPromptPay": {} },
    })
    .to_string();
    let text = call(
        creds,
        Method::Post,
        "/api/v1/charges",
        Some(body),
        Some(reference_id),
    )
    .await?;
    let r: CreateResponse = serde_json::from_str(&text)
        .map_err(|e| BeamError::Unavailable(format!("create charge parse: {e}")))?;
    let img = r
        .encoded_image
        .ok_or_else(|| BeamError::Unavailable("create charge: no encodedImage".into()))?;
    let qr_raw = img
        .raw_data
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BeamError::Unavailable("create charge: no rawData".into()))?;
    Ok(QrCharge {
        charge_id: r.charge_id,
        qr_raw,
        expiry: img.expiry,
    })
}

/// Reads a charge's current state.
pub async fn get_charge(env: &Env, creds: &Creds, charge_id: &str) -> Result<Charge, BeamError> {
    if !charge_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(BeamError::Config(format!("bad charge id {charge_id:?}")));
    }
    if mock_mode(env)? {
        return mock_charge(charge_id, now_ms())
            .ok_or_else(|| BeamError::Rejected(format!("unknown mock charge {charge_id}")));
    }
    let text = call(
        creds,
        Method::Get,
        &format!("/api/v1/charges/{charge_id}"),
        None,
        None,
    )
    .await?;
    serde_json::from_str(&text)
        .map_err(|e| BeamError::Unavailable(format!("get charge parse: {e}")))
}

/// Checks `X-Beam-Signature` over the raw body. Constant-time compare.
pub fn verify_signature(hmac_key_b64: &str, body: &[u8], signature_b64: &str) -> bool {
    let Ok(key) = B64.decode(hmac_key_b64.trim()) else {
        return false;
    };
    let Ok(sig) = B64.decode(signature_b64.trim()) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&key) else {
        return false;
    };
    mac.update(body);
    mac.verify_slice(&sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test vector from docs.beamcheckout.com/webhook-authentication.
    const BODY: &str = r#"{"chargeId":"ch_30GtUweMWec7r2hHIsV5xxQeJKp","merchantId":"m_2sHxsByPwESKYM4nMwdEBdhubPS","referenceId":"order#10001","status":"SUCCEEDED","currency":"THB","amount":3000000,"source":"PAYMENT_LINK","sourceId":"57Iot6c11o","transactionTime":"2025-07-23T10:16:12Z","paymentMethod":{"paymentMethodType":"CARD","card":{"last4":"1111","brand":"VISA"},"cardInstallments":null,"cardNetworkToken":null,"qrPromptPay":null,"alipay":null,"weChatPay":null,"trueMoney":null,"linePay":null,"shopeePay":null,"bangkokBankApp":null,"kPlus":null,"scbEasy":null,"krungsriApp":null},"failureCode":"","customer":{"primaryPhone":{"countryCode":"+66","number":"0958051075"},"email":"","deliveryAddress":{"contactName":"","phone":{"countryCode":"","number":""},"address":{"streetAddress":"","city":"","country":"","postCode":""}}},"createdAt":"2025-07-23T10:15:56.102401Z","updatedAt":"2025-07-23T10:16:17.418991Z"}"#;
    const KEY: &str = "KOFELguf5L1ltuDlkDHGUkPPnQhrgYYijTR4Fqh7APc=";
    const SIG: &str = "1XzWtJHZ9Y1tmjkA/XZUIn1ZHrUQp1d0Ms0oDQfJBto=";

    #[test]
    fn webhook_signature_matches_beam_test_vector() {
        assert!(verify_signature(KEY, BODY.as_bytes(), SIG));
    }

    #[test]
    fn webhook_signature_rejects_tampering() {
        let tampered = BODY.replace("3000000", "3000001");
        assert!(!verify_signature(KEY, tampered.as_bytes(), SIG));
        assert!(!verify_signature(KEY, BODY.as_bytes(), "AAAA"));
        assert!(!verify_signature(KEY, BODY.as_bytes(), "not base64!"));
        assert!(!verify_signature("", BODY.as_bytes(), SIG));
    }

    fn c(m: &str) -> Creds {
        Creds {
            merchant_id: m.into(),
            api_key: "k".into(),
            webhook_hmac_key: "w".into(),
        }
    }

    #[test]
    fn shops_json_parses_and_skips_unfinished_entries() {
        let raw = r#"{"rice":{"merchant_id":"m1","api_key":"k1","webhook_hmac_key":"w1"},
                      "noodle":{"merchant_id":"","api_key":"","webhook_hmac_key":""},
                      "s3":{"merchant_id":"m3","api_key":"k3"}}"#;
        let list = parse_shops(raw).unwrap();
        let keys: Vec<&str> = list.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"rice") && keys.contains(&"s3"));
        assert!(!keys.contains(&"noodle"), "blank entry = no Beam");
    }

    #[test]
    fn bad_shops_json_errors_without_echoing_the_value() {
        let Err(BeamError::Config(msg)) = parse_shops(r#"{"a":"SECRET-VALUE"}"#) else {
            panic!("must be a config error");
        };
        assert!(!msg.contains("SECRET-VALUE"));
        assert!(parse_shops("not json").is_err());
    }

    #[test]
    fn shop_is_matched_by_id_or_name_and_unlisted_shop_has_none() {
        let list = vec![
            ("Rice".to_string(), c("rice")),
            ("5a000000-0000-4000-8000-000000000009".to_string(), c("noodle")),
        ];
        assert_eq!(pick_shop(&list, "x", " rice ").unwrap().merchant_id, "rice");
        assert_eq!(
            pick_shop(&list, "5A000000-0000-4000-8000-000000000009", "any").unwrap().merchant_id,
            "noodle"
        );
        assert!(pick_shop(&list, "other-id", "third").is_none());
        assert!(pick_shop(&[("".to_string(), c("m"))], "", "").is_none(), "empty key never matches");
    }

    #[test]
    fn webhook_body_parses_into_charge() {
        let c: Charge = serde_json::from_str(BODY).unwrap();
        assert_eq!(c.charge_id, "ch_30GtUweMWec7r2hHIsV5xxQeJKp");
        assert_eq!(c.status, "SUCCEEDED");
        assert_eq!(c.amount, Some(3_000_000));
        assert_eq!(c.reference_id.as_deref(), Some("order#10001"));
    }

    #[test]
    fn upstream_status_is_three_way() {
        assert!(classify(200, "/x", "{}".into()).is_ok());
        assert!(matches!(
            classify(503, "/x", String::new()),
            Err(BeamError::Unavailable(_))
        ));
        assert!(matches!(
            classify(429, "/x", String::new()),
            Err(BeamError::Unavailable(_))
        ));
        assert!(matches!(
            classify(400, "/x", String::new()),
            Err(BeamError::Rejected(_))
        ));
        assert!(matches!(
            classify(401, "/x", String::new()),
            Err(BeamError::Rejected(_))
        ));
    }
}

#[cfg(test)]
mod mock_tests {
    use super::*;

    #[test]
    fn mock_charge_is_pending_then_succeeds() {
        let id = mock_charge_id(1_000_000, 15_000);
        let early = mock_charge(&id, 1_000_000 + MOCK_PAID_AFTER_MS - 1).unwrap();
        assert_eq!(early.status, "PENDING");
        let late = mock_charge(&id, 1_000_000 + MOCK_PAID_AFTER_MS).unwrap();
        assert_eq!(late.status, "SUCCEEDED");
        // the app only settles when currency is THB and the amount matches
        assert_eq!(late.currency.as_deref(), Some("THB"));
        assert_eq!(late.amount, Some(15_000));
    }

    #[test]
    fn mock_ids_round_trip_and_reject_garbage() {
        assert_eq!(mock_parse(&mock_charge_id(42, 7)), Some((42, 7)));
        for bad in ["", "mock_", "mock_1", "mock_a_b", "ch_30GtUweMWec7r2hHIsV5xxQeJKp", "mock_1_2_3"] {
            assert!(mock_charge(bad, 0).is_none(), "{bad:?} must not parse");
        }
    }

    #[test]
    fn mock_payload_is_not_a_promptpay_emv_string() {
        // real PromptPay QR payloads start with the EMV format indicator "000201"
        assert!(!MOCK_PREFIX.starts_with("000201"));
    }
}
