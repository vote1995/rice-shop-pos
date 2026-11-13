//! App self-update: version manifest, signed short-lived APK download links,
//! and a minimum-version gate.
//!
//! R2 layout (bucket `MEDIA`):
//! - `app/manifest.json` — `{"versionCode":int,"versionName":str,"sha256":hex,
//!   "size":int,"minSupported":int}`
//! - `app/rice-pos-<versionCode>.apk` — the APK named by the manifest.
//!
//! Two endpoints:
//! - `GET /api/app/manifest` — staff auth (same extractor as `/api/menu`).
//!   Returns the manifest plus `apkUrl`, a link that embeds a short-lived
//!   HMAC signature: `/api/app/apk?v=<versionCode>&exp=<unix_s>&sig=<hex>`,
//!   `exp = now + 600`. The MAC key is derived from the existing `PIN_PEPPER`
//!   secret and the fixed label `app-apk-download-v1` (domain separation, so
//!   pepper reuse never crosses over into PIN hashing) — no new secrets.
//! - `GET /api/app/apk?v&exp&sig` — the native Android downloader has no
//!   session/device concept, so the signature *is* the auth: constant-time
//!   verified, expiry-checked, bound to the manifest's `versionCode`.
//!
//! The minimum-version gate (see [`gate_check`]) runs in the `fetch`
//! entrypoint for every `/api/*` request except the update endpoints
//! themselves, health, the Beam webhook, owner routes and slip-agent routes.
//!
//! Everything decidable from inputs — signature verification, the gate
//! decision, manifest parsing, cache freshness — lives in pure functions so
//! `cargo test` covers them on the host with no Workers runtime.

use std::cell::RefCell;

use axum::{
    body::Body,
    extract::{RawQuery, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::json;
use sha2::Sha256;

use crate::auth::device::DeviceAuth;
use crate::util::now_ms;
use crate::{auth, db, error::ApiError, AppState};

type HmacSha256 = Hmac<Sha256>;

/// R2 key of the version manifest inside the `MEDIA` bucket.
pub const MANIFEST_KEY: &str = "app/manifest.json";
/// R2 key prefix of the APKs; the manifest's `versionCode` completes it.
pub const APK_KEY_PREFIX: &str = "app/rice-pos-";
/// Fixed label mixed into the MAC key so `PIN_PEPPER` reuse stays domain
/// separated (the derived key could never be confused with a PIN hash).
pub const APK_KEY_LABEL: &[u8] = b"app-apk-download-v1";
/// Signed `apkUrl` validity (seconds) — enough for a download to start.
pub const LINK_TTL_SECS: i64 = 600;
/// An `exp` further ahead than this is rejected: a link minted "now + 600"
/// must never be replayable beyond a 15-minute window even if validly signed.
pub const MAX_FUTURE_SECS: i64 = 900;
/// How long a successfully parsed manifest is trusted per isolate.
pub const MANIFEST_CACHE_MS: i64 = 60_000;
/// Negative caching (missing / unreadable / invalid manifest) — shorter, so a
/// just-uploaded manifest is picked up quickly, while a broken bucket does not
/// turn every request into an R2 read.
pub const MANIFEST_CACHE_FAILURE_MS: i64 = 10_000;
pub const APK_CONTENT_TYPE: &str = "application/vnd.android.package-archive";
/// Request header the POS sends on every call (absent/non-integer: no gate).
pub const VERSION_HEADER: &str = "x-app-version";
/// Response header carrying the latest published `versionCode`.
pub const LATEST_HEADER: &str = "x-app-latest";
/// Existing secret the download MAC key is derived from.
const PIN_PEPPER: &str = "PIN_PEPPER";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/// `app/manifest.json`. Parsing ([`Manifest::parse`]) is strict: wrong shape,
/// missing fields or nonsense values yield `None`, and the caller fails open.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version_code: i64,
    pub version_name: String,
    pub sha256: String,
    pub size: i64,
    pub min_supported: i64,
}

impl Manifest {
    /// Strict parse + validate. `sha256` is normalised to lowercase hex,
    /// `versionName` is trimmed; anything implausible (non-positive codes or
    /// size, non-hex digest, empty name) is rejected.
    pub fn parse(bytes: &[u8]) -> Option<Manifest> {
        let m: Manifest = serde_json::from_slice(bytes).ok()?;
        if m.version_code < 1 || m.min_supported < 1 || m.size < 1 {
            return None;
        }
        let name = m.version_name.trim();
        if name.is_empty() || name.len() > 64 {
            return None;
        }
        if m.sha256.len() != 64 || !m.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        Some(Manifest {
            version_code: m.version_code,
            version_name: name.to_owned(),
            sha256: m.sha256.to_ascii_lowercase(),
            size: m.size,
            min_supported: m.min_supported,
        })
    }

    /// R2 key of the APK this manifest points at.
    pub fn apk_key(&self) -> String {
        format!("{APK_KEY_PREFIX}{}.apk", self.version_code)
    }
}

// ---------------------------------------------------------------------------
// Signed download links (pure)
// ---------------------------------------------------------------------------

/// Download MAC key = HMAC-SHA256(pepper, label). Deterministic on every
/// isolate, derived per request, never stored.
pub fn apk_mac_key(pepper: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(pepper).expect("HMAC-SHA256 accepts any key length");
    mac.update(APK_KEY_LABEL);
    let mut key = [0u8; 32];
    key.copy_from_slice(&mac.finalize().into_bytes());
    key
}

fn mac(key: &[u8; 32], version_code: i64, exp: i64) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 accepts any key length");
    mac.update(format!("{version_code}.{exp}").as_bytes());
    mac
}

