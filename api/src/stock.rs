//! Ingredient stock estimate (migration 0005).
//!
//! Cost model: an ingredient row holds ONE running `qty`. A sale deducts in
//! the same D1 batch that inserts the order lines (guarded by "that line was
//! inserted"), a cancel puts the sale's moves back (guarded by "the bill is
//! cancelled and nothing was put back yet"). So the stock screen is a plain
//! row read and the recipe is only read when a bill is written.
//!
//! Amounts are REAL in the ingredient's own unit. Owners type them as a
//! fraction or decimal ("1/10" = one bag makes ten plates); [`parse_amount`]
//! turns that into the number, the text is kept for display.

use std::collections::{BTreeMap, HashMap};

use serde::Deserialize;
use wasm_bindgen::JsValue;
use worker::{D1PreparedStatement, Env};

use crate::error::ApiError;
use crate::util::{int, txt};
use crate::db;

/// Upper bound for any typed amount/quantity (keeps REAL math sane).
pub const MAX_AMOUNT: f64 = 10_000_000.0;

pub fn real(v: f64) -> JsValue {
    JsValue::from_f64(v)
}

/// Display rounding (4 decimals): hides REAL noise like 0.30000000000000004.
pub fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// "1/10", "0.25", "2", " 3 / 4 " -> the positive amount; anything else 400.
pub fn parse_amount(text: &str) -> Result<f64, ApiError> {
    let t = text.trim();
    let bad = || ApiError::BadRequest(format!("invalid amount {text:?}: use e.g. 1/10 or 0.5"));
    let value = match t.split_once('/') {
        Some((a, b)) => {
            let a: f64 = a.trim().parse().map_err(|_| bad())?;
            let b: f64 = b.trim().parse().map_err(|_| bad())?;
            if b <= 0.0 {
                return Err(bad());
            }
            a / b
        }
        None => t.parse().map_err(|_| bad())?,
    };
    if !value.is_finite() || value <= 0.0 || value > MAX_AMOUNT {
        return Err(bad());
    }
    Ok(value)
}

/// A non-negative quantity (stock count / alert level / initial qty).
pub fn check_qty(v: f64, field: &str) -> Result<f64, ApiError> {
    if v.is_finite() && (0.0..=MAX_AMOUNT).contains(&v) {
        Ok(v)
    } else {
        Err(ApiError::BadRequest(format!("{field} must be 0..={MAX_AMOUNT}")))
    }
}

/// One recipe row as the sale path needs it.
#[derive(Debug, Clone, Deserialize)]
pub struct RecipeUse {
    pub ingredient_id: String,
    pub menu_item_id: Option<String>,
    pub option_id: Option<String>,
    pub amount: f64,
}

/// Every recipe row of the shop whose ingredient is active (small: tens of rows).
pub async fn load_uses(env: &Env, shop_id: &str) -> Result<Vec<RecipeUse>, ApiError> {
    Ok(db::db(env)?
        .prepare(
            "SELECT r.ingredient_id, r.menu_item_id, r.option_id, r.amount
             FROM recipe_uses r JOIN ingredients i ON i.id = r.ingredient_id
             WHERE r.shop_id = ?1 AND i.status = 'active'",
        )
        .bind(&[txt(shop_id)])?
        .all()
        .await?
        .results::<RecipeUse>()?)
}

/// Adds what `quantity` plates of `menu_item_id` with `option_ids` use to `acc`.
pub fn add_line_usage(
    uses: &[RecipeUse],
    menu_item_id: &str,
    option_ids: &[String],
    quantity: i64,
    acc: &mut BTreeMap<String, f64>,
) {
    for u in uses {
        let hit = u.menu_item_id.as_deref() == Some(menu_item_id)
            || u.option_id.as_ref().is_some_and(|o| option_ids.contains(o));
        if hit {
            *acc.entry(u.ingredient_id.clone()).or_insert(0.0) += u.amount * quantity as f64;
        }
    }
}

/// Deduct `usage` for `order_id`, only if the order line `guard_line_id` exists
/// by then in the batch (so a refused line insert deducts nothing).
pub fn sale_statements(
    env: &Env,
    shop_id: &str,
    order_id: &str,
    user_id: &str,
    guard_line_id: &str,
    usage: &BTreeMap<String, f64>,
    now: i64,
) -> Result<Vec<D1PreparedStatement>, ApiError> {
    let mut out = Vec::with_capacity(usage.len() * 2);
    for (ingredient_id, amount) in usage {
        out.push(
            db::db(env)?
                .prepare(
                    "UPDATE ingredients SET qty = qty - ?1, updated_at = ?2
                     WHERE id = ?3 AND shop_id = ?4
                       AND EXISTS (SELECT 1 FROM order_items WHERE id = ?5)",
                )
                .bind(&[real(*amount), int(now), txt(ingredient_id), txt(shop_id), txt(guard_line_id)])?,
        );
        out.push(
            db::db(env)?
                .prepare(
                    "INSERT INTO stock_moves
                       (id, shop_id, ingredient_id, order_id, kind, delta, created_by, created_at)
                     SELECT lower(hex(randomblob(16))), ?4, ?3, ?6, 'sale', -?1, ?7, ?2
                     WHERE EXISTS (SELECT 1 FROM order_items WHERE id = ?5)
                       AND EXISTS (SELECT 1 FROM ingredients WHERE id = ?3 AND shop_id = ?4)",
                )
                .bind(&[
                    real(*amount),
                    int(now),
                    txt(ingredient_id),
                    txt(shop_id),
                    txt(guard_line_id),
                    txt(order_id),
                    txt(user_id),
                ])?,
        );
    }
    Ok(out)
}

