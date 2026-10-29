//! `/orders` - staff order taking (ROADMAP M1-2a; FEATURES 3.10-3.12, 3.16, 3.19).
//!
//! Endpoints (staff auth: `shop_id` and `created_by` ALWAYS come from the
//! session, never from the request body, so one shop's staff can neither write
//! nor read another shop's bills):
//! - `POST /orders`       key an order (idempotent by client id, 3.70)
//! - `GET  /orders`       the queue screen feed (3.19)
//! - `GET  /orders/{id}`  one order with its lines
//!
//! The client never sends prices: every line is priced server-side by
//! [`crate::pricing`] from the menu rows of the session shop at the moment the
//! bill is keyed, and the priced line (unit price, option snapshot, item name)
//! is frozen into the append-only `order_items` row (schema 0001 + 0003), so a
//! later menu or price edit can never change an old bill. Discounts stay 0
//! here - they are owner-only (3.27, later ticket).
//!
//! Queue numbers (3.11) run per shop per Bangkok calendar day (UTC+7, no DST)
//! and are assigned INSIDE the insert, so two concurrent orders can never take
//! the same number.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worker::Env;

use crate::auth::staff::StaffAuth;
use crate::extract::ApiJson;
use crate::pricing::{line_total, price_line, PricingGroup, PricingItem, PricingOption};
use crate::routes::owner::menu::{MenuItem, MenuOption, OptionGroup};
use crate::util::{int, now_ms, opt_txt, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

/// Bangkok is UTC+7 all year (no DST), so the sale day boundary is a fixed
/// offset from UTC.
const BANGKOK_OFFSET_MS: i64 = 7 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Lines on one bill (bigger orders go in as two bills, 3.10). Also keeps the
/// `IN (...)` lists of the create path well below D1's 100 bound parameters.
const MAX_LINES: usize = 50;
/// Closed (paid|cancelled) orders on the queue screen: newest 100 of today.
const MAX_CLOSED: i64 = 100;
/// table_no is free text, 1..=20 characters after trimming (3.11).
const MAX_TABLE_NO_CHARS: usize = 20;
/// Bill/line notes are at most 200 characters (3.12).
const MAX_NOTE_CHARS: usize = 200;

/// Column lists mirror `routes::owner::menu` one-to-one (the shared row
/// structs deserialize them); local consts keep that module's SQL untouched.
/// `NULL AS cost`: the per-plate cost is owner-only data (margins), never read
/// on a staff order path.
const ITEM_COLUMNS: &str = "id, shop_id, name, category, menu_type, base_price, price_2, \
     price_3, grab_price, lineman_price, foodpanda_price, NULL AS cost, image_key, sold_out, status, \
     sort_order, created_at, updated_at";
const GROUP_COLUMNS: &str = "id, shop_id, menu_item_id, name, required, max_select, \
     tier_pricing, sort_order, created_at, updated_at";
const OPTION_COLUMNS: &str = "id, shop_id, option_group_id, name, price_add, sold_out, \
     sort_order, created_at, updated_at";
/// One orders row: exactly the fields the order JSON needs.
const ORDER_COLUMNS: &str = "id, queue_number, order_type, channel, table_no, note, status, \
     total_amount, discount_amount, created_by, created_at, paid_at, cancelled_at, cancel_reason";
/// One order_items row: the JSON fields plus `order_id` to group lines under
/// their bill.
const ITEM_COLUMNS_SQL: &str = "id, order_id, menu_item_id, item_name, options_json, quantity, \
     note, unit_price, discount_amount, line_total";

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOrderBody {
    pub id: String,
    /// "dine_in" | "take_away" | "delivery" (schema 0001, 3.10).
    pub order_type: String,
    /// "counter" | "grab" | "lineman" | "foodpanda" (schema 0001, 3.16).
    pub channel: String,
    pub table_no: Option<String>,
    pub note: Option<String>,
    pub items: Vec<CreateOrderItemBody>,
}

/// One order line as the POS keys it: ids and quantities only, never prices.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOrderItemBody {
    pub id: String,
    pub menu_item_id: String,
    pub option_ids: Vec<String>,
    pub quantity: i64,
    pub note: Option<String>,
}

/// The option snapshot stored in order_items.options_json and echoed back in
/// every order JSON ([`pricing::SelectedOption`] in storage shape).
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OptionSnapshot {
    pub id: String,
    pub name: String,
    pub price_add: i64,
}

#[derive(Debug, Serialize)]
pub struct OrderItemJson {
    pub id: String,
    pub menu_item_id: String,
    pub item_name: String,
    pub options: Vec<OptionSnapshot>,
    pub quantity: i64,
    pub note: Option<String>,
    pub unit_price: i64,
    pub discount_amount: i64,
    pub line_total: i64,
}