/// Signature over `"<versionCode>.<exp>"` with the derived key (hex).
pub fn sign_apk(pepper: &[u8], version_code: i64, exp: i64) -> String {
    hex::encode(mac(&apk_mac_key(pepper), version_code, exp).finalize().into_bytes())
}

/// The `apkUrl` handed out by `/api/app/manifest`.
pub fn apk_url(version_code: i64, exp: i64, sig: &str) -> String {
    format!("/api/app/apk?v={version_code}&exp={exp}&sig={sig}")
}

/// Why a download link was rejected. Carries no request data and no key
/// material — the mapping to HTTP errors never echoes anything secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadError {
    /// `v` is not the manifest's `versionCode` (stale or foreign link).
    Version,
    /// `exp` is in the past.
    Expired,
    /// `exp` lies further ahead than [`MAX_FUTURE_SECS`].
    TooFarAhead,
    /// Bad hex or wrong HMAC (constant-time compare either way).
    Signature,
}

impl DownloadError {
    fn api_error(self) -> ApiError {
        match self {
            DownloadError::Version => ApiError::coded(
                StatusCode::FORBIDDEN,
                "apk_version_mismatch",
                "this download link is for another app version",
            ),
            DownloadError::Expired => ApiError::coded(
                StatusCode::FORBIDDEN,
                "apk_link_expired",
                "download link expired, fetch the manifest again",
            ),
            DownloadError::TooFarAhead => ApiError::coded(
                StatusCode::FORBIDDEN,
                "apk_link_invalid",
                "download link expiry out of range",
            ),
            DownloadError::Signature => ApiError::coded(
                StatusCode::FORBIDDEN,
                "apk_link_invalid",
                "download link signature invalid",
            ),
        }
    }
}

