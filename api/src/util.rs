//! Mechanism-free helpers shared by every handler group (D1 bind values,
//! unix-ms timestamps, name/uuid validation). These used to live in
//! `routes/owner/mod.rs`; M0-2b added device + staff auth, which needs the
//! same primitives. Auth *logic* stays split per population (see
//! `auth/mod.rs`) - only these plain helpers are shared.

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
