//! Owner stock endpoints (migration 0005; mechanics in [`crate::stock`]).
//!
//! - `GET  /owner/shops/{shop_id}/stock`       ingredients (+ used today) and every recipe row
//! - `POST /owner/ingredients`                 create (client UUID, idempotent)
//! - `PUT  /owner/ingredients/{id}`            rename / unit / alert level / active
//! - `POST /owner/ingredients/{id}/restock`    {move_id, amount} qty += amount
//! - `POST /owner/ingredients/{id}/count`      {move_id, qty}    qty := counted
//! - `PUT  /owner/recipe`                      replace the uses of ONE menu item or option
//!
//! restock/count are idempotent by `move_id`: the journal row and the qty
//! change go in one batch and the change only applies when the journal row
//! was written by THIS request (its created_at is this request's `now`).
//! [`journaled_change`] / [`load_ingredient`] are shared with the staff blind
//! count ([`crate::routes::stock_count`]).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use worker::Env;

use crate::auth::owner::OwnerAuth;
use crate::extract::ApiJson;
use crate::routes::orders::{bangkok_day_start_ms, changes};
use crate::routes::owner::menu::{load_menu_item, load_option};
use crate::stock::{self, check_qty, parse_amount, real};
use crate::util::{clean_name, int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

const INGREDIENT_COLUMNS: &str =
    "id, shop_id, name, unit, qty, alert_level, status, sort_order, created_at, updated_at";
const MAX_UNIT_CHARS: usize = 20;
const MAX_USES: usize = 30;

#[derive(Debug, Serialize, Deserialize)]
pub struct Ingredient {
    pub id: String,
    pub shop_id: String,
    pub name: String,
    pub unit: String,
    pub qty: f64,
    pub alert_level: f64,
    pub status: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecipeRow {
    pub id: String,
    pub ingredient_id: String,
    pub menu_item_id: Option<String>,
    pub option_id: Option<String>,
    pub amount: f64,
    pub amount_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateIngredientBody {
    pub id: String,
    pub shop_id: String,
    pub name: String,
    pub unit: String,
    #[serde(default)]
    pub qty: f64,
    #[serde(default)]
    pub alert_level: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateIngredientBody {
    pub name: String,
    pub unit: String,
    pub alert_level: f64,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestockBody {
    pub move_id: String,
    pub amount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CountBody {
    pub move_id: String,
    pub qty: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeUseBody {
    pub ingredient_id: String,
    pub amount_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PutRecipeBody {
    #[serde(default)]
    pub menu_item_id: Option<String>,
    #[serde(default)]
    pub option_id: Option<String>,
    pub uses: Vec<RecipeUseBody>,
}

/// Units are free text the owner sets once ("ถุง", "กก.").
fn clean_unit(raw: &str) -> Result<String, ApiError> {
    let unit = raw.trim();
    if unit.is_empty() || unit.chars().count() > MAX_UNIT_CHARS {
        return Err(ApiError::BadRequest(format!(
            "unit must be 1-{MAX_UNIT_CHARS} characters"
        )));
    }
    Ok(unit.to_owned())
}

/// One ingredient row by id, any shop (the owner endpoints address ids
/// directly; the staff count re-reads it to check the shop).
pub(crate) async fn load_ingredient(env: &Env, id: &str) -> Result<Option<Ingredient>, ApiError> {
    Ok(db::db(env)?
        .prepare(format!("SELECT {INGREDIENT_COLUMNS} FROM ingredients WHERE id = ?1"))
        .bind(&[txt(id)])?
        .first::<Ingredient>(None)
        .await?)
}

/// One journaled qty change (restock / count), idempotent by `move_id`.
/// `(kind, delta_sql, new_qty_sql)`: the journal kind, its delta and the new
/// qty, as SQL over the row (`qty` = current, `?3` = `value`). `user_id` is
/// the mover (owner or staff); `shop_id` additionally scopes the ingredient
/// to one shop (the staff count, [`crate::routes::stock_count`]) — `None`
/// (the owner endpoints) addresses the ingredient by id alone, keeping the
/// statements byte-identical.
pub(crate) async fn journaled_change(
    env: &Env,
    shop_id: Option<&str>,
    user_id: &str,
    id: &str,
    move_id: &str,
    value: f64,
    (kind, delta_sql, new_qty_sql): (&str, &str, &str),
) -> Result<Json<Ingredient>, ApiError> {
    let id = parse_uuid(id, "id")?.to_string();
    let move_id = parse_uuid(move_id, "move_id")?.to_string();
    let now = now_ms();
    let mut params = vec![txt(&move_id), txt(kind), real(value), txt(user_id), int(now), txt(&id)];
    // Staff scoping rides on ?7; the owner path adds no clause (same SQL).
    let shop_scope = match shop_id {
        Some(shop) => {
            params.push(txt(shop));
            " AND shop_id = ?7"
        }
        None => "",
    };
    db::db(env)?
        .batch(vec![
            db::db(env)?
                .prepare(format!(
                    "INSERT INTO stock_moves
                       (id, shop_id, ingredient_id, order_id, kind, delta, created_by, created_at)
                     SELECT ?1, shop_id, id, NULL, ?2, {delta_sql}, ?4, ?5
                     FROM ingredients
                     WHERE id = ?6{shop_scope}
                       AND NOT EXISTS (SELECT 1 FROM stock_moves WHERE id = ?1)"
                ))
                .bind(&params)?,
            db::db(env)?
                .prepare(format!(
                    "UPDATE ingredients SET qty = {new_qty_sql}, updated_at = ?5
                     WHERE id = ?6{shop_scope}
                       AND EXISTS (SELECT 1 FROM stock_moves
                                   WHERE id = ?1 AND ingredient_id = ?6 AND created_at = ?5
                                     AND kind = ?2 AND created_by = ?4)"
                ))
                .bind(&params)?,
        ])
        .await?;
    let ingredient = load_ingredient(env, &id).await?.ok_or(ApiError::NotFound)?;
    let move_ingredient = db::db(env)?
        .prepare("SELECT ingredient_id FROM stock_moves WHERE id = ?1")
        .bind(&[txt(&move_id)])?
        .first::<String>(Some("ingredient_id"))
        .await?;
    if move_ingredient.as_deref() != Some(id.as_str()) {
        return Err(ApiError::Conflict(format!(
            "move {move_id} belongs to another ingredient"
        )));
    }
    Ok(Json(ingredient))
}

async fn shop_exists(env: &Env, shop_id: &str) -> Result<bool, ApiError> {
    Ok(db::db(env)?
        .prepare("SELECT 1 AS one FROM shops WHERE id = ?1")
        .bind(&[txt(shop_id)])?
        .first::<i64>(Some("one"))
        .await?
        .is_some())
}

#[worker::send]
pub async fn shop_stock(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(shop_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let env = &state.env;
    if !shop_exists(env, &shop_id).await? {
        return Err(ApiError::NotFound);
    }
    let ingredients = db::db(env)?
        .prepare(format!(
            "SELECT {INGREDIENT_COLUMNS} FROM ingredients WHERE shop_id = ?1
             ORDER BY status, sort_order, name"
        ))
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<Ingredient>()?;
    let recipe = db::db(env)?
        .prepare(
            "SELECT id, ingredient_id, menu_item_id, option_id, amount, amount_text
             FROM recipe_uses WHERE shop_id = ?1 ORDER BY created_at, id",
        )
        .bind(&[txt(&shop_id)])?
        .all()
        .await?
        .results::<RecipeRow>()?;
    let used = stock::used_since(env, &shop_id, bangkok_day_start_ms(now_ms())).await?;
    let ingredients: Vec<Value> = ingredients
        .into_iter()
        .map(|i| {
            let used_today = stock::round4(used.get(&i.id).copied().unwrap_or(0.0));
            let mut v = json!(i);
            v["qty"] = json!(stock::round4(i.qty));
            v["used_today"] = json!(used_today);
            v
        })
        .collect();
    Ok(Json(json!({ "ingredients": ingredients, "recipe": recipe })))
}

#[worker::send]
pub async fn create_ingredient(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<CreateIngredientBody>,
) -> Result<Response, ApiError> {
    let id = parse_uuid(&body.id, "id")?.to_string();
    let shop_id = parse_uuid(&body.shop_id, "shop_id")?.to_string();
    let name = clean_name(&body.name)?;
    let unit = clean_unit(&body.unit)?;
    let qty = check_qty(body.qty, "qty")?;
    let alert = check_qty(body.alert_level, "alert_level")?;
    let env = &state.env;
    if !shop_exists(env, &shop_id).await? {
        return Err(ApiError::BadRequest(format!("shop {shop_id} does not exist")));
    }
    let now = now_ms();
    let result = db::db(env)?
        .prepare(
            "INSERT INTO ingredients (id, shop_id, name, unit, qty, alert_level, status,
                                      sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 0, ?7, ?7)
             ON CONFLICT(id) DO NOTHING",
        )
        .bind(&[txt(&id), txt(&shop_id), txt(&name), txt(&unit), real(qty), real(alert), int(now)])?
        .run()
        .await?;
    let stored = load_ingredient(env, &id)
        .await?
        .ok_or_else(|| ApiError::Internal(format!("ingredient {id} vanished")))?;
    if changes(&result)? == 0 {
        // Replay of a create: same shop -> echo it, else it is someone else's id.
        if stored.shop_id != shop_id {
            return Err(ApiError::Conflict(format!("ingredient {id} already exists")));
        }
        return Ok(Json(stored).into_response());
    }
    Ok((StatusCode::CREATED, Json(stored)).into_response())
}

#[worker::send]
pub async fn update_ingredient(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateIngredientBody>,
) -> Result<Json<Ingredient>, ApiError> {
    let id = parse_uuid(&id, "id")?.to_string();
    let name = clean_name(&body.name)?;
    let unit = clean_unit(&body.unit)?;
    let alert = check_qty(body.alert_level, "alert_level")?;
    if !matches!(body.status.as_str(), "active" | "inactive") {
        return Err(ApiError::BadRequest("status must be active or inactive".into()));
    }
    let env = &state.env;
    let result = db::db(env)?
        .prepare(
            "UPDATE ingredients SET name = ?1, unit = ?2, alert_level = ?3, status = ?4,
                                    updated_at = ?5
             WHERE id = ?6",
        )
        .bind(&[txt(&name), txt(&unit), real(alert), txt(&body.status), int(now_ms()), txt(&id)])?
        .run()
        .await?;
    if changes(&result)? == 0 {
        return Err(ApiError::NotFound);
    }
    load_ingredient(env, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::Internal(format!("ingredient {id} vanished")))
}

#[worker::send]
pub async fn restock(
    State(state): State<AppState>,
    owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RestockBody>,
) -> Result<Json<Ingredient>, ApiError> {
    if check_qty(body.amount, "amount")? <= 0.0 {
        return Err(ApiError::BadRequest("amount must be > 0".into()));
    }
    journaled_change(
        &state.env,
        None,
        &owner.user_id,
        &id,
        &body.move_id,
        body.amount,
        ("restock", "?3", "qty + ?3"),
    )
    .await
}

#[worker::send]
pub async fn count(
    State(state): State<AppState>,
    owner: OwnerAuth,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CountBody>,
) -> Result<Json<Ingredient>, ApiError> {
    let qty = check_qty(body.qty, "qty")?;
    journaled_change(&state.env, None, &owner.user_id, &id, &body.move_id, qty, ("count", "?3 - qty", "?3")).await
}

/// Replace every use of ONE target (a menu item = every plate, or an option =
/// when picked). Ingredients must be of the target's shop; an empty `uses`
/// clears the recipe. One batch: delete, then insert.
#[worker::send]
pub async fn put_recipe(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    ApiJson(body): ApiJson<PutRecipeBody>,
) -> Result<Json<Value>, ApiError> {
    let env = &state.env;
    let (column, target_id, shop_id) = match (&body.menu_item_id, &body.option_id) {
        (Some(item), None) => {
            let id = parse_uuid(item, "menu_item_id")?.to_string();
            let item = load_menu_item(env, &id).await?.ok_or(ApiError::NotFound)?;
            ("menu_item_id", id, item.shop_id)
        }
        (None, Some(option)) => {
            let id = parse_uuid(option, "option_id")?.to_string();
            let option = load_option(env, &id).await?.ok_or(ApiError::NotFound)?;
            ("option_id", id, option.shop_id)
        }
        _ => {
            return Err(ApiError::BadRequest(
                "give exactly one of menu_item_id / option_id".into(),
            ))
        }
    };
    if body.uses.len() > MAX_USES {
        return Err(ApiError::BadRequest(format!("at most {MAX_USES} ingredients")));
    }
    let mut parsed = Vec::with_capacity(body.uses.len());
    for u in &body.uses {
        let ingredient_id = parse_uuid(&u.ingredient_id, "ingredient_id")?.to_string();
        if parsed.iter().any(|(i, _, _): &(String, f64, String)| *i == ingredient_id) {
            return Err(ApiError::BadRequest(format!("ingredient {ingredient_id} listed twice")));
        }
        let amount = parse_amount(&u.amount_text)?;
        let ingredient = load_ingredient(env, &ingredient_id).await?;
        if ingredient.is_none_or(|i| i.shop_id != shop_id) {
            return Err(ApiError::BadRequest(format!(
                "ingredient {ingredient_id} is not in this shop"
            )));
        }
        parsed.push((ingredient_id, amount, u.amount_text.trim().to_owned()));
    }

    let now = now_ms();
    let mut statements = vec![db::db(env)?
        .prepare(format!("DELETE FROM recipe_uses WHERE {column} = ?1"))
        .bind(&[txt(&target_id)])?];
    for (ingredient_id, amount, text) in &parsed {
        statements.push(
            db::db(env)?
                .prepare(format!(
                    "INSERT INTO recipe_uses (id, shop_id, ingredient_id, {column}, amount,
                                              amount_text, created_at)
                     VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6)"
                ))
                .bind(&[txt(&shop_id), txt(ingredient_id), txt(&target_id), real(*amount), txt(text), int(now)])?,
        );
    }
    db::db(env)?.batch(statements).await?;
    let rows = db::db(env)?
        .prepare(format!(
            "SELECT id, ingredient_id, menu_item_id, option_id, amount, amount_text
             FROM recipe_uses WHERE {column} = ?1 ORDER BY created_at, id"
        ))
        .bind(&[txt(&target_id)])?
        .all()
        .await?
        .results::<RecipeRow>()?;
    Ok(Json(json!({ "uses": rows })))
}
