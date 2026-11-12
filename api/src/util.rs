//! Mechanism-free helpers shared by every handler group (D1 bind values,
//! unix-ms timestamps, name/uuid validation, strong ETag / `If-None-Match`
//! revalidation for cacheable-but-volatile GETs). These used to live in
//! `routes/owner/mod.rs`; M0-2b added device + staff auth, which needs the
//! same primitives. Auth *logic* stays split per population (see
//! `auth/mod.rs`) - only these plain helpers are shared.

use sha2::{Digest, Sha256};
use uuid::Uuid;
use wasm_bindgen::JsValue;
use worker::Date;

use crate::error::ApiError;

/// "Now" in the schema's canonical unit: unix milliseconds (migrations, 0001).
pub(crate) fn now_ms() -> i64 {
    Date::now().as_millis() as i64
}

/// D1 bind values. Kept explicit (and uniform in bind slices) instead of
/// `.into()` so the JsValue target type never depends on inference.
pub(crate) fn txt(v: &str) -> JsValue {
    JsValue::from(v)
}

/// Timestamps/counters are exact in f64 (unix ms << 2^53), so this binds
/// losslessly; SQLite accepts integral REALs in INTEGER columns (STRICT).
pub(crate) fn int(v: i64) -> JsValue {
    JsValue::from_f64(v as f64)
}

/// Optional integer/text binds: NULL when absent (nullable columns). Used by
/// the menu endpoints (menu_items.price_2/price_3, option_groups.menu_item_id, ...).
pub(crate) fn opt_int(v: Option<i64>) -> JsValue {
    match v {
        Some(v) => int(v),
        None => JsValue::NULL,
    }
}

pub(crate) fn opt_txt(v: Option<&str>) -> JsValue {
    match v {
        Some(v) => txt(v),
        None => JsValue::NULL,
    }
}

/// Names of shops/staff/devices: trimmed, non-empty, at most 100 characters.
pub(crate) fn clean_name(raw: &str) -> Result<String, ApiError> {
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::BadRequest(
            "name must be 1-100 characters after trimming".into(),
        ));
    }
    Ok(name.to_owned())
}

/// Ids come from the client and are UUIDs by schema convention; else 400.
pub(crate) fn parse_uuid(raw: &str, field: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::BadRequest(format!("invalid uuid for {field}")))
}

/// A strong ETag over the exact bytes that will be sent as the body:
/// `"<sha256-hex>"` (quoted, per RFC 9110 §8.8.3). Hashing the serialized
/// body rather than the rows that produced it means every input to that body
/// is covered — a revalidated 304 can never differ from the 200 it skips.
pub(crate) fn body_etag(body: &[u8]) -> String {
    format!("\"{}\"", hex::encode(Sha256::digest(body)))
}

/// Would this `If-None-Match` header value let us answer `304 Not Modified`
/// for `etag`? The header is a comma-separated list, matched with *weak*
/// comparison (a client's `W/"..."` tag still counts), and `*` matches any
/// current representation (RFC 9110 §13.1.2). Both arguments are the raw
/// header/etag text; a non-etag entry simply never matches.
pub(crate) fn if_none_match_matches(if_none_match: &str, etag: &str) -> bool {
    if_none_match.split(',').any(|raw| {
        let candidate = raw.trim();
        if candidate.is_empty() {
            return false;
        }
        if candidate == "*" {
            return true;
        }
        // Weak prefix is case-sensitive in the spec; strip it so a weak tag
        // still revalidates against our strong one.
        let candidate = candidate.strip_prefix("W/").unwrap_or(candidate);
        candidate == etag
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_is_a_quoted_sha256_of_the_body() {
        // Well-known SHA-256 vectors: empty input and "abc".
        assert_eq!(
            body_etag(b""),
            "\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\""
        );
        assert_eq!(
            body_etag(b"abc"),
            "\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\""
        );
    }

    #[test]
    fn etag_is_deterministic_and_distinguishes_bodies() {
        let a = body_etag(b"{\"items\":[]}");
        assert_eq!(a, body_etag(b"{\"items\":[]}"));
        // Same JSON, one byte different -> a different tag (so a real menu
        // edit, sold-out toggle or stock dip can never be answered 304).
        assert_ne!(a, body_etag(b"{\"items\":[1]}"));
        // Always a valid header value: 2 quotes + 64 hex chars.
        assert_eq!(a.len(), 66);
        assert!(a.starts_with('"') && a.ends_with('"'));
        assert!(a[1..65].bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(axum::http::HeaderValue::from_str(&a).is_ok());
    }

    #[test]
    fn if_none_match_exact_and_weak_match() {
        let etag = "\"deadbeef\"";
        assert!(if_none_match_matches(etag, etag));
        // A weak version of the same tag still revalidates (weak comparison).
        assert!(if_none_match_matches("W/\"deadbeef\"", etag));
        // ...and inside a list, with the usual sloppy whitespace.
        assert!(if_none_match_matches("\"aaaa\", W/\"deadbeef\"", etag));
        assert!(if_none_match_matches("  \"deadbeef\" ,\"aaaa\"  ", etag));
    }

    #[test]
    fn if_none_match_star_matches_any_etag() {
        assert!(if_none_match_matches("*", "\"deadbeef\""));
        assert!(if_none_match_matches(" * ", "\"anything-at-all\""));
        assert!(if_none_match_matches("\"deadbeef\", *", "\"other\""));
    }

    #[test]
    fn if_none_match_non_match_is_false() {
        let etag = "\"deadbeef\"";
        // Different tag, quoted or weak.
        assert!(!if_none_match_matches("\"deadbeee\"", etag));
        assert!(!if_none_match_matches("W/\"feedface\"", etag));
        assert!(!if_none_match_matches("\"aaaa\", \"bbbb\"", etag));
        // A weak tag does NOT match when only the digests differ.
        assert!(!if_none_match_matches("W/\"deadbeee\"", etag));
        // Prefix/suffix tricks and bare (unquoted) junk never match.
        assert!(!if_none_match_matches("deadbeef", etag));
        assert!(!if_none_match_matches("\"deadbeef\"x", etag));
        assert!(!if_none_match_matches("x\"deadbeef\"", etag));
        // An unquoted W/ alone is not a wildcard either.
        assert!(!if_none_match_matches("W/", etag));
    }

    #[test]
    fn if_none_match_empty_or_garbage_is_false() {
        let etag = "\"deadbeef\"";
        assert!(!if_none_match_matches("", etag));
        assert!(!if_none_match_matches("   ", etag));
        assert!(!if_none_match_matches(",, ,", etag));
    }
}
