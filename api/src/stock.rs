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

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Deserializer};
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

/// SQLite stores booleans as INTEGER 0/1; the row structs (and the rule
/// below) see real booleans. Same shape as `routes::owner::menu::bool_from_int`.
pub(crate) fn bool_from_int<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(i64::deserialize(deserializer)? != 0)
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

// ---------------------------------------------------------------------------
// Auto-block (migration 0010): qty + reserve as the floor of what may go out
// ---------------------------------------------------------------------------

/// One ingredient as the auto-block rule needs it. Only ACTIVE ingredients
/// with `auto_block = 1` are ever loaded ([`load_blockers`]); the flag stays
/// on the struct so the rule (and its tests) hold on their own.
#[derive(Debug, Clone, Deserialize)]
pub struct Blocker {
    pub id: String,
    /// Named in the order rejection ("วัตถุดิบบะหมี่ ไม่พอ").
    pub name: String,
    /// Free text unit of the ingredient, for the same message.
    pub unit: String,
    /// Estimated on hand (may dip below 0 until the next count).
    pub qty: f64,
    /// "Lower floor": units that may still go out. `qty + reserve` is the
    /// sellable amount, so a shop keeps a buffer below zero.
    pub reserve: f64,
    /// 0/1 (migration 0010): only 1 ever blocks anything.
    #[serde(deserialize_with = "bool_from_int")]
    pub auto_block: bool,
}

/// Which menu items / options are short of an auto_block ingredient.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StockOut {
    /// Items whose OWN recipe (every plate of that type) is short.
    pub menu_items: HashSet<String>,
    /// Options whose own recipe (only when picked) is short.
    pub options: HashSet<String>,
}

impl StockOut {
    pub fn is_item_out(&self, id: &str) -> bool {
        self.menu_items.contains(id)
    }

    pub fn is_option_out(&self, id: &str) -> bool {
        self.options.contains(id)
    }

    /// True when nothing in the shop is short - the state every shop without
    /// an auto_block ingredient is always in (the default of 0010).
    pub fn is_empty(&self) -> bool {
        self.menu_items.is_empty() && self.options.is_empty()
    }
}

/// Every ACTIVE ingredient of the shop with auto_block = 1 (one read).
/// auto_block = 0 and inactive rows never come back, so they can never block
/// the menu - the default, which is why a never-restocked ingredient at qty 0
/// keeps every shop selling exactly as before.
pub async fn load_blockers(
    env: &Env,
    shop_id: &str,
) -> Result<HashMap<String, Blocker>, ApiError> {
    let rows = db::db(env)?
        .prepare(
            "SELECT id, name, unit, qty, reserve, auto_block
             FROM ingredients
             WHERE shop_id = ?1 AND status = 'active' AND auto_block = 1",
        )
        .bind(&[txt(shop_id)])?
        .all()
        .await?
        .results::<Blocker>()?;
    Ok(rows.into_iter().map(|b| (b.id.clone(), b)).collect())
}

/// The derived stock_out state of the whole shop: the recipe of the shop
/// (one read) against its active auto_block ingredients (one read) - never a
/// query per item or option.
pub async fn load_stock_out(env: &Env, shop_id: &str) -> Result<StockOut, ApiError> {
    let uses = load_uses(env, shop_id).await?;
    let blockers = load_blockers(env, shop_id).await?;
    Ok(stock_out_targets(&uses, &blockers))
}

/// A menu item / option is stock_out when ANY of its recipe_uses rows points
/// at an ingredient that is active, auto_block = 1 and short for ONE plate /
/// pick (`qty + reserve < amount`). Item rows and option rows are evaluated
/// separately: a short item recipe blocks the item, a short option recipe
/// that option.
pub fn stock_out_targets(
    uses: &[RecipeUse],
    blockers: &HashMap<String, Blocker>,
) -> StockOut {
    let mut out = StockOut::default();
    for u in uses {
        let Some(b) = blockers.get(&u.ingredient_id) else {
            continue; // no auto_block (or inactive): never blocks
        };
        if !b.auto_block || b.qty + b.reserve >= u.amount {
            continue;
        }
        match (&u.menu_item_id, &u.option_id) {
            (Some(item), None) => {
                out.menu_items.insert(item.clone());
            }
            (None, Some(option)) => {
                out.options.insert(option.clone());
            }
            _ => {}
        }
    }
    out
}

