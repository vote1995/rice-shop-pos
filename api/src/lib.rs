//! Rice-shop POS API — Rust on Cloudflare Workers.
//!
//! Entry point: `#[event(fetch)]` hands the request to an axum `Router`
//! (following the official workers-rs axum example). Modules:
//! - [`routes`] — HTTP handlers, grouped per resource
//! - [`db`]     — helpers around D1/R2 bindings
//! - [`error`]  — the JSON error type used by every handler
//! - [`media`]  — R2 menu images + app-enforced free-tier quotas
//! - [`pricing`] — the pure order-line pricing engine (no D1, no worker types)
//! - [`cors`]   — opt-in allowlist CORS for the Capacitor Android staff POS

use axum::{
    routing::{delete, get, post, put},
    Router,
};
use tower_service::Service;
use worker::*;

mod auth;
mod beam;
mod cors;
mod db;
mod error;
mod extract;
mod loyalty;
mod media;
mod pricing;
mod slips;
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
        .route("/public/join/{shop_id}", get(routes::members::join_info).post(routes::members::join))
        .route("/members/lookup", post(routes::members::lookup))
        .route("/orders/{id}/member", put(routes::members::set_member))
        .route("/owner/shops/{shop_id}/customers", get(routes::members::owner_list))
        .route("/owner/customers/{id}", delete(routes::members::owner_delete))
        // Device lifecycle + staff PIN login: public in the sense that they
        // authenticate with the device token / session token, not owner auth.
        .route("/device/register", post(routes::device::register))
        .route("/device/status", get(routes::device::status))
        .route("/device/staff", get(routes::device::staff))
        .route("/auth/pin", post(routes::staff_auth::pin))
        .route("/auth/logout", post(routes::staff_auth::logout))
        .route("/staff/me", get(routes::staff_auth::me))
        .route("/staff/meals", get(routes::orders::staff_meals_today))
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
        .route("/orders/{id}/promptpay", post(routes::promptpay::create))
        .route(
            "/orders/{id}/promptpay/{payment_id}",
            get(routes::promptpay::status),
        )
        // Beam -> us: authenticated by X-Beam-Signature, no session.
        .route("/beam/webhook", post(routes::promptpay::webhook))
        .route("/payments/recent", get(routes::promptpay::recent))
        // Staff stock counting (blind, FEATURES 3.40): the sheet never shows
        // the system's estimate, so the counter has to look at the shelf.
        .route("/stock/count-sheet", get(routes::stock_count::count_sheet))
        .route("/stock/count", post(routes::stock_count::count))
        .route("/media/{*key}", get(routes::media::get_media))
        .route("/owner/me", get(routes::owner::me))
        .route(
            "/owner/menu-items/{id}/image",
            put(routes::owner::media::put_image).delete(routes::owner::media::delete_image),
        )
        .route("/owner/media-usage", get(routes::owner::media::usage))
        .route("/owner/shops/{shop_id}/stock", get(routes::owner::stock::shop_stock))
        .route("/owner/shops/{shop_id}/report", get(routes::owner::report::report))
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
        // Purchase-receipt reader (phase 1): upload + reader gateway, see crate::slips.
        .route(
            "/owner/slips",
            get(routes::owner::slips::list).post(routes::owner::slips::create),
        )
        .route(
            "/owner/slips/{id}",
            get(routes::owner::slips::get_slip).delete(routes::owner::slips::delete),
        )
        .route("/owner/slips/{id}/submit", post(routes::owner::slips::submit))
        .route(
            "/owner/slips/{id}/pages/{page}",
            get(routes::owner::slips::get_page).put(routes::owner::slips::put_page),
        )
        // The local reader agent (owner's PC); shared-secret auth, not Access.
        .route("/slip-agent/heartbeat", post(routes::slip_agent::heartbeat))
        .route("/slip-agent/claim", post(routes::slip_agent::claim))
        .route(
            "/slip-agent/slips/{id}/pages/{page}",
            get(routes::slip_agent::page),
        )
        .route(
            "/slip-agent/slips/{id}/result",
            post(routes::slip_agent::result),
        )
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
    // Opt-in CORS (api/src/cors.rs) wraps the router. With the allowlist empty
    // — or the request out of scope (no Origin, unlisted origin, /api/owner/*,
    // /api/beam/webhook) — `decide` says Passthrough and the request flows to
    // the router exactly as before, headers and OPTIONS handling included.
    let allowlist =
        cors::parse_allowlist(env.var(cors::ENV_VAR).ok().map(|v| v.to_string()).as_deref());
    use axum::http::header::{ACCESS_CONTROL_REQUEST_METHOD, ORIGIN};
    let origin = req
        .headers()
        .get(ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let decision = cors::decide(
        origin.as_deref(),
        req.method(),
        req.headers().contains_key(ACCESS_CONTROL_REQUEST_METHOD),
        req.uri().path(),
        &allowlist,
    );
    match decision {
        cors::Decision::Passthrough => Ok(router(env).call(req).await?),
        cors::Decision::Preflight => {
            Ok(cors::preflight_response(origin.as_deref().unwrap_or_default()))
        }
        cors::Decision::Allow => {
            let mut res = router(env).call(req).await?;
            if let Some(origin) = origin.as_deref() {
                cors::add_response_headers(res.headers_mut(), origin);
            }
            Ok(res)
        }
    }
}

/// Cron (wrangler.toml `[triggers]`, every minute): slip queue sweep —
/// expired reader leases back to the queue, cloud fallback while the PC is off.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if let Err(e) = slips::sweep(&env).await {
        console_error!("slip sweep failed: {e:?}");
    }
    if let Err(e) = loyalty::sweep_if_due(&env).await {
        console_error!("loyalty sweep failed: {e:?}");
    }
}