#[derive(Debug, Serialize)]
pub struct OrderJson {
    pub id: String,
    pub queue_number: i64,
    pub order_type: String,
    pub channel: String,
    pub table_no: Option<String>,
    pub note: Option<String>,
    pub status: String,
    pub total_amount: i64,
    pub discount_amount: i64,
    pub created_by: String,
    pub created_at: i64,
    pub paid_at: Option<i64>,
    pub cancelled_at: Option<i64>,
    pub cancel_reason: Option<String>,
    pub items: Vec<OrderItemJson>,
}

/// `GET /orders` payload.
#[derive(Debug, Serialize)]
pub struct OrdersJson {
    pub orders: Vec<OrderJson>,
}

/// One orders row as D1 returns it (booleans never appear here; every column
/// in ORDER_COLUMNS is text or integer).
#[derive(Debug, Deserialize)]
struct OrderRow {
    id: String,
    queue_number: i64,
    order_type: String,
    channel: String,
    table_no: Option<String>,
    note: Option<String>,
    status: String,
    total_amount: i64,
    discount_amount: i64,
    created_by: String,
    created_at: i64,
    paid_at: Option<i64>,
    cancelled_at: Option<i64>,
    cancel_reason: Option<String>,
}

/// One order_items row as D1 returns it.
#[derive(Debug, Deserialize)]
struct ItemRow {
    id: String,
    order_id: String,
    menu_item_id: String,
    item_name: String,
    options_json: String,
    quantity: i64,
    note: Option<String>,
    unit_price: i64,
    discount_amount: i64,
    line_total: i64,
}

/// A validated request line, before pricing.
#[derive(Debug)]
struct NewLine {
    id: String,
    menu_item_id: String,
    option_ids: Vec<String>,
    quantity: i64,
    note: Option<String>,
}

/// A priced request line, ready to insert.
struct PricedNewLine {
    id: String,
    menu_item_id: String,
    item_name: String,
    options: Vec<OptionSnapshot>,
    quantity: i64,
    note: Option<String>,
    unit_price: i64,
    line_total: i64,
}

/// The session shop's menu as pricing needs it, loaded once per bill.
struct ShopPricing {
    items: HashMap<String, MenuItem>,
    groups: Vec<PricingGroup>,
    markup: Value,
}

// ---------------------------------------------------------------------------
// Pure validation (unit-tested on the host, see `mod tests` below)
// ---------------------------------------------------------------------------

/// order_type/channel must satisfy the orders CHECK of schema 0001 (3.10,
/// 3.16): dine_in and take_away are sold at the counter, delivery only through
/// a delivery app (keyed by hand, never via an API).
fn validate_order_type_channel(order_type: &str, channel: &str) -> Result<(), ApiError> {
    let ok = match order_type {
        "dine_in" | "take_away" => channel == "counter",
        "delivery" => matches!(channel, "grab" | "lineman" | "foodpanda"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "channel '{channel}' does not match order_type '{order_type}': \
             dine_in/take_away need counter, delivery needs grab/lineman/foodpanda"
        )))
    }
}

