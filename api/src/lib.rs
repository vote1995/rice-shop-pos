//! Rice-shop POS API — Rust on Cloudflare Workers.
//!
//! Entry point: `#[event(fetch)]` hands the request to an axum `Router`
//! (following the official workers-rs axum example). Modules:
//! - [`routes`] — HTTP handlers, grouped per resource
//! - [`db`]     — helpers around D1/R2 bindings
//! - [`error`]  — the JSON error type used by every handler

use axum::{routing::get, Router};
use tower_service::Service;
use worker::*;

mod auth;
mod db;
mod error;
mod routes;

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
        .route("/owner/me", get(routes::owner::me))
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
