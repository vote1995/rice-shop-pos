//! Small crypto helpers: random tokens, staff PIN hashing.
//!
//! PIN hashing is deliberately HMAC-SHA256 with a server-side secret
//! (`PIN_PEPPER`), not a slow KDF: a 4–6 digit PIN has at most 10^6 values, so
//! no work factor makes an offline guess expensive, and a slow KDF would blow
//! the ~10 ms free-tier CPU budget per request. The protection is instead
//! (1) the pepper never lives in D1, so a DB leak alone reveals nothing,
//! (2) the 5-strike lockout (3.54), and (3) PIN login only works from an
//! approved device (3.55).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("crypto.getRandomValues unavailable");
    buf
}

pub fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// A fresh opaque bearer token (32 random bytes, base64url) and the hash we
/// store for it. Only the hash ever reaches D1.
pub fn new_token() -> (String, String) {
    let token = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
    let hash = sha256_hex(&token);
    (token, hash)
}

/// PINs are 4–6 ASCII digits (3.53).
pub fn validate_pin(pin: &str) -> bool {
    (4..=6).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

pub fn new_salt_hex() -> String {
    hex::encode(random_bytes::<16>())
}

fn pin_mac(pepper: &[u8], salt_hex: &str, pin: &str) -> Option<HmacSha256> {
    let salt = hex::decode(salt_hex).ok()?;
    let mut mac = HmacSha256::new_from_slice(pepper).ok()?;
    mac.update(&salt);
    mac.update(pin.as_bytes());
    Some(mac)
}

pub fn hash_pin(pepper: &[u8], salt_hex: &str, pin: &str) -> Option<String> {
    pin_mac(pepper, salt_hex, pin).map(|mac| hex::encode(mac.finalize().into_bytes()))
}

/// Constant-time comparison against the stored hash.
pub fn verify_pin(pepper: &[u8], salt_hex: &str, pin: &str, expected_hex: &str) -> bool {
    let (Some(mac), Ok(expected)) = (pin_mac(pepper, salt_hex, pin), hex::decode(expected_hex))
    else {
        return false;
    };
    mac.verify_slice(&expected).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_validation() {
        for ok in ["1234", "12345", "123456", "0000"] {
            assert!(validate_pin(ok), "{ok}");
        }
        for bad in ["", "123", "1234567", "12a4", "１２３４", " 1234", "12 34"] {
            assert!(!validate_pin(bad), "{bad}");
        }
    }

    #[test]
    fn pin_hash_roundtrip() {
        let salt = new_salt_hex();
        let hash = hash_pin(b"pepper", &salt, "4821").unwrap();
        assert!(verify_pin(b"pepper", &salt, "4821", &hash));
        assert!(!verify_pin(b"pepper", &salt, "4822", &hash));
        assert!(!verify_pin(b"other", &salt, "4821", &hash));
        assert!(!verify_pin(b"pepper", &new_salt_hex(), "4821", &hash));
        assert!(!verify_pin(b"pepper", "not-hex", "4821", &hash));
        assert!(!verify_pin(b"pepper", &salt, "4821", "not-hex"));
    }

    #[test]
    fn token_hash_matches() {
        let (token, hash) = new_token();
        assert_eq!(token.len(), 43);
        assert_eq!(hash, sha256_hex(&token));
        assert_ne!(new_token().0, token);
    }
}
