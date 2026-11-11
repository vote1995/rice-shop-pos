//! `/owner/menu...` - menu master data of one shop (FEATURES 3.1-3.6, 3.9).
//!
//! Endpoints (all JSON, ids are client-generated UUIDs, FEATURES 3.70):
//! - `GET    /owner/shops/{shop_id}/menu`   whole menu of one shop (all statuses)
//! - `POST   /owner/menu-items`             create item (idempotent by id)
//! - `PUT    /owner/menu-items/{id}`        full replace; NO delete route (order_items reference items)
//! - `POST   /owner/option-groups`          create group (idempotent by id)
//! - `PUT    /owner/option-groups/{id}`     replace name/policy/sort
//! - `DELETE /owner/option-groups/{id}`     group + its options in one batch
//! - `POST   /owner/options`                create option (idempotent by id; shop_id from the group)
//! - `PUT    /owner/options/{id}`           replace name/price/sort/sold_out
//! - `DELETE /owner/options/{id}`
//! - `PUT    /owner/shops/{shop_id}/channel-markup`  delivery markup (3.6)
//!
//! Money is INTEGER satang everywhere (schema convention, migration 0001).
//! D1 hands booleans back as numbers 0/1, so row structs deserialize them
//! via [`bool_from_int`] and clients always see real JSON booleans.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use worker::Env;

use crate::util::{clean_name, int, now_ms, opt_int, opt_txt, parse_uuid, txt};
use crate::auth::owner::OwnerAuth;
use crate::extract::ApiJson;
use crate::stock;
use crate::{db, error::ApiError, AppState};

/// Upper bound for any money value handled here (10,000,000 satang = 100,000 THB).
const MAX_SATANG: i64 = 10_000_000;
/// Whole-percent markup cap (FEATURES 3.6): 0..=300 %.
const MAX_MARKUP_PERCENT: i64 = 300;

const MENU_TYPES: [&str; 2] = ["rice_curry", "made_to_order"];
const ITEM_STATUSES: [&str; 2] = ["active", "inactive"];