/// Start of the Bangkok (UTC+7) calendar day that `now_ms` falls in, in unix
/// ms. Queue numbers run per shop per day (3.11) and the shop clock is
/// Bangkok time, so the day boundary is 17:00 UTC. Floor division keeps the
/// math right for instants before 1970 as well.
fn bangkok_day_start_ms(now_ms: i64) -> i64 {
    (now_ms + BANGKOK_OFFSET_MS).div_euclid(DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS
}

/// table_no (3.11): optional free text, trimmed, 1..=20 chars, empty -> NULL.
fn clean_table_no(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_TABLE_NO_CHARS {
        return Err(ApiError::BadRequest(format!(
            "table_no must be 1-{MAX_TABLE_NO_CHARS} characters"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

/// Bill/line notes (3.12): optional, trimmed, at most 200 chars, empty -> NULL.
fn clean_note(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_NOTE_CHARS {
        return Err(ApiError::BadRequest(format!(
            "note must be at most {MAX_NOTE_CHARS} characters"
        )));
    }
    Ok(Some(trimmed.to_owned()))
}

/// Validates and normalizes every request line: 1..=MAX_LINES lines, uuid ids
/// (order id, menu item id, every option id), no repeated line id, bounded
/// notes. Quantity is priced/checked by [`crate::pricing::line_total`].
fn parse_lines(items: &[CreateOrderItemBody]) -> Result<Vec<NewLine>, ApiError> {
    if items.is_empty() || items.len() > MAX_LINES {
        return Err(ApiError::BadRequest(format!(
            "items must hold 1-{MAX_LINES} lines"
        )));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut lines = Vec::with_capacity(items.len());
    for item in items {
        let id = parse_uuid(&item.id, "items[].id")?.to_string();
        if !seen.insert(id.clone()) {
            return Err(ApiError::BadRequest(format!(
                "order line {id} appears more than once"
            )));
        }
        let mut option_ids = Vec::with_capacity(item.option_ids.len());
        for option_id in &item.option_ids {
            option_ids.push(parse_uuid(option_id, "items[].option_ids")?.to_string());
        }
        lines.push(NewLine {
            id,
            menu_item_id: parse_uuid(&item.menu_item_id, "items[].menu_item_id")?.to_string(),
            option_ids,
            quantity: item.quantity,
            note: clean_note(item.note.as_deref())?,
        });
    }
    Ok(lines)
}

/// The distinct menu item ids a bill references, in first-seen order.
fn menu_item_ids(lines: &[NewLine]) -> Vec<String> {
    let mut seen = HashSet::new();
    lines
        .iter()
        .map(|line| line.menu_item_id.clone())
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// `?from, ?from+1, ...` for an IN list of `n` values. Callers stay under
/// D1's 100 bound parameters (n <= MAX_LINES).
fn placeholders(from: usize, n: usize) -> String {
    (from..from + n)
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `MenuItem` row -> [`PricingItem`] (field for field; pricing never sees
/// shop_id, category or cost).
fn pricing_item(item: &MenuItem) -> PricingItem {
    PricingItem {
        id: item.id.clone(),
        menu_type: item.menu_type.clone(),
        base_price: item.base_price,
        price_2: item.price_2,
        price_3: item.price_3,
        grab_price: item.grab_price,
        lineman_price: item.lineman_price,
        foodpanda_price: item.foodpanda_price,
        status: item.status.clone(),
        sold_out: item.sold_out,
    }
}

/// The shop's option groups + options -> the flat [`PricingGroup`] list that
/// [`crate::pricing::price_line`] filters per item. Options only ever land in
/// their own group; a group without options still applies (a required group
/// with no pick is rejected by pricing).
fn pricing_groups(groups: &[OptionGroup], options: &[MenuOption]) -> Vec<PricingGroup> {
    let mut by_group: HashMap<&str, Vec<PricingOption>> = HashMap::new();
    for option in options {
        by_group
            .entry(option.option_group_id.as_str())
            .or_default()
            .push(PricingOption {
                id: option.id.clone(),
                name: option.name.clone(),
                price_add: option.price_add,
                sold_out: option.sold_out,
            });
    }
    groups
        .iter()
        .map(|group| PricingGroup {
            id: group.id.clone(),
            menu_item_id: group.menu_item_id.clone(),
            name: group.name.clone(),
            required: group.required,
            max_select: group.max_select,
            tier_pricing: group.tier_pricing,
            options: by_group.remove(group.id.as_str()).unwrap_or_default(),
        })
        .collect()
}

/// One order_items row -> its JSON. options_json was written by this module, so
/// anything unparsable is a corrupt row (500, not a client error).
fn item_json(row: ItemRow) -> Result<OrderItemJson, ApiError> {
    let options: Vec<OptionSnapshot> = serde_json::from_str(&row.options_json).map_err(|e| {
        ApiError::Internal(format!("order item {} has invalid options_json: {e}", row.id))
    })?;
    Ok(OrderItemJson {
        id: row.id,
        menu_item_id: row.menu_item_id,
        item_name: row.item_name,
        options,
        quantity: row.quantity,
        note: row.note,
        unit_price: row.unit_price,
        discount_amount: row.discount_amount,
        line_total: row.line_total,
    })
}

/// Buckets item rows under their order id, keeping row (insert) order.
fn bucket_items(rows: Vec<ItemRow>) -> Result<HashMap<String, Vec<OrderItemJson>>, ApiError> {
    let mut lines: HashMap<String, Vec<OrderItemJson>> = HashMap::new();
    for row in rows {
        let order_id = row.order_id.clone();
        lines.entry(order_id).or_default().push(item_json(row)?);
    }
    Ok(lines)
}

/// Joins order rows with their (already bucketed) lines, preserving the order
/// of `orders` - the callers sort, this fn only attaches.
fn assemble_orders(
    orders: Vec<OrderRow>,
    items: Vec<ItemRow>,
) -> Result<Vec<OrderJson>, ApiError> {
    let mut lines = bucket_items(items)?;
    Ok(orders
        .into_iter()
        .map(|order| {
            let items = lines.remove(&order.id).unwrap_or_default();
            order_json(order, items)
        })
        .collect())
}

/// One orders row plus its lines -> the order JSON of every endpoint here.
fn order_json(order: OrderRow, items: Vec<OrderItemJson>) -> OrderJson {
    OrderJson {
        id: order.id,
        queue_number: order.queue_number,
        order_type: order.order_type,
        channel: order.channel,
        table_no: order.table_no,
        note: order.note,
        status: order.status,
        total_amount: order.total_amount,
        discount_amount: order.discount_amount,
        created_by: order.created_by,
        created_at: order.created_at,
        paid_at: order.paid_at,
        cancelled_at: order.cancelled_at,
        cancel_reason: order.cancel_reason,
        items,
    }
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

/// shop_id of the order with this id, if any (idempotency check; ids are
/// client UUIDs, so the same id can only exist once, in one shop).
async fn order_shop(env: &Env, id: &str) -> Result<Option<String>, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT shop_id FROM orders WHERE id = ?1")
        .bind(&[txt(id)])?
        .first::<String>(Some("shop_id"))
        .await?)
}

/// The first of these order-line ids that already exists (PK on order_items).
async fn existing_line_id(env: &Env, ids: &[String]) -> Result<Option<String>, ApiError> {
    let params: Vec<_> = ids.iter().map(|id| txt(id)).collect();
    Ok(db::db(env)?
        .prepare(format!(
            "SELECT id FROM order_items WHERE id IN ({})",
            placeholders(1, ids.len())
        ))
        .bind(&params)?
        .first::<String>(Some("id"))
        .await?)
}

/// One order of this shop with its lines, or None if it does not exist / belongs
/// to another shop. Two queries: the bill and its lines.
async fn load_order(env: &Env, shop_id: &str, id: &str) -> Result<Option<OrderJson>, ApiError> {
    let Some(order) = db::db(env)?
        .prepare(format!(
            "SELECT {ORDER_COLUMNS} FROM orders WHERE id = ?1 AND shop_id = ?2"
        ))
        .bind(&[txt(id), txt(shop_id)])?
        .first::<OrderRow>(None)
        .await?
    else {
        return Ok(None);
    };
    let items = db::db(env)?
        .prepare(format!(
            "SELECT {ITEM_COLUMNS_SQL}
             FROM order_items
             WHERE order_id = ?1 AND shop_id = ?2
             ORDER BY rowid"
        ))
        .bind(&[txt(id), txt(shop_id)])?
        .all()
        .await?
        .results::<ItemRow>()?;
    // One input row -> exactly one assembled order.
    Ok(assemble_orders(vec![order], items)?.pop())
}

/// The menu of the session shop as pricing needs it, loaded ONCE per bill:
/// the referenced menu items of this shop (so an id of another shop never
/// comes back), every option group + option of the shop, and the channel
/// markup. Four statements, none per line.
async fn load_shop_pricing(
    env: &Env,
    shop_id: &str,
    item_ids: &[String],
) -> Result<ShopPricing, ApiError> {
    let mut params: Vec<_> = vec![txt(shop_id)];
    params.extend(item_ids.iter().map(|id| txt(id)));
    let items = db::db(env)?
        .prepare(format!(
            "SELECT {ITEM_COLUMNS}
             FROM menu_items
             WHERE shop_id = ?1 AND id IN ({})",
            placeholders(2, item_ids.len())
        ))
        .bind(&params)?
        .all()
        .await?
        .results::<MenuItem>()?;
    let option_groups = db::db(env)?
        .prepare(format!(
            "SELECT {GROUP_COLUMNS}
             FROM option_groups
             WHERE shop_id = ?1
             ORDER BY sort_order, created_at, id"
        ))
        .bind(&[txt(shop_id)])?
        .all()
        .await?
        .results::<OptionGroup>()?;
    let options = db::db(env)?
        .prepare(format!(
            "SELECT {OPTION_COLUMNS}
             FROM options
             WHERE shop_id = ?1
             ORDER BY sort_order, created_at, id"
        ))
        .bind(&[txt(shop_id)])?
        .all()
        .await?
        .results::<MenuOption>()?;
    let Some(markup_json) = db::db(env)?
        .prepare("SELECT channel_markup_json FROM shops WHERE id = ?1")
        .bind(&[txt(shop_id)])?
        .first::<String>(Some("channel_markup_json"))
        .await?
    else {
        // The session is authenticated against this shop, so a missing row is
        // a data problem, not a client error.
        return Err(ApiError::Internal(format!("shop {shop_id} vanished")));
    };
    let markup: Value = serde_json::from_str(&markup_json).map_err(|e| {
        ApiError::Internal(format!("shop {shop_id} has invalid channel_markup_json: {e}"))
    })?;

    Ok(ShopPricing {
        items: items.into_iter().map(|item| (item.id.clone(), item)).collect(),
        groups: pricing_groups(&option_groups, &options),
        markup,
    })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Key an order (3.10-3.12, 3.16). Idempotent (offline retries, 3.70): the
/// same order id in the same shop replays as `200` with the STORED order; the
/// same id under another shop is a `409`; an order-line id that already exists
/// is a `409` too. The bill (order row + every line) goes in as ONE D1 batch,
/// i.e. atomically - a half-written bill can never exist.
#[worker::send]
pub async fn create(
    State(state): State<AppState>,
    staff: StaffAuth,
    ApiJson(body): ApiJson<CreateOrderBody>,
) -> Result<Response, ApiError> {
    let shop_id = staff.shop_id;
    let order_id = parse_uuid(&body.id, "id")?.to_string();
    validate_order_type_channel(&body.order_type, &body.channel)?;
    let table_no = clean_table_no(body.table_no.as_deref())?;
    let note = clean_note(body.note.as_deref())?;
    let lines = parse_lines(&body.items)?;
    let env = &state.env;

    // Idempotency first, before any menu read: a retry must replay even if the
    // menu (prices, sold-out flags) has changed since the original insert.
    if let Some(owner) = order_shop(env, &order_id).await? {
        if owner != shop_id {
            return Err(ApiError::Conflict(format!(
                "order {order_id} already exists with a different shop_id"
            )));
        }
        let stored = load_order(env, &shop_id, &order_id).await?.ok_or_else(|| {
            ApiError::Internal(format!("order {order_id} vanished mid-replay"))
        })?;
        return Ok(Json(stored).into_response());
    }
    let line_ids: Vec<String> = lines.iter().map(|line| line.id.clone()).collect();
    if let Some(line_id) = existing_line_id(env, &line_ids).await? {
        return Err(ApiError::Conflict(format!(
            "order line {line_id} already exists"
        )));
    }

    // Price every line server-side from the shop's menu (the client never
    // sends prices).
    let menu = load_shop_pricing(env, &shop_id, &menu_item_ids(&lines)).await?;
    let mut priced: Vec<PricedNewLine> = Vec::with_capacity(lines.len());
    let mut total_amount = 0_i64;
    for line in &lines {
        let Some(item) = menu.items.get(&line.menu_item_id) else {
            return Err(ApiError::BadRequest(format!(
                "menu item {} is not on this shop's menu",
                line.menu_item_id
            )));
        };
        let unit = price_line(
            &pricing_item(item),
            &menu.groups,
            &body.channel,
            &menu.markup,
            &line.option_ids,
        )?;
        let line_amount = line_total(unit.unit_price, line.quantity)?;
        total_amount = total_amount
            .checked_add(line_amount)
            .ok_or_else(|| ApiError::Internal("order total overflows the satang range".into()))?;
        priced.push(PricedNewLine {
            id: line.id.clone(),
            menu_item_id: line.menu_item_id.clone(),
            item_name: item.name.clone(),
            options: unit
                .options
                .iter()
                .map(|o| OptionSnapshot {
                    id: o.id.clone(),
                    name: o.name.clone(),
                    price_add: o.price_add,
                })
                .collect(),
            quantity: line.quantity,
            note: line.note.clone(),
            unit_price: unit.unit_price,
            line_total: line_amount,
        });
    }

    let now = now_ms();
    let day_start = bangkok_day_start_ms(now);

    // The queue number is assigned INSIDE the insert: COALESCE(MAX, 0) + 1 over
    // today's (Bangkok day) rows of this shop, so concurrent orders can never
    // share a number. The aggregate always yields exactly one row.
    let mut statements = vec![db::db(env)?
        .prepare(
            "INSERT INTO orders
               (id, shop_id, queue_number, table_no, order_type, channel, status,
                discount_amount, total_amount, note, created_by, shift_id,
                created_at, updated_at)
             SELECT ?1, ?2, COALESCE(MAX(queue_number), 0) + 1, ?3, ?4, ?5, 'preparing',
                    0, ?6, ?7, ?8, NULL, ?9, ?9
             FROM orders
             WHERE shop_id = ?2 AND created_at >= ?10",
        )
        .bind(&[
            txt(&order_id),
            txt(&shop_id),
            opt_txt(table_no.as_deref()),
            txt(&body.order_type),
            txt(&body.channel),
            int(total_amount),
            opt_txt(note.as_deref()),
            txt(&staff.user_id),
            int(now),
            int(day_start),
        ])?];

    for line in &priced {
        let options_json = serde_json::to_string(&line.options)
            .map_err(|e| ApiError::Internal(format!("options serialization failed: {e}")))?;
        statements.push(
            db::db(env)?
                .prepare(
                    "INSERT INTO order_items
                       (id, shop_id, order_id, menu_item_id, item_name, options_json,
                        quantity, note, unit_price, discount_amount, line_total,
                        created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?11)",
                )
                .bind(&[
                    txt(&line.id),
                    txt(&shop_id),
                    txt(&order_id),
                    txt(&line.menu_item_id),
                    txt(&line.item_name),
                    txt(&options_json),
                    int(line.quantity),
                    opt_txt(line.note.as_deref()),
                    int(line.unit_price),
                    int(line.line_total),
                    int(now),
                ])?,
        );
    }
    db::db(env)?.batch(statements).await?;

    // The stored queue number was computed by the INSERT above, so read the
    // bill back (same JSON as GET /orders/{id}).
    let order = load_order(env, &shop_id, &order_id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("order {order_id} vanished right after insert")))?;
    Ok((StatusCode::CREATED, Json(order)).into_response())
}

/// The queue screen feed (3.19): every preparing/served order of the session
/// shop (any day, oldest first), then today's (Bangkok day) paid/cancelled
/// orders (newest first, at most 100) with their history kept visible. Three
/// queries in total - the items of both halves are fetched in one go, never
/// per order.
#[worker::send]
pub async fn list(
    State(state): State<AppState>,
    staff: StaffAuth,
) -> Result<Json<OrdersJson>, ApiError> {
    let shop_id = staff.shop_id;
    let env = &state.env;
    let day_start = bangkok_day_start_ms(now_ms());

    let mut orders = db::db(env)?
        .prepare(format!(
            "SELECT {ORDER_COLUMNS}
             FROM orders
             WHERE shop_id = ?1 AND status IN ('preparing', 'served')
             ORDER BY created_at, id"
        ))
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<OrderRow>()?;
    let mut closed = db::db(env)?
        .prepare(format!(
            "SELECT {ORDER_COLUMNS}
             FROM orders
             WHERE shop_id = ?1 AND status IN ('paid', 'cancelled') AND created_at >= ?2
             ORDER BY created_at DESC, id DESC
             LIMIT {MAX_CLOSED}"
        ))
        .bind(&[txt(&shop_id), int(day_start)])?
        .all()
        .await?
        .results::<OrderRow>()?;
    orders.append(&mut closed);

    // The lines of exactly those bills, in one query: the subquery repeats the
    // two status windows above. The MAX_CLOSED cap is not re-applied here, so
    // lines of older closed orders may be read and then dropped while
    // assembling - harmless, and it keeps this at a single statement.
    let items = db::db(env)?
        .prepare(format!(
            "SELECT {ITEM_COLUMNS_SQL}
             FROM order_items
             WHERE shop_id = ?1
               AND order_id IN (SELECT id FROM orders
                                WHERE shop_id = ?1
                                  AND (status IN ('preparing', 'served')
                                       OR (status IN ('paid', 'cancelled')
                                           AND created_at >= ?2)))
             ORDER BY rowid"
        ))
        .bind(&[txt(&shop_id), int(day_start)])?
        .all()
        .await?
        .results::<ItemRow>()?;

    Ok(Json(OrdersJson {
        orders: assemble_orders(orders, items)?,
    }))
}

/// One order of the session shop with its lines. Another shop's id matches no
/// row here and therefore answers 404.
#[worker::send]
pub async fn get_order(
    State(state): State<AppState>,
    staff: StaffAuth,
    Path(id): Path<String>,
) -> Result<Json<OrderJson>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let order = load_order(&state.env, &staff.shop_id, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(order))
}

// ---------------------------------------------------------------------------
// Host unit tests (pure fns only - handlers need D1/the Workers runtime)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn bad<T: std::fmt::Debug>(result: Result<T, ApiError>) -> String {
        match result {
            Err(ApiError::BadRequest(msg)) => msg,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn order_type_and_channel_follow_the_schema_check() {
        // The three real combinations (3.10 + 3.16).
        assert!(validate_order_type_channel("dine_in", "counter").is_ok());
        assert!(validate_order_type_channel("take_away", "counter").is_ok());
        for channel in ["grab", "lineman", "foodpanda"] {
            assert!(validate_order_type_channel("delivery", channel).is_ok());
        }
        // Everything else, including unknown enum values, is a 400.
        assert!(bad(validate_order_type_channel("dine_in", "grab")).contains("does not match"));
        assert!(bad(validate_order_type_channel("take_away", "lineman")).contains("does not match"));
        assert!(bad(validate_order_type_channel("delivery", "counter")).contains("does not match"));
        assert!(bad(validate_order_type_channel("eat_in", "counter")).contains("does not match"));
        assert!(bad(validate_order_type_channel("dine_in", "shopee")).contains("does not match"));
    }

    #[test]
    fn bangkok_day_starts_at_17h_utc() {
        // 2024-01-15T00:00:00Z; midnight Bangkok is 17:00 UTC the day before.
        const JAN_15_00Z: i64 = 1_705_276_800_000;
        const JAN_14_17Z: i64 = JAN_15_00Z - 7 * 60 * 60 * 1000;
        const JAN_15_17Z: i64 = JAN_14_17Z + DAY_MS;
        // Exactly on the boundary, one ms before it, mid-day and the last ms
        // of the day all map to the same day start.
        assert_eq!(bangkok_day_start_ms(JAN_14_17Z), JAN_14_17Z);
        assert_eq!(bangkok_day_start_ms(JAN_14_17Z - 1), JAN_14_17Z - DAY_MS);
        assert_eq!(bangkok_day_start_ms(JAN_15_00Z), JAN_14_17Z);
        assert_eq!(bangkok_day_start_ms(JAN_15_17Z - 1), JAN_14_17Z);
        // 00:00 Bangkok is the start of the NEXT day.
        assert_eq!(bangkok_day_start_ms(JAN_15_17Z), JAN_15_17Z);
        assert_eq!(bangkok_day_start_ms(JAN_15_17Z + 1), JAN_15_17Z);
        // The epoch itself is 07:00 Bangkok, i.e. day 1 of Bangkok time, whose
        // start lies before 1970 (floor division, no negative surprises).
        assert_eq!(bangkok_day_start_ms(0), -BANGKOK_OFFSET_MS);
    }

    #[test]
    fn bangkok_day_start_is_always_a_whole_utc_day_at_17h() {
        for now in [
            0_i64,
            1,
            86_399_999,
            1_700_000_000_000,
            1_705_276_800_000,
            4_102_444_800_000, // 2100-01-01
        ] {
            let start = bangkok_day_start_ms(now);
            // 17:00 UTC sharp ...
            assert_eq!(start.rem_euclid(DAY_MS), 17 * 60 * 60 * 1000);
            // ... inside the day that contains `now` ...
            assert!(start <= now && now - start < DAY_MS);
            // ... and consecutive days are exactly one day apart.
            assert_eq!(bangkok_day_start_ms(start + DAY_MS) - start, DAY_MS);
        }
    }

    #[test]
    fn table_no_is_trimmed_optional_and_bounded() {
        assert_eq!(clean_table_no(None).unwrap(), None);
        assert_eq!(clean_table_no(Some("   ")).unwrap(), None);
        assert_eq!(clean_table_no(Some("  7  ")).unwrap().as_deref(), Some("7"));
        // 20 chars fits, 21 does not (chars, not bytes).
        assert_eq!(
            clean_table_no(Some(&"x".repeat(20))).unwrap().map(|s| s.chars().count()),
            Some(20)
        );
        assert!(bad(clean_table_no(Some(&"x".repeat(21)))).contains("table_no"));
    }

    #[test]
    fn notes_are_trimmed_optional_and_bounded() {
        assert_eq!(clean_note(None).unwrap(), None);
        assert_eq!(clean_note(Some("")).unwrap(), None);
        assert_eq!(
            clean_note(Some("  no chili ")).unwrap().as_deref(),
            Some("no chili")
        );
        assert_eq!(
            clean_note(Some(&"n".repeat(MAX_NOTE_CHARS))).unwrap().map(|n| n.chars().count()),
            Some(MAX_NOTE_CHARS)
        );
        assert!(bad(clean_note(Some(&"n".repeat(MAX_NOTE_CHARS + 1)))).contains("note"));
    }

    fn line_body(id: &str, menu_item_id: &str, quantity: i64) -> CreateOrderItemBody {
        CreateOrderItemBody {
            id: id.to_owned(),
            menu_item_id: menu_item_id.to_owned(),
            option_ids: Vec::new(),
            quantity,
            note: None,
        }
    }

    #[test]
    fn lines_are_bounded_and_ids_must_be_uuids() {
        let uuid = "11111111-1111-1111-1111-111111111111";
        // Zero lines is not a bill.
        assert!(bad(parse_lines(&[])).contains("1-50 lines"));
        // ... but 50 is, with or without picks.
        let fifty: Vec<_> = (0..MAX_LINES)
            .map(|i| line_body(&format!("00000000-0000-4000-8000-{i:012}"), uuid, 1))
            .collect();
        assert_eq!(parse_lines(&fifty).unwrap().len(), MAX_LINES);
        // Line ids are client UUIDs; a repeated line id is a client bug.
        assert!(bad(parse_lines(&[line_body("not-a-uuid", uuid, 1)])).contains("uuid"));
        let twice = vec![line_body(uuid, uuid, 1), line_body(uuid, uuid, 2)];
        assert!(bad(parse_lines(&twice)).contains("appears more than once"));
        // Notes ride along normalized; unknown option ids fail later, in pricing.
        let mut noted = line_body(uuid, uuid, 2);
        noted.note = Some("  extra rice ".to_owned());
        let parsed = parse_lines(&[noted]).unwrap();
        assert_eq!(parsed[0].note.as_deref(), Some("extra rice"));
        assert_eq!(parsed[0].quantity, 2);
        assert!(bad(parse_lines(&[line_body(uuid, "nope", 1)])).contains("uuid"));
    }

    #[test]
    fn menu_item_ids_are_distinct_in_first_seen_order() {
        let uuid_a = "11111111-1111-1111-1111-111111111111";
        let uuid_b = "22222222-2222-2222-2222-222222222222";
        let lines = vec![
            line_body("00000000-0000-4000-8000-000000000001", uuid_a, 1),
            line_body("00000000-0000-4000-8000-000000000002", uuid_b, 1),
            line_body("00000000-0000-4000-8000-000000000003", uuid_a, 3),
        ];
        let lines = parse_lines(&lines).unwrap();
        assert_eq!(menu_item_ids(&lines), vec![uuid_a.to_owned(), uuid_b.to_owned()]);
        // The IN-list placeholders start after ?1 and cover every id.
        assert_eq!(placeholders(2, 3), "?2, ?3, ?4");
        assert_eq!(placeholders(1, 1), "?1");
    }

    fn item_row(id: &str, order_id: &str, options_json: &str, line_total: i64) -> ItemRow {
        ItemRow {
            id: id.to_owned(),
            order_id: order_id.to_owned(),
            menu_item_id: "menu-1".to_owned(),
            item_name: "rice with curry".to_owned(),
            options_json: options_json.to_owned(),
            quantity: 2,
            note: None,
            unit_price: 5000,
            discount_amount: 0,
            line_total,
        }
    }

    fn order_row(id: &str, status: &str) -> OrderRow {
        OrderRow {
            id: id.to_owned(),
            queue_number: 17,
            order_type: "dine_in".to_owned(),
            channel: "counter".to_owned(),
            table_no: Some("7".to_owned()),
            note: None,
            status: status.to_owned(),
            total_amount: 10_000,
            discount_amount: 0,
            created_by: "staff-1".to_owned(),
            created_at: 1_705_276_800_000,
            paid_at: None,
            cancelled_at: None,
            cancel_reason: None,
        }
    }

    #[test]
    fn items_land_in_their_own_bill_and_keep_insert_order() {
        let orders = assemble_orders(
            vec![order_row("o-1", "preparing"), order_row("o-2", "served")],
            vec![
                item_row("l-1", "o-2", "[]", 5000),
                item_row("l-2", "o-1", r#"[{"id":"op-1","name":"egg","price_add":1000}]"#, 6000),
                item_row("l-3", "o-1", "[]", 7000),
            ],
        )
        .unwrap();
        assert_eq!(orders.len(), 2);
        // o-1 keeps its two lines in row (keyed) order, o-2 its one.
        assert_eq!(
            orders[0].items.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["l-2", "l-3"]
        );
        assert_eq!(orders[1].items.len(), 1);
        // options_json is parsed back into the snapshot objects.
        assert_eq!(
            orders[0].items[0].options,
            vec![OptionSnapshot {
                id: "op-1".to_owned(),
                name: "egg".to_owned(),
                price_add: 1000,
            }]
        );
        assert_eq!(orders[0].items[0].line_total, 6000);
        assert_eq!(orders[0].status, "preparing");
    }

    #[test]
    fn orders_without_items_come_back_empty_but_kept() {
        // An order whose lines are outside the fetched window still appears on
        // the queue screen (empty items), instead of being dropped.
        let orders = assemble_orders(vec![order_row("o-1", "paid")], Vec::new()).unwrap();
        assert_eq!(orders.len(), 1);
        assert!(orders[0].items.is_empty());
    }

    fn menu_option(id: &str, group_id: &str, price_add: i64) -> MenuOption {
        MenuOption {
            id: id.to_owned(),
            shop_id: "shop".to_owned(),
            option_group_id: group_id.to_owned(),
            name: format!("opt {id}"),
            price_add,
            sold_out: false,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn option_group(id: &str, menu_item_id: Option<&str>) -> OptionGroup {
        OptionGroup {
            id: id.to_owned(),
            shop_id: "shop".to_owned(),
            menu_item_id: menu_item_id.map(str::to_owned),
            name: format!("group {id}"),
            required: false,
            max_select: None,
            tier_pricing: false,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn options_only_land_in_their_own_group() {
        let groups = pricing_groups(
            &[option_group("g-wide", None), option_group("g-item", Some("menu-1"))],
            &[
                menu_option("op-wide", "g-wide", 500),
                menu_option("op-item", "g-item", 1000),
                menu_option("op-orphan", "g-missing", 2000),
            ],
        );
        assert_eq!(groups.len(), 2);
        // Shop-wide group keeps menu_item_id NULL (pricing applies it to every
        // item), the item group keeps its link; the orphan option is dropped.
        assert_eq!(groups[0].menu_item_id, None);
        assert_eq!(
            groups[0].options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            vec!["op-wide"]
        );
        assert_eq!(groups[1].menu_item_id.as_deref(), Some("menu-1"));
        assert_eq!(
            groups[1].options.iter().map(|o| o.price_add).collect::<Vec<_>>(),
            vec![1000]
        );
    }

    #[test]
    fn menu_rows_map_onto_the_pricing_structs() {
        let item = MenuItem {
            id: "menu-1".to_owned(),
            shop_id: "shop".to_owned(),
            name: "rice with curry".to_owned(),
            category: "rice".to_owned(),
            menu_type: "rice_curry".to_owned(),
            base_price: 5000,
            price_2: Some(6000),
            price_3: None,
            grab_price: Some(7000),
            lineman_price: None,
            foodpanda_price: None,
            cost: None,
            image_key: None,
            sold_out: true,
            status: "active".to_owned(),
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        };
        assert_eq!(
            pricing_item(&item),
            PricingItem {
                id: "menu-1".to_owned(),
                menu_type: "rice_curry".to_owned(),
                base_price: 5000,
                price_2: Some(6000),
                price_3: None,
                grab_price: Some(7000),
                lineman_price: None,
                foodpanda_price: None,
                status: "active".to_owned(),
                sold_out: true,
            }
        );
        // End to end: the mapped shapes drive the real pricing engine.
        let groups = pricing_groups(
            &[option_group("g", None)],
            &[menu_option("op", "g", 1000)],
        );
        // Sold out items are rejected before the picks are even looked at.
        assert!(bad(price_line(
            &pricing_item(&item),
            &groups,
            "counter",
            &serde_json::json!({}),
            &["op".to_owned()]
        ))
        .contains("not available"));
        let mut sellable = item.clone();
        sellable.sold_out = false;
        let priced_ok =
            price_line(&pricing_item(&sellable), &groups, "counter", &serde_json::json!({}), &["op".to_owned()])
                .unwrap();
        assert_eq!(priced_ok.unit_price, 5000 + 1000);
        assert_eq!(priced_ok.options.len(), 1);
    }
}
