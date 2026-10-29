//! Rice-shop POS API — Rust on Cloudflare Workers.
//!
//! Entry point: `#[event(fetch)]` hands the request to an axum `Router`
//! (following the official workers-rs axum example). Modules:
//! - [`routes`] — HTTP handlers, grouped per resource
//! - [`db`]     — helpers around D1/R2 bindings
//! - [`error`]  — the JSON error type used by every handler

use axum::{
    routing::{get, post},
    Router,
};
use tower_service::Service;
use worker::*;

mod auth;
mod db;
mod error;
mod extract;
mod routes;
mod util;

/// Shared handler state. `Env` is cheap to clone (a handle to the Workers
/// runtime bindings); later tickets will hang D1-backed services on here.
#[derive(Clone)]
pub struct AppState {
    pub env: Env,
}

pub fn router(env: Env) -> Router {
    let state = AppState { env };

    Router::new()
        .route("/health", get(routes::health::health))
        // Device lifecycle + staff PIN login: public in the sense that they
        // authenticate with the device token / session token, not owner auth.
        .route("/device/register", post(routes::device::register))
        .route("/device/status", get(routes::device::status))
        .route("/device/staff", get(routes::device::staff))
        .route("/auth/pin", post(routes::staff_auth::pin))
        .route("/auth/logout", post(routes::staff_auth::logout))
        .route("/staff/me", get(routes::staff_auth::me))
        .route("/owner/me", get(routes::owner::me))
        .route(
            "/owner/shops",
            get(routes::owner::shops::list).post(routes::owner::shops::create),
        )
        .route(
            "/owner/staff",
            get(routes::owner::staff::list).post(routes::owner::staff::create),
        )
        .route("/owner/staff/{id}/reset-pin", post(routes::owner::staff::reset_pin))
        .route("/owner/staff/{id}/revoke", post(routes::owner::staff::revoke))
        .route("/owner/devices", get(routes::owner::devices::list))
        .route(
            "/owner/devices/{id}/approve",
            post(routes::owner::devices::approve),
        )
        .route(
            "/owner/devices/{id}/revoke",
            post(routes::owner::devices::revoke),
        )
        .fallback(routes::not_found)
        .with_state(state)
}

#[event(fetch)]
async fn fetch(
    req: HttpRequest,
    env: Env,
    _ctx: Context,
) -> Result<axum::http::Response<axum::body::Body>> {
    Ok(router(env).call(req).await?)
}