/// Verify a download link. Pure: `(pepper, manifest versionCode, link params,
/// now) -> verdict`. `exp` must be in `(now, now + 900]`, `v` must equal the
/// manifest's `versionCode`, and `sig` must verify under the derived key
/// (`verify_slice` compares in constant time).
pub fn verify_download(
    pepper: &[u8],
    manifest_version_code: i64,
    v: i64,
    exp: i64,
    sig: &str,
    now: i64,
) -> Result<(), DownloadError> {
    if v != manifest_version_code {
        return Err(DownloadError::Version);
    }
    if exp <= now {
        return Err(DownloadError::Expired);
    }
    if exp > now + MAX_FUTURE_SECS {
        return Err(DownloadError::TooFarAhead);
    }
    let key = apk_mac_key(pepper);
    let expected = mac(&key, v, exp);
    let Ok(sig_bytes) = hex::decode(sig) else {
        return Err(DownloadError::Signature);
    };
    // Constant-time: same work and comparison regardless of where bytes differ.
    if expected.verify_slice(&sig_bytes).is_err() {
        return Err(DownloadError::Signature);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Minimum-version gate (pure)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Serve the request normally.
    Allow,
    /// Client is below `minSupported`: answer 426 instead.
    UpgradeRequired,
}

/// `X-App-Version` as an integer. Absent or non-integer -> `None`, and a
/// `None` client is never gated (we cannot guess a version).
pub fn client_version(header: Option<&str>) -> Option<i64> {
    header.and_then(|h| h.trim().parse::<i64>().ok())
}

pub fn must_upgrade(client: Option<i64>, manifest: &Manifest) -> bool {
    client.is_some_and(|v| v < manifest.min_supported)
}

/// The gate decision. `manifest == None` (missing / unreadable / invalid) is
/// [`Gate::Allow`] — fail open: a broken manifest must not brick the POS.
pub fn gate(client: Option<i64>, manifest: Option<&Manifest>) -> Gate {
    match manifest {
        Some(m) if must_upgrade(client, m) => Gate::UpgradeRequired,
        _ => Gate::Allow,
    }
}

/// Does the gate apply to this path? Only `/api/*`, minus the endpoints that
/// must stay reachable from any version: the update flow itself (`/api/app/*`),
/// health probes, the Beam webhook, the owner console and slip-agent routes.
pub fn gate_applies(path: &str) -> bool {
    match path.strip_prefix("/api/") {
        Some(rest) => !gate_exempt(rest),
        None => false,
    }
}

fn gate_exempt(rest: &str) -> bool {
    let under = |dir: &str| rest == dir || rest.starts_with(&format!("{dir}/"));
    under("app")
        || under("owner")
        || under("slip-agent")
        // health probes must never be gated (exact names, not a prefix match).
        || under("health")
        || rest == "healthz"
        || rest == "beam/webhook"
}

/// The 426 body (pure, so tests can assert the exact JSON).
pub fn upgrade_required_json(manifest: &Manifest) -> serde_json::Value {
    json!({
        "error": "upgrade_required",
        "latest": manifest.version_code,
        "minSupported": manifest.min_supported,
    })
}

/// The 426 body + `X-App-Latest` for a gated client.
pub fn upgrade_required_response(manifest: &Manifest) -> Response<Body> {
    let mut res = Json(upgrade_required_json(manifest)).into_response();
    *res.status_mut() = StatusCode::UPGRADE_REQUIRED;
    if let Ok(v) = HeaderValue::from_str(&manifest.version_code.to_string()) {
        res.headers_mut().insert(LATEST_HEADER, v);
    }
    res
}

// ---------------------------------------------------------------------------
// Per-isolate manifest cache
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CacheEntry {
    at_ms: i64,
    /// `None` = known-missing / unreadable / invalid (negative cache).
    manifest: Option<Manifest>,
}

thread_local! {
    /// Worker isolates are single-threaded, so a thread-local is the cheapest
    /// per-isolate cache. Never held across an await.
    static MANIFEST_CACHE: RefCell<Option<CacheEntry>> = const { RefCell::new(None) };
}

/// Pure freshness test: successes are trusted for [`MANIFEST_CACHE_MS`],
/// failures only for [`MANIFEST_CACHE_FAILURE_MS`].
pub fn cache_fresh(at_ms: i64, ok: bool, now_ms: i64) -> bool {
    let ttl = if ok { MANIFEST_CACHE_MS } else { MANIFEST_CACHE_FAILURE_MS };
    now_ms.saturating_sub(at_ms) < ttl
}

fn cache_hit(now: i64) -> Option<Option<Manifest>> {
    MANIFEST_CACHE.with(|slot| {
        let slot = slot.borrow();
        match slot.as_ref() {
            Some(e) if cache_fresh(e.at_ms, e.manifest.is_some(), now) => Some(e.manifest.clone()),
            _ => None,
        }
    })
}

fn cache_store(at_ms: i64, manifest: Option<Manifest>) {
    MANIFEST_CACHE.with(|slot| {
        *slot.borrow_mut() = Some(CacheEntry { at_ms, manifest });
    });
}

async fn fetch_manifest(env: &worker::Env) -> Option<Manifest> {
    let bucket = db::media(env).ok()?;
    let object = bucket.get(MANIFEST_KEY).execute().await.ok()??;
    let bytes = object.body()?.bytes().await.ok()?;
    Manifest::parse(&bytes)
}

/// The manifest, cached per isolate. `None` means "not usable right now"
/// (missing, unreadable or invalid JSON) — callers fail open / 404.
#[worker::send]
pub async fn cached_manifest(env: worker::Env) -> Option<Manifest> {
    let now = now_ms();
    if let Some(hit) = cache_hit(now) {
        return hit;
    }
    let fetched = fetch_manifest(&env).await;
    cache_store(now, fetched.clone());
    fetched
}

/// Everything the `fetch` entrypoint needs to enforce the gate on one request:
/// the latest `versionCode` when known (for `X-App-Latest`), and a ready-made
/// 426 response when the caller must be short-circuited. Never touches R2 for
/// paths the gate does not apply to.
#[worker::send]
pub async fn gate_check(
    env: worker::Env,
    path: String,
    client_header: Option<String>,
) -> (Option<i64>, Option<Response<Body>>) {
    if !gate_applies(&path) {
        return (None, None);
    }
    match cached_manifest(env).await {
        // Fail open: unreadable / missing / invalid manifest never gates.
        None => (None, None),
        Some(m) => {
            let client = client_version(client_header.as_deref());
            if gate(client, Some(&m)) == Gate::UpgradeRequired {
                (Some(m.version_code), Some(upgrade_required_response(&m)))
            } else {
                (Some(m.version_code), None)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn pepper(env: &worker::Env) -> Result<Vec<u8>, ApiError> {
    let p = auth::env_str(env, PIN_PEPPER);
    if p.is_empty() {
        // Already fatal for PIN login; the detail stays server-side.
        return Err(ApiError::Internal("PIN_PEPPER is not configured".to_owned()));
    }
    Ok(p.into_bytes())
}

fn now_secs() -> i64 {
    now_ms() / 1000
}

/// `GET /api/app/manifest` — approved-DEVICE auth (X-Device-Token), deliberately
/// NOT a staff session: an outdated app that is logged out (session expired, PIN
/// reset) is gated with 426 at PIN login and must still be able to fetch its
/// update. Pending/revoked devices get 403.
#[worker::send]
pub async fn manifest(
    State(state): State<AppState>,
    device: DeviceAuth,
) -> Result<Json<serde_json::Value>, ApiError> {
    device.require_approved()?;
    let m = cached_manifest(state.env.clone()).await.ok_or_else(|| {
        ApiError::coded(
            StatusCode::NOT_FOUND,
            "app_manifest_missing",
            "no app update manifest is published",
        )
    })?;
    let pepper = pepper(&state.env)?;
    let exp = now_secs() + LINK_TTL_SECS;
    let sig = sign_apk(&pepper, m.version_code, exp);
    Ok(Json(json!({
        "versionCode": m.version_code,
        "versionName": m.version_name,
        "sha256": m.sha256,
        "size": m.size,
        "minSupported": m.min_supported,
        "apkUrl": apk_url(m.version_code, exp, &sig),
    })))
}

/// `GET /api/app/apk?v&exp&sig` — no session/device auth: the native Android
/// downloader only has the signed link from `/api/app/manifest`.
#[worker::send]
pub async fn apk(
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
) -> Result<Response, ApiError> {
    use crate::routes::owner::query_param;
    let int_param = |key: &str| -> Result<i64, ApiError> {
        query_param(&query, key)
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or_else(|| ApiError::BadRequest(format!("query parameter {key} must be an integer")))
    };
    let v = int_param("v")?;
    let exp = int_param("exp")?;
    let sig = query_param(&query, "sig")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::BadRequest("query parameter sig is required".to_owned()))?;

    let m = cached_manifest(state.env.clone()).await.ok_or(ApiError::NotFound)?;
    let pepper = pepper(&state.env)?;
    verify_download(&pepper, m.version_code, v, exp, &sig, now_secs())
        .map_err(|e| e.api_error())?;

    // `v == m.version_code` is verified above, so the key matches the manifest.
    let key = m.apk_key();
    let object = db::media(&state.env)?
        .get(key.as_str())
        .execute()
        .await?
        .ok_or(ApiError::NotFound)?;
    let size = object.size();
    let bytes = object
        .body()
        .ok_or_else(|| ApiError::Internal(format!("R2 object {key} has no body")))?
        .bytes()
        .await?;

    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(APK_CONTENT_TYPE),
    );
    if let Ok(v) = HeaderValue::from_str(&size.to_string()) {
        h.insert(header::CONTENT_LENGTH, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA256_HEX: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn sample() -> Manifest {
        Manifest::parse(
            format!(
                r#"{{"versionCode":7,"versionName":"1.2.3","sha256":"{SHA256_HEX}","size":123456,"minSupported":5}}"#
            )
            .as_bytes(),
        )
        .expect("sample manifest must parse")
    }

    // ---------------- manifest parsing ----------------

    #[test]
    fn manifest_parse_valid() {
        let m = sample();
        assert_eq!(m.version_code, 7);
        assert_eq!(m.version_name, "1.2.3");
        assert_eq!(m.sha256, SHA256_HEX);
        assert_eq!(m.size, 123456);
        assert_eq!(m.min_supported, 5);
        assert_eq!(m.apk_key(), "app/rice-pos-7.apk");
    }

    #[test]
    fn manifest_parse_normalises() {
        let m = Manifest::parse(
            br#"{"versionCode":8,"versionName":" 2.0.0 ","sha256":"ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789","size":1,"minSupported":1}"#,
        )
        .expect("upper-case hex + padded name must parse");
        assert_eq!(m.version_name, "2.0.0");
        assert_eq!(
            m.sha256,
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
        );
        assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn manifest_parse_rejects_garbage() {
        for bad in [
            b"" as &[u8],
            b"not json",
            b"{}",
            b"[]",
            // missing fields
            br#"{"versionCode":7,"versionName":"1.2.3","sha256":"x","size":1}"#,
            // wrong types
            br#"{"versionCode":"7","versionName":"1.2.3","sha256":"aa","size":1,"minSupported":1}"#,
            // nonsense values
            br#"{"versionCode":0,"versionName":"1","sha256":"aa","size":1,"minSupported":1}"#,
            br#"{"versionCode":7,"versionName":"1","sha256":"aa","size":0,"minSupported":1}"#,
            br#"{"versionCode":7,"versionName":"1","sha256":"aa","size":1,"minSupported":0}"#,
            br#"{"versionCode":7,"versionName":"","sha256":"aa","size":1,"minSupported":1}"#,
            // sha256 not 64 hex chars
            br#"{"versionCode":7,"versionName":"1","sha256":"zz","size":1,"minSupported":1}"#,
            &format!(r#"{{"versionCode":7,"versionName":"1","sha256":"{}","size":1,"minSupported":1}}"#, "a".repeat(63)).into_bytes(),
            &format!(r#"{{"versionCode":7,"versionName":"1","sha256":"{}","size":1,"minSupported":1}}"#, "g".repeat(64)).into_bytes(),
        ] {
            assert!(Manifest::parse(bad).is_none(), "should reject: {}", String::from_utf8_lossy(bad));
        }
    }

    // ---------------- signature verification ----------------

    #[test]
    fn sig_valid_link_verifies() {
        let pepper = b"test-pepper";
        let now = 1_700_000_000;
        let exp = now + LINK_TTL_SECS;
        let sig = sign_apk(pepper, 7, exp);
        assert_eq!(sig.len(), 64);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(verify_download(pepper, 7, 7, exp, &sig, now).is_ok());
        // exactly at the far edge of the accepted window
        assert!(verify_download(pepper, 7, 7, now + MAX_FUTURE_SECS, &sign_apk(pepper, 7, now + MAX_FUTURE_SECS), now).is_ok());
        // one second past expiry is rejected
        assert_eq!(
            verify_download(pepper, 7, 7, now + 1, &sign_apk(pepper, 7, now + 1), now + 2),
            Err(DownloadError::Expired)
        );
    }

    #[test]
    fn sig_tampered_rejected() {
        let pepper = b"test-pepper";
        let now = 1_700_000_000;
        let exp = now + LINK_TTL_SECS;
        let sig = sign_apk(pepper, 7, exp);
        // flip one hex character
        let flipped = if sig.starts_with('0') {
            format!("1{}", &sig[1..])
        } else {
            format!("0{}", &sig[1..])
        };
        assert_eq!(
            verify_download(pepper, 7, 7, exp, &flipped, now),
            Err(DownloadError::Signature)
        );
        // truncated / non-hex / empty
        assert_eq!(verify_download(pepper, 7, 7, exp, &sig[..63], now), Err(DownloadError::Signature));
        assert_eq!(verify_download(pepper, 7, 7, exp, "zzzz", now), Err(DownloadError::Signature));
        assert_eq!(verify_download(pepper, 7, 7, exp, "", now), Err(DownloadError::Signature));
        // wrong secret
        assert_eq!(
            verify_download(b"other-pepper", 7, 7, exp, &sig, now),
            Err(DownloadError::Signature)
        );
        // signature over a different message (version or exp swapped)
        assert_eq!(
            verify_download(pepper, 7, 7, exp, &sign_apk(pepper, 8, exp), now),
            Err(DownloadError::Signature)
        );
        assert_eq!(
            verify_download(pepper, 7, 7, exp, &sign_apk(pepper, 7, exp + 1), now),
            Err(DownloadError::Signature)
        );
    }

    #[test]
    fn sig_expired_rejected() {
        let pepper = b"test-pepper";
        let now = 1_700_000_000;
        // exp exactly now, and exp in the past
        for exp in [now, now - 1, now - 600] {
            let sig = sign_apk(pepper, 7, exp);
            assert_eq!(
                verify_download(pepper, 7, 7, exp, &sig, now),
                Err(DownloadError::Expired),
                "exp={exp}"
            );
        }
    }

    #[test]
    fn sig_exp_too_far_ahead_rejected() {
        let pepper = b"test-pepper";
        let now = 1_700_000_000;
        for exp in [now + MAX_FUTURE_SECS + 1, now + 10 * MAX_FUTURE_SECS] {
            let sig = sign_apk(pepper, 7, exp); // validly signed, still refused
            assert_eq!(
                verify_download(pepper, 7, 7, exp, &sig, now),
                Err(DownloadError::TooFarAhead),
                "exp={exp}"
            );
        }
    }

    #[test]
    fn sig_wrong_version_rejected() {
        let pepper = b"test-pepper";
        let now = 1_700_000_000;
        let exp = now + LINK_TTL_SECS;
        let sig = sign_apk(pepper, 6, exp); // link for an older APK
        assert_eq!(
            verify_download(pepper, 7, 6, exp, &sig, now),
            Err(DownloadError::Version)
        );
        // even a perfectly valid signature for the manifest version does not
        // authorise a different `v`
        let sig7 = sign_apk(pepper, 7, exp);
        assert_eq!(
            verify_download(pepper, 7, 6, exp, &sig7, now),
            Err(DownloadError::Version)
        );
    }

    #[test]
    fn mac_key_is_domain_separated_and_deterministic() {
        assert_eq!(apk_mac_key(b"p1"), apk_mac_key(b"p1"));
        assert_ne!(apk_mac_key(b"p1"), apk_mac_key(b"p2"));
        assert_ne!(apk_mac_key(b"p1"), apk_mac_key(b"p1p1"));
        // different labels would give different keys (fixed label here, but the
        // derivation must depend on it, not just the pepper)
        let mut mac = HmacSha256::new_from_slice(b"p1").unwrap();
        mac.update(b"other-label");
        assert_ne!(apk_mac_key(b"p1").as_slice(), &mac.finalize().into_bytes()[..]);
    }

    #[test]
    fn apk_url_shape() {
        assert_eq!(
            apk_url(7, 1_700_000_600, "deadbeef"),
            "/api/app/apk?v=7&exp=1700000600&sig=deadbeef"
        );
    }

    // ---------------- gate ----------------

    #[test]
    fn client_version_header_parsing() {
        assert_eq!(client_version(None), None);
        assert_eq!(client_version(Some("")), None);
        assert_eq!(client_version(Some("  ")), None);
        assert_eq!(client_version(Some("12")), Some(12));
        assert_eq!(client_version(Some(" 12 ")), Some(12));
        assert_eq!(client_version(Some("-3")), Some(-3));
        assert_eq!(client_version(Some("1.2.3")), None);
        assert_eq!(client_version(Some("v12")), None);
        assert_eq!(client_version(Some("12abc")), None);
    }

    #[test]
    fn gate_absent_or_malformed_header_never_gates() {
        let m = sample();
        assert_eq!(gate(None, Some(&m)), Gate::Allow);
        assert_eq!(gate(client_version(Some("1.2.3")), Some(&m)), Gate::Allow);
    }

    #[test]
    fn gate_equal_or_newer_version_allowed() {
        let m = sample(); // minSupported = 5
        assert_eq!(gate(Some(5), Some(&m)), Gate::Allow);
        assert_eq!(gate(Some(7), Some(&m)), Gate::Allow);
        assert_eq!(gate(Some(999), Some(&m)), Gate::Allow);
    }

    #[test]
    fn gate_lower_version_upgrades() {
        let m = sample(); // minSupported = 5
        assert_eq!(gate(Some(4), Some(&m)), Gate::UpgradeRequired);
        assert_eq!(gate(Some(0), Some(&m)), Gate::UpgradeRequired);
        assert_eq!(gate(Some(-1), Some(&m)), Gate::UpgradeRequired);
    }

    #[test]
    fn gate_fails_open_without_manifest() {
        // missing / unreadable / invalid manifest -> never gate
        assert_eq!(gate(Some(1), None), Gate::Allow);
        assert_eq!(gate(None, None), Gate::Allow);
    }

    #[test]
    fn gate_path_scope() {
        for gated in [
            "/api/menu",
            "/api/orders",
            "/api/device/register",
            "/api/auth/pin",
            "/api/media/x/y",
            "/api/payments/recent",
            "/api/anything-else",
        ] {
            assert!(gate_applies(gated), "{gated}");
        }
        for exempt in [
            // the update flow itself
            "/api/app/manifest",
            "/api/app/apk",
            "/api/app",
            // probes
            "/api/health",
            "/api/healthz",
            // server-to-server
            "/api/beam/webhook",
            // owner console (Cloudflare Access)
            "/api/owner",
            "/api/owner/me",
            "/api/owner/shops/1/orders",
            // reader agent
            "/api/slip-agent",
            "/api/slip-agent/heartbeat",
            // outside the API (SPA assets)
            "/",
            "/assets/app.js",
            "/api", // not /api/... : nothing routed there anyway
        ] {
            assert!(!gate_applies(exempt), "{exempt}");
        }
    }

    #[test]
    fn upgrade_response_shape() {
        let res = upgrade_required_response(&sample());
        assert_eq!(res.status(), StatusCode::UPGRADE_REQUIRED);
        assert_eq!(res.headers().get(LATEST_HEADER).unwrap(), "7");
        let v = upgrade_required_json(&sample());
        assert_eq!(v["error"], "upgrade_required");
        assert_eq!(v["latest"], 7);
        assert_eq!(v["minSupported"], 5);
    }

    // ---------------- cache freshness ----------------

    #[test]
    fn cache_freshness_windows() {
        let t = 1_000_000;
        // success: fresh for 60s
        assert!(cache_fresh(t, true, t));
        assert!(cache_fresh(t, true, t + 59_999));
        assert!(!cache_fresh(t, true, t + 60_000));
        assert!(!cache_fresh(t, true, t + 120_000));
        // failure: only 10s
        assert!(cache_fresh(t, false, t));
        assert!(cache_fresh(t, false, t + 9_999));
        assert!(!cache_fresh(t, false, t + 10_000));
        // clock went backwards: never stale because of a negative delta
        assert!(cache_fresh(t, true, t - 5_000));
    }
}
