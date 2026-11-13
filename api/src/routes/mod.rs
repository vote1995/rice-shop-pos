//! HTTP handlers, grouped per resource. More route modules (auth, devices,
//! menu, orders, ...) land in later tickets (M0+).

pub mod app_update;
pub mod device;
pub mod health;
pub mod media;
pub mod members;
pub mod menu;
pub mod orders;
pub mod owner;
pub mod promptpay;
pub mod slip_agent;
pub mod staff_auth;
pub mod stock_count;

use crate::error::ApiError;

/// Fallback for unmatched routes — same JSON error shape as everything else.
pub async fn not_found() -> ApiError {
    ApiError::NotFound
}
