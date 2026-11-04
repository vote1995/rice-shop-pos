//! Beam Checkout (https://docs.beamcheckout.com) — PromptPay QR charges.
//!
//! Everything about the upstream call is pinned HERE, server-side: base URL,
//! payment method, currency, amount (always the bill's server total) and the
//! credentials (`BEAM_MERCHANT_ID` / `BEAM_API_KEY` secrets). Nothing in a
//! client request reaches Beam except through the validated fields below.
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
use sha2::Sha256;
use wasm_bindgen::JsValue;
use worker::{Env, Fetch, Headers, Method, Request, RequestInit};

/// Production API. Pinned: never taken from a request or a var.
const BEAM_BASE_URL: &str = "https://api.beamcheckout.com";

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

/// The merchant id this deployment is configured for.
pub fn merchant_id(env: &Env) -> Result<String, BeamError> {
    secret(env, "BEAM_MERCHANT_ID")
}

fn auth_header(env: &Env) -> Result<String, BeamError> {
    let id = merchant_id(env)?;
    let key = secret(env, "BEAM_API_KEY")?;
    Ok(format!(
        "Basic {}",
        B64.encode(format!("{}:{}", id.trim(), key.trim()))
    ))
}

async fn call(
    env: &Env,
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
    set("Authorization", &auth_header(env)?)?;
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
    amount_satang: i64,
    reference_id: &str,
) -> Result<QrCharge, BeamError> {
    let body = json!({
        "amount": amount_satang,
        "currency": "THB",
        "referenceId": reference_id,
        "paymentMethod": { "paymentMethodType": "QR_PROMPT_PAY", "qrPromptPay": {} },
    })
    .to_string();
    let text = call(
        env,
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
pub async fn get_charge(env: &Env, charge_id: &str) -> Result<Charge, BeamError> {
    if !charge_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(BeamError::Config(format!("bad charge id {charge_id:?}")));
    }
    let text = call(
        env,
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

/// The webhook HMAC key secret.
pub fn webhook_key(env: &Env) -> Result<String, BeamError> {
    secret(env, "BEAM_WEBHOOK_HMAC_KEY")
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
