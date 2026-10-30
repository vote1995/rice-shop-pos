//! Rice-shop POS API — Rust on Cloudflare Workers.
//!
//! Entry point: `#[event(fetch)]` hands the request to an axum `Router`
//! (following the official workers-rs axum example). Modules:
//! - [`routes`] — HTTP handlers, grouped per resource
//! - [`db`]     — helpers around D1/R2 bindings
//! - [`error`]  — the JSON error type used by every handler
//! - [`media`]  — R2 menu images + app-enforced free-tier quotas
//! - [`pricing`] — the pure order-line pricing engine (no D1, no worker types)

use axum::{
    routing::{get, post, put},
    Router,
};
use tower_service::Service;
use worker::*;

mod auth;
mod db;
mod error;
mod extract;
mod media;
mod pricing;
mod routes;
mod stock;
mod util;

/// Shared handler state. `Env` is cheap to clone (a handle to the Workers
/// runtime bindings); later tickets will hang D1-backed services on here.
#[derive(Clone)]
pub struct AppState {
    pub env: Env,
}

pub fn router(env: Env) -> Router {
    let state = AppState { env };

    let api = Router::new()
        .route("/health", get(routes::health::health))
        // Device lifecycle + staff PIN login: public in the sense that they
        // authenticate with the device token / session token, not owner auth.
        .route("/device/register", post(routes::device::register))
        .route("/device/status", get(routes::device::status))
        .route("/device/staff", get(routes::device::staff))
        .route("/auth/pin", post(routes::staff_auth::pin))
        .route("/auth/logout", post(routes::staff_auth::logout))
        .route("/staff/me", get(routes::staff_auth::me))
        // Staff POS menu (M1-1b): the session shop's saleable menu and the
        // counter sold-out toggles (shop always from the session, never the
        // request).
        .route("/menu", get(routes::menu::staff_menu))
        .route(
            "/menu/items/{id}/sold-out",
            post(routes::menu::item_sold_out),
        )
        .route(
            "/menu/options/{id}/sold-out",
            post(routes::menu::option_sold_out),
        )
        // Staff orders (M1-2a): create (server-priced) and the queue list.
        .route(
            "/orders",
            get(routes::orders::list).post(routes::orders::create),
        )
        .route("/orders/{id}", get(routes::orders::get_order))
        .route("/orders/{id}/items", post(routes::orders::add_items))
        .route("/orders/{id}/serve", post(routes::orders::serve))
        .route("/orders/{id}/unserve", post(routes::orders::unserve))
        .route("/orders/{id}/cancel", post(routes::orders::cancel))
        .route("/orders/{id}/pay", post(routes::orders::pay))
        .route("/media/{*key}", get(routes::media::get_media))
        .route("/owner/me", get(routes::owner::me))
        .route(
            "/owner/menu-items/{id}/image",
            put(routes::owner::media::put_image).delete(routes::owner::media::delete_image),
        )
        .route("/owner/media-usage", get(routes::owner::media::usage))
        .route("/owner/shops/{shop_id}/stock", get(routes::owner::stock::shop_stock))
        .route("/owner/ingredients", post(routes::owner::stock::create_ingredient))
        .route("/owner/ingredients/{id}", put(routes::owner::stock::update_ingredient))
        .route("/owner/ingredients/{id}/restock", post(routes::owner::stock::restock))
        .route("/owner/ingredients/{id}/count", post(routes::owner::stock::count))
        .route("/owner/recipe", put(routes::owner::stock::put_recipe))
        // Owner order view, discounts, cancel, refunds (M1-4a).
        .route(
            "/owner/shops/{shop_id}/orders",
            get(routes::owner::orders::day_list),
        )
        .route("/owner/orders/{id}/discount", post(routes::owner::orders::discount))
        .route("/owner/orders/{id}/cancel", post(routes::owner::orders::cancel))
        .route("/owner/payments/{id}/refund", post(routes::owner::orders::refund))
        .route(
            "/owner/shops",
            get(routes::owner::shops::list).post(routes::owner::shops::create),
        )
        // Menu master data of one shop (M1-1a): menu items, option groups,
        // options and the per-channel delivery markup.
        .route(
            "/owner/shops/{shop_id}/menu",
            get(routes::owner::menu::shop_menu),
        )
        .route(
            "/owner/shops/{shop_id}/channel-markup",
            put(routes::owner::menu::put_channel_markup),
        )
        .route("/owner/menu-items", post(routes::owner::menu::create_menu_item))
        .route(
            "/owner/menu-items/{id}",
            put(routes::owner::menu::update_menu_item).delete(routes::owner::menu::delete_menu_item),
        )
        .route(
            "/owner/option-groups",
            post(routes::owner::menu::create_option_group),
        )
        .route(
            "/owner/option-groups/{id}",
            put(routes::owner::menu::update_option_group)
                .delete(routes::owner::menu::delete_option_group),
        )
        .route("/owner/options", post(routes::owner::menu::create_option))
        .route(
            "/owner/options/{id}",
            put(routes::owner::menu::update_option)
                .delete(routes::owner::menu::delete_option),
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
        .fallback(routes::not_found);

    // Same Worker serves the SPA (static assets) and the API; only /api/* reaches
    // this router (wrangler.toml run_worker_first), so owner.<domain> and
    // pos.<domain> call the API same-origin and Access covers owner calls.
    Router::new()
        .nest("/api", api)
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