/// SQLite stores booleans as INTEGER 0/1; clients see real JSON booleans.
fn bool_from_int<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(i64::deserialize(deserializer)? != 0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MenuItem {
    pub id: String,
    pub shop_id: String,
    pub name: String,
    pub category: String,
    pub menu_type: String,
    pub base_price: i64,
    /// rice_curry plate with 2 curries; NULL for made_to_order (3.4).
    pub price_2: Option<i64>,
    /// rice_curry plate with 3 curries.
    pub price_3: Option<i64>,
    pub grab_price: Option<i64>,
    pub lineman_price: Option<i64>,
    pub foodpanda_price: Option<i64>,
    pub cost: Option<i64>,
    pub image_key: Option<String>,
    #[serde(deserialize_with = "bool_from_int")]
    pub sold_out: bool,
    pub status: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OptionGroup {
    pub id: String,
    pub shop_id: String,
    /// NULL = reusable group for the whole shop (schema 0001).
    pub menu_item_id: Option<String>,
    pub name: String,
    #[serde(deserialize_with = "bool_from_int")]
    pub required: bool,
    /// NULL = unlimited picks.
    pub max_select: Option<i64>,
    /// Pick count in this group selects base_price/price_2/price_3 (3.4).
    #[serde(deserialize_with = "bool_from_int")]
    pub tier_pricing: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MenuOption {
    pub id: String,
    pub shop_id: String,
    pub option_group_id: String,
    pub name: String,
    pub price_add: i64,
    /// Curry pot sold out (3.5).
    #[serde(deserialize_with = "bool_from_int")]
    pub sold_out: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateMenuItemBody {
    pub id: String,
    pub shop_id: String,
    pub name: String,
    pub category: String,
    pub menu_type: String,
    pub base_price: i64,
    pub price_2: Option<i64>,
    pub price_3: Option<i64>,
    pub grab_price: Option<i64>,
    pub lineman_price: Option<i64>,
    pub foodpanda_price: Option<i64>,
    pub cost: Option<i64>,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateMenuItemBody {
    pub name: String,
    pub category: String,
    pub menu_type: String,
    pub base_price: i64,
    pub price_2: Option<i64>,
    pub price_3: Option<i64>,
    pub grab_price: Option<i64>,
    pub lineman_price: Option<i64>,
    pub foodpanda_price: Option<i64>,
    pub cost: Option<i64>,
    pub sort_order: Option<i64>,
    pub status: String,
    pub sold_out: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOptionGroupBody {
    pub id: String,
    pub shop_id: String,
    pub menu_item_id: Option<String>,
    pub name: String,
    pub required: bool,
    pub max_select: Option<i64>,
    pub tier_pricing: bool,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateOptionGroupBody {
    pub name: String,
    pub required: bool,
    pub max_select: Option<i64>,
    pub tier_pricing: bool,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateOptionBody {
    pub id: String,
    pub option_group_id: String,
    pub name: String,
    pub price_add: i64,
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateOptionBody {
    pub name: String,
    pub price_add: i64,
    pub sort_order: Option<i64>,
    pub sold_out: bool,
}

/// One channel markup rule (FEATURES 3.6). `baht` value is satang per plate,
/// `percent` value is a whole percent.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarkupRule {
    pub kind: String,
    pub value: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelMarkupBody {
    pub grab: Option<MarkupRule>,
    pub lineman: Option<MarkupRule>,
    pub foodpanda: Option<MarkupRule>,
}

// ---------------------------------------------------------------------------
// Pure validation (unit-tested on the host, see `mod tests` below)
// ---------------------------------------------------------------------------

/// The fields shared by menu-item create and PUT bodies.
struct MenuPricing<'a> {
    menu_type: &'a str,
    base_price: i64,
    price_2: Option<i64>,
    price_3: Option<i64>,
    grab_price: Option<i64>,
    lineman_price: Option<i64>,
    foodpanda_price: Option<i64>,
    cost: Option<i64>,
    /// Only checked on PUT (create always inserts status='active').
    status: Option<&'a str>,
}

impl<'a> MenuPricing<'a> {
    fn from_create(body: &'a CreateMenuItemBody) -> Self {
        Self {
            menu_type: &body.menu_type,
            base_price: body.base_price,
            price_2: body.price_2,
            price_3: body.price_3,
            grab_price: body.grab_price,
            lineman_price: body.lineman_price,
            foodpanda_price: body.foodpanda_price,
            cost: body.cost,
            status: None,
        }
    }

    fn from_update(body: &'a UpdateMenuItemBody) -> Self {
        Self {
            menu_type: &body.menu_type,
            base_price: body.base_price,
            price_2: body.price_2,
            price_3: body.price_3,
            grab_price: body.grab_price,
            lineman_price: body.lineman_price,
            foodpanda_price: body.foodpanda_price,
            cost: body.cost,
            status: Some(&body.status),
        }
    }
}

/// Any satang amount this API accepts (prices, costs, price_add, baht markup).
fn check_satang(field: &str, value: i64) -> Result<(), ApiError> {
    if (0..=MAX_SATANG).contains(&value) {
        Ok(())
    } else {
        Err(ApiError::BadRequest(format!(
            "{field} must be between 0 and {MAX_SATANG} satang"
        )))
    }
}

/// Menu-item price rules (FEATURES 3.4): enum values, money bounds, and the
/// rice_curry 1-2-3 tier prices (only for rice_curry, filled bottom-up and
/// never cheaper with more curries).
fn validate_menu_pricing(p: &MenuPricing) -> Result<(), ApiError> {
    if !MENU_TYPES.contains(&p.menu_type) {
        return Err(ApiError::BadRequest(
            "menu_type must be one of: rice_curry, made_to_order".into(),
        ));
    }
    if let Some(status) = p.status {
        if !ITEM_STATUSES.contains(&status) {
            return Err(ApiError::BadRequest(
                "status must be one of: active, inactive".into(),
            ));
        }
    }
    check_satang("base_price", p.base_price)?;
    for (field, value) in [
        ("price_2", p.price_2),
        ("price_3", p.price_3),
        ("grab_price", p.grab_price),
        ("lineman_price", p.lineman_price),
        ("foodpanda_price", p.foodpanda_price),
        ("cost", p.cost),
    ] {
        if let Some(value) = value {
            check_satang(field, value)?;
        }
    }
    if p.menu_type == "rice_curry" {
        // price_3 without price_2 would leave the 2-curry plate unpriced.
        if p.price_3.is_some() && p.price_2.is_none() {
            return Err(ApiError::BadRequest(
                "price_3 requires price_2 (1-2-3 curry prices fill bottom-up)".into(),
            ));
        }
        if let Some(price_2) = p.price_2 {
            if price_2 < p.base_price {
                return Err(ApiError::BadRequest("price_2 must be >= base_price".into()));
            }
            // Safe to nest: price_3 implies price_2 above.
            if let Some(price_3) = p.price_3 {
                if price_3 < price_2 {
                    return Err(ApiError::BadRequest("price_3 must be >= price_2".into()));
                }
            }
        }
    } else if p.price_2.is_some() || p.price_3.is_some() {
        return Err(ApiError::BadRequest(
            "price_2/price_3 only apply to menu_type rice_curry".into(),
        ));
    }
    Ok(())
}

/// Pick policy of one option group. `item_menu_type` is the menu_type of the
/// menu item the group is linked to (None = shop-wide group, no menu_item_id).
fn validate_option_group_policy(
    item_menu_type: Option<&str>,
    tier_pricing: bool,
    max_select: Option<i64>,
) -> Result<(), ApiError> {
    if max_select.is_some_and(|max| max < 1) {
        return Err(ApiError::BadRequest("max_select must be >= 1".into()));
    }
    if tier_pricing {
        // The pick count must map onto a price tier, so the group needs a
        // rice_curry item and a pick limit within the tier count (3.4).
        if item_menu_type != Some("rice_curry") {
            return Err(ApiError::BadRequest(
                "tier_pricing requires the group to point at one rice_curry menu item".into(),
            ));
        }
        if max_select.is_none() {
            return Err(ApiError::BadRequest(
                "tier_pricing requires max_select (the pick count picks the price tier)".into(),
            ));
        }
        if max_select.is_some_and(|max| max > 3) {
            return Err(ApiError::BadRequest(
                "tier_pricing max_select must be <= 3 (base_price/price_2/price_3)".into(),
            ));
        }
    }
    Ok(())
}

/// One markup rule: known kind, value bounded per kind (FEATURES 3.6).
fn check_markup_rule(channel: &str, rule: &MarkupRule) -> Result<(), ApiError> {
    match rule.kind.as_str() {
        "percent" => {
            if rule.value < 0 || rule.value > MAX_MARKUP_PERCENT {
                return Err(ApiError::BadRequest(format!(
                    "{channel} markup percent must be between 0 and {MAX_MARKUP_PERCENT}"
                )));
            }
        }
        "baht" => check_satang(&format!("{channel} markup value"), rule.value)?,
        other => {
            return Err(ApiError::BadRequest(format!(
                "{channel} markup kind must be 'percent' or 'baht', got '{other}'"
            )))
        }
    }
    Ok(())
}

/// The canonical object stored verbatim in shops.channel_markup_json: only the
/// channels present in the body (an omitted channel has no markup), each rule
/// serialized as {"kind":...,"value":...}.
fn normalize_channel_markup(body: &ChannelMarkupBody) -> Result<Value, ApiError> {
    let mut map = Map::new();
    for (channel, rule) in [
        ("grab", &body.grab),
        ("lineman", &body.lineman),
        ("foodpanda", &body.foodpanda),
    ] {
        if let Some(rule) = rule {
            check_markup_rule(channel, rule)?;
            let value = serde_json::to_value(rule)
                .map_err(|e| ApiError::Internal(format!("markup serialization failed: {e}")))?;
            map.insert(channel.to_owned(), value);
        }
    }
    Ok(Value::Object(map))
}

// ---------------------------------------------------------------------------
// D1 helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ItemRef {
    shop_id: String,
    menu_type: String,
}

async fn shop_missing(env: &Env, shop_id: &str) -> Result<bool, ApiError> {
    let found = db::db(env)?
        .prepare("SELECT id FROM shops WHERE id = ?1")
        .bind(&[txt(shop_id)])?
        .first::<String>(Some("id"))
        .await?;
    Ok(found.is_none())
}

/// Loads one menu item by id (any shop) - shared with the staff menu routes.
pub(crate) async fn load_menu_item(env: &Env, id: &str) -> Result<Option<MenuItem>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT id, shop_id, name, category, menu_type, base_price, price_2, price_3, \
             grab_price, lineman_price, foodpanda_price, cost, image_key, sold_out, status, \
             sort_order, created_at, updated_at
             FROM menu_items WHERE id = ?1",
        )
        .bind(&[txt(id)])?
        .first::<MenuItem>(None)
        .await?)
}

/// shop_id + menu_type of one menu item (FK / shop-match / tier checks).
async fn load_item_ref(env: &Env, id: &str) -> Result<Option<ItemRef>, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT shop_id, menu_type FROM menu_items WHERE id = ?1")
        .bind(&[txt(id)])?
        .first::<ItemRef>(None)
        .await?)
}

async fn load_option_group(env: &Env, id: &str) -> Result<Option<OptionGroup>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT id, shop_id, menu_item_id, name, required, max_select, tier_pricing, \
             sort_order, created_at, updated_at
             FROM option_groups WHERE id = ?1",
        )
        .bind(&[txt(id)])?
        .first::<OptionGroup>(None)
        .await?)
}

