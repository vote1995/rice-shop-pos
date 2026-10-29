//! Menu images on R2 and the app-enforced R2 free-tier quotas (FEATURES 3.2, 3.79).
//!
//! R2 has no spending cap: past the free tier it simply bills. So the Worker
//! keeps its own counters in D1 (migration 0004) and refuses work beyond
//! limits set at ~10% of the free tier, leaving a wide margin for backups/
//! archives later (M5) and for anything else on the account:
//!
//! | resource         | free tier / month | app limit        |
//! |------------------|-------------------|------------------|
//! | storage          | 10 GB             | 1 GiB            |
//! | class A (writes) | 1,000,000         | 100,000          |
//! | class B (reads)  | 10,000,000        | 1,000,000        |
//!
//! Over a limit: uploads answer 409 `media_quota`, image reads answer 503 so
//! the POS just shows the dish without its photo - selling never stops.

use uuid::Uuid;
use worker::Env;

use crate::db;
use crate::error::ApiError;
use crate::routes::orders::changes;
use crate::util::{int, now_ms, txt};

/// One image after client-side resize/compress (~800 px WebP/JPEG).
pub const MAX_IMAGE_BYTES: usize = 200 * 1024;
pub const MAX_TOTAL_BYTES: i64 = 1024 * 1024 * 1024;
pub const MAX_CLASS_A_PER_MONTH: i64 = 100_000;
pub const MAX_CLASS_B_PER_MONTH: i64 = 1_000_000;

/// Keys are immutable (a new upload gets a new key), so clients may cache forever.
pub const CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

/// Content type + file extension from the magic bytes; only WebP and JPEG
/// (what a browser canvas exports). The client-sent Content-Type is ignored.
pub fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.len() >= 3 && bytes[0..3] == [0xFF, 0xD8, 0xFF] {
        Some(("image/jpeg", "jpg"))
    } else {
        None
    }
}

pub fn content_type_for_key(key: &str) -> &'static str {
    if key.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

pub fn new_menu_key(shop_id: &str, ext: &str) -> String {
    format!("menu/{shop_id}/{}.{ext}", Uuid::new_v4())
}

/// Only keys this app writes: `menu/{uuid}/{uuid}.{webp|jpg}`, canonical
/// lowercase hyphenated uuids. Anything else is never looked up in R2.
pub fn valid_media_key(key: &str) -> bool {
    let canonical = |s: &str| Uuid::parse_str(s).is_ok_and(|u| u.to_string() == s);
    let mut parts = key.split('/');
    let (Some("menu"), Some(shop), Some(file), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let Some((stem, ext)) = file.split_once('.') else {
        return false;
    };
    matches!(ext, "webp" | "jpg") && canonical(shop) && canonical(stem)
}

/// 'YYYY-MM' (UTC) of a unix-ms timestamp - the R2 billing month.
pub fn month_key(now_ms: i64) -> String {
    // Howard Hinnant's civil_from_days.
    let z = now_ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}")
}

#[derive(Clone, Copy)]
pub enum OpClass {
    /// Writes (PutObject). DeleteObject is free and is not counted.
    A,
    /// Reads (GetObject).
    B,
}

/// Count one R2 operation BEFORE issuing it. Returns false (and counts
/// nothing) when this month's cap is reached. One statement, so concurrent
/// requests can never overshoot the cap.
pub async fn reserve_op(env: &Env, class: OpClass) -> Result<bool, ApiError> {
    let (sql, cap) = match class {
        OpClass::A => (
            "INSERT INTO media_usage (month, class_a, class_b) VALUES (?1, 1, 0)
             ON CONFLICT(month) DO UPDATE SET class_a = class_a + 1 WHERE class_a < ?2",
            MAX_CLASS_A_PER_MONTH,
        ),
        OpClass::B => (
            "INSERT INTO media_usage (month, class_a, class_b) VALUES (?1, 0, 1)
             ON CONFLICT(month) DO UPDATE SET class_b = class_b + 1 WHERE class_b < ?2",
            MAX_CLASS_B_PER_MONTH,
        ),
    };
    let result = db::db(env)?
        .prepare(sql)
        .bind(&[txt(&month_key(now_ms())), int(cap)])?
        .run()
        .await?;
    Ok(changes(&result)? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOP: &str = "0b6f1c1e-6a52-4d0e-9a51-6f3d7c2b9e10";
    const FILE: &str = "5d2c8f7a-1b3e-4c6d-8e9f-0a1b2c3d4e5f";

    #[test]
    fn sniffs_webp_and_jpeg_only() {
        let mut webp = b"RIFF\0\0\0\0WEBPVP8 ".to_vec();
        assert_eq!(sniff_image(&webp), Some(("image/webp", "webp")));
        webp[8] = b'X';
        assert_eq!(sniff_image(&webp), None);
        assert_eq!(
            sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(("image/jpeg", "jpg"))
        );
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(sniff_image(b"<svg"), None);
        assert_eq!(sniff_image(&[]), None);
    }

    #[test]
    fn month_key_is_utc_calendar_month() {
        assert_eq!(month_key(0), "1970-01");
        // 2024-02-29T12:00:00Z
        assert_eq!(month_key(1_709_208_000_000), "2024-02");
        // 2025-12-31T23:59:59.999Z -> 2026-01-01T00:00:00Z
        assert_eq!(month_key(1_767_225_599_999), "2025-12");
        assert_eq!(month_key(1_767_225_600_000), "2026-01");
    }

    #[test]
    fn accepts_only_app_written_keys() {
        assert!(valid_media_key(&format!("menu/{SHOP}/{FILE}.webp")));
        assert!(valid_media_key(&format!("menu/{SHOP}/{FILE}.jpg")));
        assert!(!valid_media_key(&format!("menu/{SHOP}/{FILE}.png")));
        assert!(!valid_media_key(&format!("menu/{SHOP}/{FILE}")));
        assert!(!valid_media_key(&format!("backup/{SHOP}/{FILE}.webp")));
        assert!(!valid_media_key(&format!("menu/{SHOP}/x/{FILE}.webp")));
        assert!(!valid_media_key(&format!("menu/../{FILE}.webp")));
        let upper = SHOP.to_uppercase();
        assert!(!valid_media_key(&format!("menu/{upper}/{FILE}.webp")));
        assert!(valid_media_key(&new_menu_key(SHOP, "webp")));
    }
}
