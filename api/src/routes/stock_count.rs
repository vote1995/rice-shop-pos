//! `/stock...` - the staff side of stock counting, BLIND (FEATURES 3.40 /
//! ROADMAP StockCount). The system number (`ingredients.qty`) is an estimate
//! that drifts all day (3.37: deducted per plate sold, nobody weighs a
//! spatula), so it must never be on the sheet the staff counts from - the
//! counter would just copy it. Counting fixes the drift (Phase 2 variance
//! reports read the same journal).
//!
//! Endpoints (staff auth: the shop ALWAYS comes from the session, so one
//! shop's staff can neither read nor count another shop's ingredients):
//! - `GET  /stock/count-sheet` the sheet: active ingredients of the session
//!   shop (id, name, unit, last_count_at) - NO qty, NO estimate
//! - `POST /stock/count`       submit the sheet: 1..=100 counts at once
//!
//! Each count is journaled exactly like the owner count
//! (`owner::stock::journaled_change`, kind 'count'): `qty := counted`,
//! `delta = counted - old`, `created_by` = the staff user, idempotent by the
//! client `move_id` (an offline retry writes nothing the second time).

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::staff::StaffAuth;
use crate::extract::ApiJson;
use crate::routes::owner::stock::{journaled_change, load_ingredient};
use crate::stock::check_qty;
use crate::util::{parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

/// Counts on one submitted sheet (a full shop is tens of ingredients; a
/// bigger split goes in as two sheets).
const MAX_COUNTS: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StaffCountBody {
    pub counts: Vec<StaffCountEntry>,
}

/// One line of a submitted sheet: what the staff counted (`qty`), for which
/// ingredient, under which client `move_id` (idempotency, FEATURES 3.70).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StaffCountEntry {
    pub move_id: String,
    pub ingredient_id: String,
    pub qty: f64,
}

/// One sheet row: identification only - `qty` (the estimate) is deliberately
/// absent (blind count) and so is the alert level. Doubles as the D1 row
/// struct (`last_count_at` is the NULL-able scalar subquery below).
#[derive(Debug, Serialize, Deserialize)]
pub struct CountSheetRow {
    pub id: String,
    pub name: String,
    pub unit: String,
    /// MAX(created_at) of this ingredient's 'count' moves; NULL = never
    /// counted. Tells the staff what is stale without telling them the number.
    pub last_count_at: Option<i64>,
}

/// Pure bound check of a submitted sheet: 1..=[`MAX_COUNTS`] counts (an empty
/// body is not a count; more than the bound is two sheets).
fn check_counts_len(n: usize) -> Result<(), ApiError> {
    if n == 0 || n > MAX_COUNTS {
        return Err(ApiError::BadRequest(format!(
            "counts must hold 1-{MAX_COUNTS} entries"
        )));
    }
    Ok(())
}

/// `GET /stock/count-sheet`: the blind sheet of the session shop - every
/// ACTIVE ingredient ordered as the owner sorted them (sort_order, name),
/// with only id / name / unit / last_count_at. One statement; the "never
/// counted" answer is the NULL of the scalar subquery.
#[worker::send]
pub async fn count_sheet(
    State(state): State<AppState>,
    staff: StaffAuth,
) -> Result<Json<Value>, ApiError> {
    let rows = db::db(&state.env)?
        .prepare(
            "SELECT i.id AS id, i.name AS name, i.unit AS unit,
                    (SELECT MAX(m.created_at) FROM stock_moves m
                     WHERE m.ingredient_id = i.id AND m.kind = 'count') AS last_count_at
             FROM ingredients i
             WHERE i.shop_id = ?1 AND i.status = 'active'
             ORDER BY i.sort_order, i.name",
        )
        .bind(&[txt(&staff.shop_id)])?
        .all()
        .await?
        .results::<CountSheetRow>()?;
    Ok(Json(json!({ "ingredients": rows })))
}

/// `POST /stock/count`: record the counted sheet. Every entry is processed
/// sequentially through the shared owner helper (same journal row, same
/// `qty := counted` semantics, same `move_id` idempotency); an ingredient of
/// another shop (or no shop at all) is a 400 and nothing after it is written.
#[worker::send]
pub async fn count(
    State(state): State<AppState>,
    staff: StaffAuth,
    ApiJson(body): ApiJson<StaffCountBody>,
) -> Result<Json<Value>, ApiError> {
    check_counts_len(body.counts.len())?;
    let env = &state.env;
    let mut saved = 0;
    for entry in &body.counts {
        let qty = check_qty(entry.qty, "qty")?;
        let id = parse_uuid(&entry.ingredient_id, "ingredient_id")?.to_string();
        let ingredient = load_ingredient(env, &id).await?;
        if ingredient.is_none_or(|i| i.shop_id != staff.shop_id) {
            return Err(ApiError::BadRequest(format!(
                "ingredient {id} is not in this shop"
            )));
        }
        // Shop scoped a second time inside the SQL, so the check above can
        // never race a row into another shop's journal.
        let _counted = journaled_change(
            env,
            Some(&staff.shop_id),
            &staff.user_id,
            &id,
            &entry.move_id,
            qty,
            ("count", "?3 - qty", "?3"),
        )
        .await?;
        saved += 1;
    }
    Ok(Json(json!({ "saved": saved })))
}

// ---------------------------------------------------------------------------
// Host unit tests (pure fns only - handlers need D1/the Workers runtime)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn bad(result: Result<(), ApiError>) -> String {
        match result {
            Err(ApiError::BadRequest(msg)) => msg,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn a_sheet_holds_1_to_100_counts() {
        assert!(bad(check_counts_len(0)).contains("1-100 entries"));
        assert!(check_counts_len(1).is_ok());
        assert!(check_counts_len(MAX_COUNTS).is_ok());
        assert!(bad(check_counts_len(MAX_COUNTS + 1)).contains("1-100 entries"));
    }
}