/// Loads one option by id (any shop) - shared with the staff menu routes.
pub(crate) async fn load_option(env: &Env, id: &str) -> Result<Option<MenuOption>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT id, shop_id, option_group_id, name, price_add, sold_out, sort_order, \
             created_at, updated_at
             FROM options WHERE id = ?1",
        )
        .bind(&[txt(id)])?
        .first::<MenuOption>(None)
        .await?)
}

/// The id of a tier_pricing group already linked to `menu_item_id`, if any.
/// At most one exists (enforced by the handlers), so callers compare the id
/// with their own to allow "still this group" on update.
async fn tier_group_on(env: &Env, menu_item_id: &str) -> Result<Option<String>, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT id FROM option_groups WHERE menu_item_id = ?1 AND tier_pricing = 1")
        .bind(&[txt(menu_item_id)])?
        .first::<String>(Some("id"))
        .await?)
}

/// One menu row with the DERIVED `stock_out` flag added (migration 0010).
/// `sold_out` stays the manual counter flag; this one says an auto_block
/// ingredient behind the row's recipe has run out. The row structs are read
/// from D1 as-is, so the flag is added after loading (never a SELECT column).
fn with_stock_out_flag(mut row: Value, stock_out: bool) -> Value {
    row["stock_out"] = json!(stock_out);
    row
}