/// Put a cancelled bill's sale moves back. Append AFTER the cancel UPDATE in
/// the same batch: both statements no-op unless the bill is cancelled by now
/// and no 'cancel' move exists yet, so a repeated cancel never restores twice.
pub fn restore_statements(
    env: &Env,
    shop_id: &str,
    order_id: &str,
    user_id: &str,
    now: i64,
) -> Result<Vec<D1PreparedStatement>, ApiError> {
    const GUARD: &str = "(SELECT status FROM orders WHERE id = ?1) = 'cancelled'
                         AND NOT EXISTS (SELECT 1 FROM stock_moves WHERE order_id = ?1 AND kind = 'cancel')";
    Ok(vec![
        db::db(env)?
            .prepare(format!(
                "UPDATE ingredients
                 SET qty = qty - (SELECT SUM(m.delta) FROM stock_moves m
                                  WHERE m.order_id = ?1 AND m.kind = 'sale'
                                    AND m.ingredient_id = ingredients.id),
                     updated_at = ?2
                 WHERE shop_id = ?3
                   AND id IN (SELECT ingredient_id FROM stock_moves WHERE order_id = ?1 AND kind = 'sale')
                   AND {GUARD}"
            ))
            .bind(&[txt(order_id), int(now), txt(shop_id)])?,
        db::db(env)?
            .prepare(format!(
                "INSERT INTO stock_moves
                   (id, shop_id, ingredient_id, order_id, kind, delta, created_by, created_at)
                 SELECT lower(hex(randomblob(16))), ?3, ingredient_id, ?1, 'cancel', -SUM(delta), ?4, ?2
                 FROM stock_moves
                 WHERE order_id = ?1 AND kind = 'sale' AND {GUARD}
                 GROUP BY ingredient_id"
            ))
            .bind(&[txt(order_id), int(now), txt(shop_id), txt(user_id)])?,
    ])
}

/// Per-ingredient net usage since `since_ms` (sales minus cancels), for the
/// "used today" line. One grouped read over today's journal rows.
pub async fn used_since(
    env: &Env,
    shop_id: &str,
    since_ms: i64,
) -> Result<HashMap<String, f64>, ApiError> {
    #[derive(Deserialize)]
    struct Row {
        ingredient_id: String,
        used: f64,
    }
    let rows = db::db(env)?
        .prepare(
            "SELECT ingredient_id, -SUM(delta) AS used FROM stock_moves
             WHERE shop_id = ?1 AND kind IN ('sale', 'cancel') AND created_at >= ?2
             GROUP BY ingredient_id",
        )
        .bind(&[txt(shop_id), int(since_ms)])?
        .all()
        .await?
        .results::<Row>()?;
    Ok(rows.into_iter().map(|r| (r.ingredient_id, r.used)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_accept_fractions_and_decimals() {
        assert_eq!(parse_amount("1/10").unwrap(), 0.1);
        assert_eq!(parse_amount(" 3 / 4 ").unwrap(), 0.75);
        assert_eq!(parse_amount("2").unwrap(), 2.0);
        assert_eq!(parse_amount("0.5").unwrap(), 0.5);
        for bad in ["", "0", "-1", "1/0", "a/b", "1/2/3", "NaN", "inf", "1e9", "0/5"] {
            assert!(parse_amount(bad).is_err(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn quantities_are_non_negative_and_bounded() {
        assert!(check_qty(0.0, "qty").is_ok());
        assert!(check_qty(12.5, "qty").is_ok());
        assert!(check_qty(-0.1, "qty").is_err());
        assert!(check_qty(f64::NAN, "qty").is_err());
        assert!(check_qty(1e9, "qty").is_err());
    }

    fn use_row(ing: &str, item: Option<&str>, option: Option<&str>, amount: f64) -> RecipeUse {
        RecipeUse {
            ingredient_id: ing.into(),
            menu_item_id: item.map(Into::into),
            option_id: option.map(Into::into),
            amount,
        }
    }

    #[test]
    fn line_usage_sums_item_and_picked_options_times_quantity() {
        let uses = vec![
            use_row("rice", Some("plate"), None, 0.1),
            use_row("noodle", None, Some("bami"), 0.1),
            use_row("pork", None, Some("crispy"), 0.05),
            use_row("egg", None, Some("not-picked"), 1.0),
            use_row("rice", Some("other-item"), None, 9.0),
        ];
        let mut acc = BTreeMap::new();
        add_line_usage(&uses, "plate", &["bami".into(), "crispy".into()], 2, &mut acc);
        add_line_usage(&uses, "plate", &["bami".into()], 1, &mut acc);
        assert!((acc["rice"] - 0.3).abs() < 1e-9);
        assert!((acc["noodle"] - 0.3).abs() < 1e-9);
        assert!((acc["pork"] - 0.1).abs() < 1e-9);
        assert!(!acc.contains_key("egg"));
    }
}