/// Refuses a bill whose TOTAL need per ingredient (sum of amount x quantity
/// over its lines) overshoots what an auto_block ingredient may still give
/// out (`qty + reserve`): every single plate can fit while the whole bill
/// does not. Ingredients without auto_block (or inactive ones) are never
/// checked. The message is Thai (FEATURES 3.67) because the counter shows it
/// as-is, next to the item the staff just keyed.
pub fn check_total_need(
    usage: &BTreeMap<String, f64>,
    blockers: &HashMap<String, Blocker>,
) -> Result<(), ApiError> {
    for (ingredient_id, needed) in usage {
        let Some(b) = blockers.get(ingredient_id) else {
            continue;
        };
        if !b.auto_block {
            continue;
        }
        let available = b.qty + b.reserve;
        if *needed > available {
            return Err(ApiError::BadRequest(format!(
                "วัตถุดิบ{} ไม่พอ: บิลนี้ต้องใช้ {} {} เหลือขายได้อีก {} {}",
                b.name,
                round4(*needed),
                b.unit,
                round4(available),
                b.unit
            )));
        }
    }
    Ok(())
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

    // ---- auto-block (migration 0010) ----

    fn blocker(id: &str, qty: f64, reserve: f64) -> Blocker {
        Blocker {
            id: id.into(),
            name: format!("วัตถุดิบ{id}"),
            unit: "ถุง".into(),
            qty,
            reserve,
            auto_block: true,
        }
    }

    fn blockers(rows: &[Blocker]) -> HashMap<String, Blocker> {
        rows.iter().map(|b| (b.id.clone(), b.clone())).collect()
    }

    #[test]
    fn reserve_is_a_lower_floor_not_a_blocking_level() {
        // qty 0 + reserve 5 with 1 unit per plate: five more plates sell ...
        let uses = vec![use_row("noodle", Some("plate"), None, 1.0)];
        let five_left = stock_out_targets(&uses, &blockers(&[blocker("noodle", 0.0, 5.0)]));
        assert!(!five_left.is_item_out("plate"));
        assert!(five_left.options.is_empty());
        // ... the sixth (qty -5 by then) is blocked, and so is anything lower.
        for qty in [-5.0, -5.5, -100.0] {
            let out = stock_out_targets(&uses, &blockers(&[blocker("noodle", qty, 5.0)]));
            assert!(out.is_item_out("plate"), "qty {qty} must block the item");
        }
        // Exactly on the floor still sells: qty + reserve == amount.
        let on_the_floor = stock_out_targets(&uses, &blockers(&[blocker("noodle", -4.0, 5.0)]));
        assert!(!on_the_floor.is_item_out("plate"));
        // Without a reserve the same ingredient blocks as soon as qty is short.
        let no_reserve = stock_out_targets(&uses, &blockers(&[blocker("noodle", 0.0, 0.0)]));
        assert!(no_reserve.is_item_out("plate"));
    }

    #[test]
    fn without_auto_block_or_active_an_ingredient_never_blocks() {
        let uses = vec![
            use_row("off", Some("plate"), None, 0.1),
            use_row("gone", Some("plate"), None, 0.1),
            use_row("on", Some("plate"), None, 0.1),
        ];
        // auto_block = 0 (the default) blocks nothing, however low qty is ...
        let off = Blocker { auto_block: false, ..blocker("off", -99.0, 0.0) };
        assert!(!off.auto_block);
        // ... and an inactive ingredient is not even loaded (load_blockers
        // filters status = 'active'), so its rows simply have no blocker.
        let out = stock_out_targets(&uses, &blockers(&[off, blocker("on", -99.0, 0.0)]));
        assert_eq!(out.menu_items, ["plate".to_owned()].into_iter().collect());
        // Nothing at all blocks when no ingredient opted in.
        assert!(stock_out_targets(&uses, &HashMap::new()).menu_items.is_empty());
    }

    #[test]
    fn item_recipes_and_option_recipes_block_their_own_target() {
        let uses = vec![
            use_row("rice", Some("plate"), None, 1.0),
            use_row("noodle", None, Some("bami"), 0.1),
            use_row("pork", None, Some("crispy"), 0.1),
        ];
        // Only rice is short: the item is out, both options still sell.
        let out = stock_out_targets(
            &uses,
            &blockers(&[blocker("rice", 0.0, 0.0), blocker("noodle", 5.0, 0.0), blocker("pork", 5.0, 0.0)]),
        );
        assert!(out.is_item_out("plate"));
        assert!(!out.is_option_out("bami"));
        assert!(!out.is_option_out("crispy"));
        // Only the crispy-pork pot is short: the option is out, the item (and
        // the other option) still sell.
        let out = stock_out_targets(&uses, &blockers(&[blocker("pork", 0.0, 0.0)]));
        assert!(!out.is_item_out("plate"));
        assert!(out.is_option_out("crispy"));
        assert!(!out.is_option_out("bami"));
        // ANY short row of a target blocks it (rice short AND pork short).
        let out = stock_out_targets(&uses, &blockers(&[blocker("rice", 0.0, 0.0), blocker("pork", 0.0, 0.0)]));
        assert!(out.is_item_out("plate"));
        assert!(out.is_option_out("crispy"));
    }

    #[test]
    fn a_bills_total_need_may_overshoot_even_when_one_plate_fits() {
        // One plate needs 1 of an ingredient with qty 0 + reserve 5: the item
        // itself is sellable, and so are five plates in one bill ...
        let uses = vec![use_row("noodle", Some("plate"), None, 1.0)];
        let blockers = blockers(&[blocker("noodle", 0.0, 5.0)]);
        assert!(stock_out_targets(&uses, &blockers).is_empty());

        let mut usage = BTreeMap::new();
        add_line_usage(&uses, "plate", &[], 5, &mut usage);
        assert!(check_total_need(&usage, &blockers).is_ok());
        // ... but six plates in one bill overshoot the floor and are refused.
        let mut usage = BTreeMap::new();
        add_line_usage(&uses, "plate", &[], 6, &mut usage);
        let err = check_total_need(&usage, &blockers).unwrap_err();
        match err {
            ApiError::BadRequest(msg) => {
                assert!(msg.contains("วัตถุดิบnoodle"), "{msg} names the ingredient");
                assert!(msg.contains("6"), "{msg} says how much is needed");
            }
            other => panic!("expected BadRequest, got {other:?}"),
        }
        // Two lines of 3 plates each add up to the same refusal.
        let mut usage = BTreeMap::new();
        add_line_usage(&uses, "plate", &[], 3, &mut usage);
        add_line_usage(&uses, "plate", &[], 3, &mut usage);
        assert!(matches!(
            check_total_need(&usage, &blockers),
            Err(ApiError::BadRequest(_))
        ));
    }

    #[test]
    fn total_need_ignores_ingredients_that_do_not_block() {
        let uses = vec![
            use_row("off", Some("plate"), None, 1.0),
            use_row("gone", Some("plate"), None, 1.0),
            use_row("on", Some("plate"), None, 1.0),
        ];
        let mut usage = BTreeMap::new();
        add_line_usage(&uses, "plate", &[], 99, &mut usage);
        // auto_block = 0 and not-loaded (inactive) ingredients are never
        // checked, even at qty 0 and a huge bill.
        let off = Blocker { auto_block: false, ..blocker("off", 0.0, 0.0) };
        let mut map = blockers(&[off, blocker("on", 500.0, 0.0)]);
        assert!(check_total_need(&usage, &map).is_ok());
        // The opted-in one is checked the moment the bill needs more than it has.
        map.insert("on".into(), blocker("on", 98.0, 0.0));
        assert!(matches!(
            check_total_need(&usage, &map),
            Err(ApiError::BadRequest(_))
        ));
    }
}