/// Every item and option of the menu as JSON, each tagged with its derived
/// `stock_out` (one read for the whole shop - shared by the owner and staff
/// menu endpoints, so both apps always agree on the field).
pub(crate) async fn menu_stock_out_json(
    env: &Env,
    shop_id: &str,
    items: Vec<MenuItem>,
    options: Vec<MenuOption>,
) -> Result<(Vec<Value>, Vec<Value>), ApiError> {
    let out = stock::load_stock_out(env, shop_id).await?;
    // Nothing short anywhere (every shop without auto_block ingredients is
    // always in that state, 0010's default): then every row takes the same
    // false flag and the per-row lookups are skipped.
    let nothing_out = out.is_empty();
    let items = items
        .into_iter()
        .map(|i| with_stock_out_flag(json!(i), !nothing_out && out.is_item_out(&i.id)))
        .collect();
    let options = options
        .into_iter()
        .map(|o| with_stock_out_flag(json!(o), !nothing_out && out.is_option_out(&o.id)))
        .collect();
    Ok((items, options))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// The whole menu of one shop: items, option groups, options (all statuses;
/// inactive/sold-out rows stay visible to the owner) and the channel markup.
#[worker::send]
pub async fn shop_menu(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(shop_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let env = &state.env;

    let Some(markup_json) = db::db(env)?
        .prepare("SELECT channel_markup_json FROM shops WHERE id = ?1")
        .bind(&[txt(&shop_id)])?
        .first::<String>(Some("channel_markup_json"))
        .await?
    else {
        return Err(ApiError::NotFound);
    };
    let channel_markup: Value = serde_json::from_str(&markup_json).map_err(|e| {
        ApiError::Internal(format!("shop {shop_id} has invalid channel_markup_json: {e}"))
    })?;

    let items = db::db(env)?
        .prepare(
            "SELECT id, shop_id, name, category, menu_type, base_price, price_2, price_3, \
             grab_price, lineman_price, foodpanda_price, cost, image_key, sold_out, status, \
             sort_order, created_at, updated_at
             FROM menu_items
             WHERE shop_id = ?1 AND deleted_at IS NULL
             ORDER BY sort_order, created_at, id",
        )
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<MenuItem>()?;
    let option_groups = db::db(env)?
        .prepare(
            "SELECT id, shop_id, menu_item_id, name, required, max_select, tier_pricing, \
             sort_order, created_at, updated_at
             FROM option_groups
             WHERE shop_id = ?1
             ORDER BY sort_order, created_at, id",
        )
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<OptionGroup>()?;
    let options = db::db(env)?
        .prepare(
            "SELECT id, shop_id, option_group_id, name, price_add, sold_out, sort_order, \
             created_at, updated_at
             FROM options
             WHERE shop_id = ?1
             ORDER BY sort_order, created_at, id",
        )
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<MenuOption>()?;

    // stock_out is derived per row (auto-block), not a menu column.
    let (items, options) =
        menu_stock_out_json(env, &shop_id, items, options).await?;

    Ok(Json(json!({
        "items": items,
        "option_groups": option_groups,
        "options": options,
        "channel_markup": channel_markup,
    })))
}

/// Create a menu item. Idempotent (offline retries, 3.70): same id in the same
/// shop replays as `200` with the CURRENT row; the same id under another shop
/// is a `409`.
#[worker::send]
pub async fn create_menu_item(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateMenuItemBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let shop_id = parse_uuid(&body.shop_id, "shop_id")?.to_string();
    let name = clean_name(&body.name)?;
    let category = clean_name(&body.category)?;
    validate_menu_pricing(&MenuPricing::from_create(&body))?;
    let env = &state.env;

    if shop_missing(env, &shop_id).await? {
        return Err(ApiError::NotFound);
    }

    if let Some(existing) = load_menu_item(env, &id).await? {
        return if existing.shop_id == shop_id {
            Ok(Json(existing).into_response())
        } else {
            Err(ApiError::Conflict(format!(
                "menu item {id} already exists with a different shop_id"
            )))
        };
    }

    let now = now_ms();
    let item = MenuItem {
        id: id.clone(),
        shop_id: shop_id.clone(),
        name,
        category,
        menu_type: body.menu_type.clone(),
        base_price: body.base_price,
        price_2: body.price_2,
        price_3: body.price_3,
        grab_price: body.grab_price,
        lineman_price: body.lineman_price,
        foodpanda_price: body.foodpanda_price,
        cost: body.cost,
        image_key: None,
        sold_out: false,
        status: "active".to_owned(),
        sort_order: body.sort_order.unwrap_or(0),
        created_at: now,
        updated_at: now,
    };
    db::db(env)?
        .prepare(
            "INSERT INTO menu_items
               (id, shop_id, name, category, menu_type, base_price, price_2, price_3,
                grab_price, lineman_price, foodpanda_price, cost, sold_out, status,
                sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, 'active', ?13, ?14, ?14)",
        )
        .bind(&[
            txt(&item.id),
            txt(&item.shop_id),
            txt(&item.name),
            txt(&item.category),
            txt(&item.menu_type),
            int(item.base_price),
            opt_int(item.price_2),
            opt_int(item.price_3),
            opt_int(item.grab_price),
            opt_int(item.lineman_price),
            opt_int(item.foodpanda_price),
            opt_int(item.cost),
            int(item.sort_order),
            int(now),
        ])?
        .run()
        .await?;
    Ok((StatusCode::CREATED, Json(item)).into_response())
}

/// Full replace of the mutable menu-item fields. id/shop_id are immutable
/// (not accepted in the body). No DELETE route exists: order_items reference
/// menu items forever (append-only, schema 0001).
#[worker::send]
pub async fn update_menu_item(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateMenuItemBody>,
) -> Result<Json<MenuItem>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let name = clean_name(&body.name)?;
    let category = clean_name(&body.category)?;
    validate_menu_pricing(&MenuPricing::from_update(&body))?;
    let env = &state.env;

    let existing = load_menu_item(env, &id).await?.ok_or(ApiError::NotFound)?;

    // Keep the tier invariant whole: a tier_pricing option group may only sit
    // on a rice_curry item, so such an item must not become made_to_order.
    if body.menu_type != "rice_curry"
        && tier_group_on(env, &id)
            .await?
            .is_some()
    {
        return Err(ApiError::BadRequest(
            "menu item has a tier_pricing option group, menu_type must stay rice_curry".into(),
        ));
    }

    let now = now_ms();
    let item = MenuItem {
        name,
        category,
        menu_type: body.menu_type.clone(),
        base_price: body.base_price,
        price_2: body.price_2,
        price_3: body.price_3,
        grab_price: body.grab_price,
        lineman_price: body.lineman_price,
        foodpanda_price: body.foodpanda_price,
        cost: body.cost,
        sold_out: body.sold_out,
        status: body.status.clone(),
        sort_order: body.sort_order.unwrap_or(0),
        updated_at: now,
        ..existing
    };
    db::db(env)?
        .prepare(
            "UPDATE menu_items
             SET name = ?1, category = ?2, menu_type = ?3, base_price = ?4, price_2 = ?5,
                 price_3 = ?6, grab_price = ?7, lineman_price = ?8, foodpanda_price = ?9,
                 cost = ?10, sort_order = ?11, status = ?12, sold_out = ?13, updated_at = ?14
             WHERE id = ?15",
        )
        .bind(&[
            txt(&item.name),
            txt(&item.category),
            txt(&item.menu_type),
            int(item.base_price),
            opt_int(item.price_2),
            opt_int(item.price_3),
            opt_int(item.grab_price),
            opt_int(item.lineman_price),
            opt_int(item.foodpanda_price),
            opt_int(item.cost),
            int(item.sort_order),
            txt(&item.status),
            int(i64::from(item.sold_out)),
            int(now),
            txt(&id),
        ])?
        .run()
        .await?;
    Ok(Json(item))
}

/// Create an option group. `menu_item_id` is optional (NULL = reusable
/// shop-wide group) but must exist in the same shop. tier_pricing groups are
/// limited to rice_curry items, max_select 1..=3, at most ONE per item.
#[worker::send]
pub async fn create_option_group(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateOptionGroupBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let shop_id = parse_uuid(&body.shop_id, "shop_id")?.to_string();
    let name = clean_name(&body.name)?;
    let menu_item_id = match &body.menu_item_id {
        Some(raw) => Some(parse_uuid(raw, "menu_item_id")?.to_string()),
        None => None,
    };
    let env = &state.env;

    if shop_missing(env, &shop_id).await? {
        return Err(ApiError::NotFound);
    }

    if let Some(existing) = load_option_group(env, &id).await? {
        return if existing.shop_id == shop_id {
            Ok(Json(existing).into_response())
        } else {
            Err(ApiError::Conflict(format!(
                "option group {id} already exists with a different shop_id"
            )))
        };
    }

    // A group may point at one menu item, but only inside the same shop.
    let item = match &menu_item_id {
        Some(item_id) => {
            let item = load_item_ref(env, item_id).await?;
            match item {
                None => {
                    return Err(ApiError::BadRequest(format!(
                        "menu item {item_id} does not exist"
                    )))
                }
                Some(item) if item.shop_id != shop_id => {
                    return Err(ApiError::BadRequest(format!(
                        "menu item {item_id} belongs to a different shop"
                    )))
                }
                Some(item) => Some(item),
            }
        }
        None => None,
    };
    validate_option_group_policy(
        item.as_ref().map(|i| i.menu_type.as_str()),
        body.tier_pricing,
        body.max_select,
    )?;

    if body.tier_pricing {
        if let Some(item_id) = &menu_item_id {
            if let Some(clash) = tier_group_on(env, item_id).await? {
                return Err(ApiError::Conflict(format!(
                    "menu item {item_id} already has a tier_pricing option group ({clash})"
                )));
            }
        }
    }

    let now = now_ms();
    let group = OptionGroup {
        id: id.clone(),
        shop_id: shop_id.clone(),
        menu_item_id,
        name,
        required: body.required,
        max_select: body.max_select,
        tier_pricing: body.tier_pricing,
        sort_order: body.sort_order.unwrap_or(0),
        created_at: now,
        updated_at: now,
    };
    db::db(env)?
        .prepare(
            "INSERT INTO option_groups
               (id, shop_id, menu_item_id, name, required, max_select, tier_pricing,
                sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        )
        .bind(&[
            txt(&group.id),
            txt(&group.shop_id),
            opt_txt(group.menu_item_id.as_deref()),
            txt(&group.name),
            int(i64::from(group.required)),
            opt_int(group.max_select),
            int(i64::from(group.tier_pricing)),
            int(group.sort_order),
            int(now),
        ])?
        .run()
        .await?;
    Ok((StatusCode::CREATED, Json(group)).into_response())
}

/// Replace name/required/max_select/tier_pricing/sort_order. shop_id and
/// menu_item_id are immutable (not accepted in the body).
#[worker::send]
pub async fn update_option_group(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateOptionGroupBody>,
) -> Result<Json<OptionGroup>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let name = clean_name(&body.name)?;
    let env = &state.env;

    let existing = load_option_group(env, &id).await?.ok_or(ApiError::NotFound)?;

    // The policy is checked against the stored (immutable) menu item link.
    let item = match &existing.menu_item_id {
        Some(item_id) => Some(load_item_ref(env, item_id).await?.ok_or_else(|| {
            ApiError::Internal(format!("option group {id} points at missing menu item {item_id}"))
        })?),
        None => None,
    };
    validate_option_group_policy(
        item.as_ref().map(|i| i.menu_type.as_str()),
        body.tier_pricing,
        body.max_select,
    )?;

    if body.tier_pricing {
        if let Some(item_id) = existing.menu_item_id.as_deref() {
            if let Some(clash) = tier_group_on(env, item_id).await? {
                if clash != id {
                    return Err(ApiError::Conflict(format!(
                        "menu item {item_id} already has a tier_pricing option group ({clash})"
                    )));
                }
            }
        }
    }

    let now = now_ms();
    let group = OptionGroup {
        name,
        required: body.required,
        max_select: body.max_select,
        tier_pricing: body.tier_pricing,
        sort_order: body.sort_order.unwrap_or(0),
        updated_at: now,
        ..existing
    };
    db::db(env)?
        .prepare(
            "UPDATE option_groups
             SET name = ?1, required = ?2, max_select = ?3, tier_pricing = ?4,
                 sort_order = ?5, updated_at = ?6
             WHERE id = ?7",
        )
        .bind(&[
            txt(&group.name),
            int(i64::from(group.required)),
            opt_int(group.max_select),
            int(i64::from(group.tier_pricing)),
            int(group.sort_order),
            int(now),
            txt(&id),
        ])?
        .run()
        .await?;
    Ok(Json(group))
}

/// Delete an option group together with its options in ONE db batch (options
/// would dangle otherwise, and D1 batches are atomic).
#[worker::send]
pub async fn delete_option_group(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;

    load_option_group(env, &id)
        .await?
        .ok_or(ApiError::NotFound)?;

    db::db(env)?
        .batch(vec![
            // Recipe rows of these options go first (FK, migration 0005).
            db::db(env)?
                .prepare(
                    "DELETE FROM recipe_uses
                     WHERE option_id IN (SELECT id FROM options WHERE option_group_id = ?1)",
                )
                .bind(&[txt(&id)])?,
            db::db(env)?
                .prepare("DELETE FROM options WHERE option_group_id = ?1")
                .bind(&[txt(&id)])?,
            db::db(env)?
                .prepare("DELETE FROM option_groups WHERE id = ?1")
                .bind(&[txt(&id)])?,
        ])
        .await?;
    Ok(Json(json!({ "id": id, "deleted": true })))
}

/// Create an option. shop_id is NOT taken from the body - it is inherited
/// from the group, so an option can never land in another shop.
#[worker::send]
pub async fn create_option(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateOptionBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let group_id = parse_uuid(&body.option_group_id, "option_group_id")?.to_string();
    let name = clean_name(&body.name)?;
    check_satang("price_add", body.price_add)?;
    let env = &state.env;

    let group = load_option_group(env, &group_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    if let Some(existing) = load_option(env, &id).await? {
        return if existing.shop_id == group.shop_id {
            Ok(Json(existing).into_response())
        } else {
            Err(ApiError::Conflict(format!(
                "option {id} already exists with a different shop_id"
            )))
        };
    }

    let now = now_ms();
    let option = MenuOption {
        id: id.clone(),
        shop_id: group.shop_id.clone(),
        option_group_id: group.id.clone(),
        name,
        price_add: body.price_add,
        sold_out: false,
        sort_order: body.sort_order.unwrap_or(0),
        created_at: now,
        updated_at: now,
    };
    db::db(env)?
        .prepare(
            "INSERT INTO options
               (id, shop_id, option_group_id, name, price_add, sold_out, sort_order,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?7)",
        )
        .bind(&[
            txt(&option.id),
            txt(&option.shop_id),
            txt(&option.option_group_id),
            txt(&option.name),
            int(option.price_add),
            int(option.sort_order),
            int(now),
        ])?
        .run()
        .await?;
    Ok((StatusCode::CREATED, Json(option)).into_response())
}

/// Replace name/price_add/sort_order/sold_out (the curry-pot sold-out toggle,
/// FEATURES 3.5). option_group_id and shop_id are immutable.
#[worker::send]
pub async fn update_option(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateOptionBody>,
) -> Result<Json<MenuOption>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let name = clean_name(&body.name)?;
    check_satang("price_add", body.price_add)?;
    let env = &state.env;

    let existing = load_option(env, &id).await?.ok_or(ApiError::NotFound)?;

    let now = now_ms();
    let option = MenuOption {
        name,
        price_add: body.price_add,
        sold_out: body.sold_out,
        sort_order: body.sort_order.unwrap_or(0),
        updated_at: now,
        ..existing
    };
    db::db(env)?
        .prepare(
            "UPDATE options
             SET name = ?1, price_add = ?2, sort_order = ?3, sold_out = ?4, updated_at = ?5
             WHERE id = ?6",
        )
        .bind(&[
            txt(&option.name),
            int(option.price_add),
            int(option.sort_order),
            int(i64::from(option.sold_out)),
            int(now),
            txt(&id),
        ])?
        .run()
        .await?;
    Ok(Json(option))
}

#[worker::send]
pub async fn delete_option(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;

    load_option(env, &id).await?.ok_or(ApiError::NotFound)?;

    db::db(env)?
        .batch(vec![
            // Its recipe rows first (FK, migration 0005).
            db::db(env)?
                .prepare("DELETE FROM recipe_uses WHERE option_id = ?1")
                .bind(&[txt(&id)])?,
            db::db(env)?
                .prepare("DELETE FROM options WHERE id = ?1")
                .bind(&[txt(&id)])?,
        ])
        .await?;
    Ok(Json(json!({ "id": id, "deleted": true })))
}

/// Store the delivery markup per channel (FEATURES 3.6). Omitted channels are
/// stored as absent (= no markup); the normalized object is returned.
#[worker::send]
pub async fn put_channel_markup(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(shop_id): Path<String>,
    ApiJson(body): ApiJson<ChannelMarkupBody>,
) -> Result<Json<Value>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let markup = normalize_channel_markup(&body)?;
    let env = &state.env;

    let updated = db::db(env)?
        .prepare("UPDATE shops SET channel_markup_json = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(&[txt(&markup.to_string()), int(now_ms()), txt(&shop_id)])?
        .run()
        .await?;
    // 0 changes = no such shop.
    if updated.meta()?.and_then(|m| m.changes).unwrap_or(0) == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(Json(markup))
}

// ---------------------------------------------------------------------------
// Host unit tests (pure validation only - handlers need D1/Workers runtime)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rice_curry(base: i64, price_2: Option<i64>, price_3: Option<i64>) -> MenuPricing<'static> {
        MenuPricing {
            menu_type: "rice_curry",
            base_price: base,
            price_2,
            price_3,
            grab_price: None,
            lineman_price: None,
            foodpanda_price: None,
            cost: None,
            status: None,
        }
    }

    fn made_to_order() -> MenuPricing<'static> {
        MenuPricing {
            menu_type: "made_to_order",
            base_price: 6000,
            price_2: None,
            price_3: None,
            grab_price: None,
            lineman_price: None,
            foodpanda_price: None,
            cost: None,
            status: None,
        }
    }

    fn rule(kind: &str, value: i64) -> MarkupRule {
        MarkupRule {
            kind: kind.to_owned(),
            value,
        }
    }

    fn bad<T: std::fmt::Debug>(result: Result<T, ApiError>) -> String {
        match result {
            Err(ApiError::BadRequest(msg)) => msg,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn menu_type_and_status_must_be_known() {
        let mut item = made_to_order();
        item.menu_type = "dessert";
        assert!(bad(validate_menu_pricing(&item)).contains("menu_type"));

        let mut item = made_to_order();
        item.status = Some("paused");
        assert!(bad(validate_menu_pricing(&item)).contains("status"));
        item.status = Some("inactive");
        assert!(validate_menu_pricing(&item).is_ok());
    }

    #[test]
    fn every_satang_amount_is_bounded() {
        let mut item = made_to_order();
        item.base_price = MAX_SATANG + 1;
        assert!(bad(validate_menu_pricing(&item)).contains("base_price"));
        item.base_price = 0;
        assert!(validate_menu_pricing(&item).is_ok());

        let mut item = made_to_order();
        item.grab_price = Some(MAX_SATANG);
        item.cost = Some(-1);
        assert!(bad(validate_menu_pricing(&item)).contains("cost"));
        item.cost = Some(0);
        assert!(validate_menu_pricing(&item).is_ok());
    }

    #[test]
    fn made_to_order_has_a_single_price() {
        let mut item = made_to_order();
        item.price_2 = Some(7000);
        assert!(bad(validate_menu_pricing(&item)).contains("rice_curry"));
        item.price_2 = None;
        item.price_3 = Some(8000);
        assert!(bad(validate_menu_pricing(&item)).contains("rice_curry"));
        item.price_3 = None;
        assert!(validate_menu_pricing(&item).is_ok());
    }

    #[test]
    fn rice_curry_tiers_fill_bottom_up_and_never_get_cheaper() {
        // price_3 without price_2 leaves the 2-curry plate unpriced.
        assert!(bad(validate_menu_pricing(&rice_curry(5000, None, Some(7000)))).contains("price_3"));
        // price_2 < base_price / price_3 < price_2.
        assert!(bad(validate_menu_pricing(&rice_curry(5000, Some(4500), None))).contains("price_2"));
        assert!(bad(validate_menu_pricing(&rice_curry(5000, Some(6000), Some(5500)))).contains("price_3"));
        // Equal or rising tiers are fine, including only price_2.
        assert!(validate_menu_pricing(&rice_curry(5000, Some(6000), None)).is_ok());
        assert!(validate_menu_pricing(&rice_curry(5000, Some(6000), Some(6000))).is_ok());
    }

    #[test]
    fn tier_pricing_needs_a_rice_curry_item_and_a_pick_limit() {
        // No menu item link at all.
        assert!(bad(validate_option_group_policy(None, true, Some(2))).contains("rice_curry"));
        // Linked, but not a rice_curry item.
        assert!(bad(validate_option_group_policy(Some("made_to_order"), true, Some(2)))
            .contains("rice_curry"));
        // rice_curry item: max_select is mandatory and capped at the tier count.
        assert!(bad(validate_option_group_policy(Some("rice_curry"), true, None)).contains("max_select"));
        assert!(bad(validate_option_group_policy(Some("rice_curry"), true, Some(4))).contains("max_select"));
        assert!(validate_option_group_policy(Some("rice_curry"), true, Some(1)).is_ok());
        assert!(validate_option_group_policy(Some("rice_curry"), true, Some(3)).is_ok());
        // Without tier pricing any linked item type is fine; NULL = unlimited.
        assert!(validate_option_group_policy(Some("made_to_order"), false, None).is_ok());
        assert!(validate_option_group_policy(None, false, Some(5)).is_ok());
        assert!(bad(validate_option_group_policy(None, false, Some(0))).contains("max_select"));
    }

    #[test]
    fn markup_rules_are_bounded_per_kind() {
        assert!(bad(check_markup_rule("grab", &rule("euro", 10))).contains("kind"));
        assert!(bad(check_markup_rule("grab", &rule("percent", -1))).contains("percent"));
        assert!(bad(check_markup_rule("grab", &rule("percent", MAX_MARKUP_PERCENT + 1))).contains("percent"));
        assert!(check_markup_rule("grab", &rule("percent", 0)).is_ok());
        assert!(check_markup_rule("grab", &rule("percent", MAX_MARKUP_PERCENT)).is_ok());
        assert!(bad(check_markup_rule("lineman", &rule("baht", -1))).contains("lineman"));
        assert!(bad(check_markup_rule("lineman", &rule("baht", MAX_SATANG + 1))).contains("lineman"));
        assert!(check_markup_rule("lineman", &rule("baht", MAX_SATANG)).is_ok());
    }

    #[test]
    fn channel_markup_normalizes_to_present_channels_only() {
        let body = ChannelMarkupBody {
            grab: Some(rule("percent", 10)),
            lineman: None,
            foodpanda: Some(rule("baht", 500)),
        };
        let normalized = normalize_channel_markup(&body).unwrap();
        assert_eq!(
            normalized,
            json!({
                "grab": { "kind": "percent", "value": 10 },
                "foodpanda": { "kind": "baht", "value": 500 },
            })
        );
        // Stored text is what goes into shops.channel_markup_json verbatim.
        assert_eq!(normalized.to_string(), "{\"foodpanda\":{\"kind\":\"baht\",\"value\":500},\"grab\":{\"kind\":\"percent\",\"value\":10}}");

        // Invalid rules are rejected before anything is stored.
        let invalid = ChannelMarkupBody {
            grab: Some(rule("percent", 999)),
            lineman: None,
            foodpanda: None,
        };
        assert!(matches!(
            normalize_channel_markup(&invalid),
            Err(ApiError::BadRequest(_))
        ));

        // An empty body clears every markup ({}).
        let empty = ChannelMarkupBody {
            grab: None,
            lineman: None,
            foodpanda: None,
        };
        assert_eq!(normalize_channel_markup(&empty).unwrap(), json!({}));
    }
}

/// Delete a menu type (migration 0006). Never sold -> the item, its lists,
/// their choices and every recipe row go for real (one batch), plus its photo.
/// On old bills -> hidden instead (deleted_at + inactive), so bills/reports
/// keep their FK rows. Either way it leaves the editor and the counter.
#[worker::send]
pub async fn delete_menu_item(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let env = &state.env;
    let item = load_menu_item(env, &id).await?.ok_or(ApiError::NotFound)?;
    let sold = db::db(env)?
        .prepare("SELECT 1 AS one FROM order_items WHERE menu_item_id = ?1 LIMIT 1")
        .bind(&[txt(&id)])?
        .first::<i64>(Some("one"))
        .await?
        .is_some();

    if sold {
        db::db(env)?
            .prepare(
                "UPDATE menu_items SET status = 'inactive', deleted_at = ?1, updated_at = ?1
                 WHERE id = ?2",
            )
            .bind(&[int(now_ms()), txt(&id)])?
            .run()
            .await?;
        return Ok(Json(json!({ "id": id, "deleted": true, "archived": true })));
    }

    const GROUPS: &str = "SELECT id FROM option_groups WHERE menu_item_id = ?1";
    let stmt = |sql: String| -> Result<worker::D1PreparedStatement, ApiError> {
        Ok(db::db(env)?.prepare(sql).bind(&[txt(&id)])?)
    };
    db::db(env)?
        .batch(vec![
            stmt(format!(
                "DELETE FROM recipe_uses
                 WHERE menu_item_id = ?1
                    OR option_id IN (SELECT id FROM options WHERE option_group_id IN ({GROUPS}))"
            ))?,
            stmt(format!("DELETE FROM options WHERE option_group_id IN ({GROUPS})"))?,
            stmt("DELETE FROM option_groups WHERE menu_item_id = ?1".into())?,
            stmt("DELETE FROM menu_items WHERE id = ?1".into())?,
        ])
        .await?;
    if let Some(key) = &item.image_key {
        crate::routes::owner::media::remove_object(env, key).await;
    }
    Ok(Json(json!({ "id": id, "deleted": true, "archived": false })))
}
