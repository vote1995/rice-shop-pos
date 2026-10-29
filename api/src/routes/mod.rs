//! HTTP handlers, grouped per resource. More route modules (auth, devices,
//! menu, orders, ...) land in later tickets (M0+).

pub mod device;
pub mod health;
pub mod media;
pub mod menu;
pub mod orders;
pub mod owner;
pub mod staff_auth;

use crate::error::ApiError;

/// Fallback for unmatched routes — same JSON error shape as everything else.
pub async fn not_found() -> ApiError {
    ApiError::NotFound
}
