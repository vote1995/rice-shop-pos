//! Pure order-line pricing engine (ROADMAP M1-1b; FEATURES 3.4-3.6).
//!
//! Everything here is mechanism-free - plain data in, satang out - with no
//! D1 and no worker types, so the whole rule set runs under `cargo test` on
//! the host. The order endpoints (M1-2) load the menu rows, map them onto the
//! input structs below and call [`price_line`]; the client's price preview
//! must reproduce exactly this math.
//!
//! Money is INTEGER satang everywhere, integer arithmetic only (no floats),
//! and every multiplication is checked (see [`line_total`] and the percent
//! path of `price_line`).
//!
//! Rules, applied in order:
//! 1. the item must be sellable right now (active, not sold out),
//! 2. every picked option id must belong to an applicable group, at most
//!    once, and must not be sold out,
//! 3. per-group pick policy (required needs a pick, max_select caps picks),
//! 4. the base price (rice_curry 1-2-3 curry tiers, FEATURES 3.4),
//! 5. counter: base + add-ons,
//! 6. delivery: a made_to_order channel override (no markup) or the shop's
//!    per-channel markup (FEATURES 3.6).

// Pure code only. Until the order endpoints (M1-2) call into it, only the
// host unit tests do, and wasm builds compile no tests - hence the
// module-level dead_code allow (same pattern as `routes::staff_auth`).
#![allow(dead_code)]

use serde_json::Value;

use crate::error::ApiError;

/// The four sales channels (orders.channel, schema 0001).
const CHANNELS: [&str; 4] = ["counter", "grab", "lineman", "foodpanda"];

/// The menu item being priced - only the fields pricing depends on. Handlers
/// copy them from the menu_items row of the same name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricingItem {
    pub id: String,
    /// "rice_curry" | "made_to_order" (schema 0001).
    pub menu_type: String,
    /// Plate with 1 curry (rice_curry) / the only price (made_to_order).
    pub base_price: i64,
    pub price_2: Option<i64>,
    pub price_3: Option<i64>,
    pub grab_price: Option<i64>,
    pub lineman_price: Option<i64>,
    pub foodpanda_price: Option<i64>,
    /// "active" | "inactive".
    pub status: String,
    pub sold_out: bool,
}

/// One option group. A group APPLIES to the priced item when its
/// `menu_item_id` is `None` (shop-wide group, schema 0001) or equals the item
/// id; a group linked to a different item never applies, even if it is passed
/// in (pricing filters it out again).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricingGroup {
    pub id: String,
    pub menu_item_id: Option<String>,
    pub name: String,
    pub required: bool,
    /// NULL = unlimited picks.
    pub max_select: Option<i64>,
    /// 1 = the pick count in this group selects base_price/price_2/price_3.
    pub tier_pricing: bool,
    pub options: Vec<PricingOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricingOption {
    pub id: String,
    pub name: String,
    pub price_add: i64,
    pub sold_out: bool,
}

/// A picked option, echoed verbatim into the order-line snapshot
/// (order_items.options_json: [{"id","name","price_add"}], schema 0001).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedOption {
    pub id: String,
    pub name: String,
    pub price_add: i64,
}

/// The priced line. `unit_price` is per plate; quantity is NOT included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedLine {
    pub unit_price: i64,
    /// The picks, in the order they were selected.
    pub options: Vec<SelectedOption>,
}

/// Prices ONE order line: `item` with the option `groups` of its shop, the
/// `selected` option ids (selection order kept) sold on `channel`.
///
/// `markup` is the parsed `shops.channel_markup_json` as written by the owner
/// endpoint, e.g. `{"grab":{"kind":"percent","value":10}}`; delivery channels
/// absent from it carry no markup.
///
/// Fails with [`ApiError::BadRequest`] and a clear message whenever the line
/// cannot be sold as requested (rules 1-6 in the module docs).
pub fn price_line(
    item: &PricingItem,
    groups: &[PricingGroup],
    channel: &str,
    markup: &Value,
    selected: &[String],
) -> Result<PricedLine, ApiError> {
    if !CHANNELS.contains(&channel) {
        return Err(ApiError::BadRequest(format!(
            "channel must be one of: {}",
            CHANNELS.join(", ")
        )));
    }

    // Rule 1: sellable right now.
    if item.status != "active" || item.sold_out {
        return Err(ApiError::BadRequest("menu item is not available".into()));
    }

    // Only groups that apply to this item take part (see PricingGroup).
    let applicable: Vec<&PricingGroup> = groups
        .iter()
        .filter(|g| g.menu_item_id.as_deref().is_none_or(|id| id == item.id))
        .collect();

    // Rule 2: resolve every picked id (selection order kept); unknown ids,
    // duplicates and sold-out options are rejected.
    let mut options: Vec<SelectedOption> = Vec::with_capacity(selected.len());
    let mut picks_per_group = vec![0_usize; applicable.len()];
    for id in selected {
        let Some((group_index, option)) = applicable
            .iter()
            .enumerate()
            .find_map(|(i, g)| g.options.iter().find(|o| o.id == *id).map(|o| (i, o)))
        else {
            return Err(ApiError::BadRequest(format!(
                "option {id} does not apply to this item"
            )));
        };
        if options.iter().any(|picked| picked.id == *id) {
            return Err(ApiError::BadRequest(format!(
                "option {id} is picked more than once"
            )));
        }
        if option.sold_out {
            return Err(ApiError::BadRequest(format!("option {id} is sold out")));
        }
        picks_per_group[group_index] += 1;
        options.push(SelectedOption {
            id: option.id.clone(),
            name: option.name.clone(),
            price_add: option.price_add,
        });
    }

    // Rule 3: per-group pick policy.
    for (group, picks) in applicable.iter().zip(picks_per_group.iter()) {
        if let Some(max) = group.max_select {
            if *picks as i64 > max {
                return Err(ApiError::BadRequest(format!(
                    "option group {} allows at most {max} picks",
                    group.name
                )));
            }
        }
        if group.required && *picks == 0 {
            return Err(ApiError::BadRequest(format!(
                "option group {} requires at least 1 pick",
                group.name
            )));
        }
    }

    // Rule 4: the base price. A rice_curry item with a tier_pricing group is
    // priced by the number of picks in THAT group (1-2-3 curries, 3.4).
    let mut base = item.base_price;
    if item.menu_type == "rice_curry" {
        if let Some(tier_group) = applicable.iter().position(|g| g.tier_pricing) {
            base = tier_price(item, picks_per_group[tier_group])?;
        }
    }

    // Rules 5-6: add-ons, then the channel.
    let add_ons = options.iter().map(|o| o.price_add).sum::<i64>();
    let with_add_ons = base.checked_add(add_ons).ok_or_else(satang_overflow)?;
    let unit_price = if channel == "counter" {
        // Rule 5: counter price.
        with_add_ons
    } else {
        match channel_override(item, channel).filter(|_| item.menu_type == "made_to_order") {
            // Rule 6, first arm: a made_to_order item may carry a final
            // per-channel price; it already includes everything, so no
            // markup goes on top - only the add-ons are added.
            Some(override_price) => override_price
                .checked_add(add_ons)
                .ok_or_else(satang_overflow)?,
            // Rule 6, second arm: base + add-ons, then the shop markup.
            None => apply_markup(with_add_ons, channel, markup)?,
        }
    };

    Ok(PricedLine {
        unit_price,
        options,
    })
}

/// unit_price x quantity for one order line. Quantity is 1..=99 (bigger
/// amounts go in as several lines); the multiply is checked.
pub fn line_total(unit_price: i64, quantity: i64) -> Result<i64, ApiError> {
    if !(1..=99).contains(&quantity) {
        return Err(ApiError::BadRequest(
            "quantity must be between 1 and 99".into(),
        ));
    }
    unit_price.checked_mul(quantity).ok_or_else(satang_overflow)
}

/// The rice_curry plate price for `curries` picks (base_price/price_2/price_3,
/// FEATURES 3.4). Counts outside 1-3 - and tiers whose column is NULL - have
/// no price.
fn tier_price(item: &PricingItem, curries: usize) -> Result<i64, ApiError> {
    match curries {
        1 => Some(item.base_price),
        2 => item.price_2,
        3 => item.price_3,
        _ => None,
    }
    .ok_or_else(|| ApiError::BadRequest(format!("no price for {curries} curries")))
}

/// The item's final price column for one delivery channel, if set (3.6).
/// Only meaningful for made_to_order items (see price_line).
fn channel_override(item: &PricingItem, channel: &str) -> Option<i64> {
    match channel {
        "grab" => item.grab_price,
        "lineman" => item.lineman_price,
        "foodpanda" => item.foodpanda_price,
        _ => None,
    }
}

/// The shop's markup rule of one delivery channel applied to `price`
/// (base + add-ons), FEATURES 3.6:
/// - channel absent from the markup object -> `price` unchanged,
/// - `{"kind":"baht","value":v}` -> `price + v` satang,
/// - `{"kind":"percent","value":p}` -> `price*(100+p)/100` rounded UP to a
///   whole baht (a multiple of 100 satang), integer math only.
///
/// The owner endpoint stores rules in exactly this shape; anything else in
/// the JSON is rejected here instead of being guessed at.
fn apply_markup(price: i64, channel: &str, markup: &Value) -> Result<i64, ApiError> {
    let Some(rule) = markup.get(channel).filter(|rule| !rule.is_null()) else {
        return Ok(price);
    };
    let invalid = || ApiError::BadRequest(format!("invalid {channel} markup rule"));
    let kind = rule.get("kind").and_then(Value::as_str).ok_or_else(invalid)?;
    let value = rule.get("value").and_then(Value::as_i64).ok_or_else(invalid)?;
    match kind {
        "baht" => price.checked_add(value).ok_or_else(satang_overflow),
        "percent" => {
            // Non-negative math in u64 (prices are satang >= 0); div_ceil is
            // stable there and the checked ops still catch any overflow.
            let price = u64::try_from(price).map_err(|_| satang_overflow())?;
            let value = u64::try_from(value).map_err(|_| satang_overflow())?;
            price
                .checked_mul(value.checked_add(100).ok_or_else(satang_overflow)?)
                .and_then(|scaled| scaled.div_ceil(10_000).checked_mul(100))
                .and_then(|satang| i64::try_from(satang).ok())
                .ok_or_else(satang_overflow)
        }
        _ => Err(invalid()),
    }
}

/// Checked-arithmetic failure. Cannot happen with schema-bounded amounts
/// (every satang value is capped by the owner endpoints), so it surfaces as
/// a 500, not as a client error.
fn satang_overflow() -> ApiError {
    ApiError::Internal("price amount overflows the satang range".into())
}

// ---------------------------------------------------------------------------
// Host unit tests (the module is pure, so every rule is testable here)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn no_markup() -> Value {
        json!({})
    }

    /// rice_curry plate: 5000 / 6000 / 7000 satang for 1 / 2 / 3 curries.
    fn rice_curry_item() -> PricingItem {
        PricingItem {
            id: "item-rice".into(),
            menu_type: "rice_curry".into(),
            base_price: 5000,
            price_2: Some(6000),
            price_3: Some(7000),
            grab_price: None,
            lineman_price: None,
            foodpanda_price: None,
            status: "active".into(),
            sold_out: false,
        }
    }

    fn made_to_order_item() -> PricingItem {
        PricingItem {
            id: "item-mto".into(),
            menu_type: "made_to_order".into(),
            base_price: 6000,
            price_2: None,
            price_3: None,
            grab_price: None,
            lineman_price: None,
            foodpanda_price: None,
            status: "active".into(),
            sold_out: false,
        }
    }

    fn option(id: &str, price_add: i64) -> PricingOption {
        PricingOption {
            id: id.into(),
            name: format!("opt {id}"),
            price_add,
            sold_out: false,
        }
    }

    fn group(
        id: &str,
        menu_item_id: Option<&str>,
        required: bool,
        max_select: Option<i64>,
        tier_pricing: bool,
        options: Vec<PricingOption>,
    ) -> PricingGroup {
        PricingGroup {
            id: id.into(),
            menu_item_id: menu_item_id.map(str::to_owned),
            name: format!("group {id}"),
            required,
            max_select,
            tier_pricing,
            options,
        }
    }

    /// Curry pots on the rice_curry item: tier pricing, required, max 3.
    fn curry_group() -> PricingGroup {
        group(
            "curry",
            Some("item-rice"),
            true,
            Some(3),
            true,
            vec![option("gang-1", 0), option("gang-2", 0), option("gang-3", 0)],
        )
    }

    /// Shop-wide extras (menu_item_id NULL): applies to every item.
    fn extras_group() -> PricingGroup {
        group(
            "extras",
            None,
            false,
            Some(2),
            false,
            vec![option("egg", 1000), option("extra-rice", 500)],
        )
    }

    fn picks(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    fn bad<T: std::fmt::Debug>(result: Result<T, ApiError>) -> String {
        match result {
            Err(ApiError::BadRequest(msg)) => msg,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn item_must_be_active_and_not_sold_out() {
        let groups = vec![curry_group()];
        let mut item = rice_curry_item();
        item.status = "inactive".into();
        assert_eq!(
            bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["gang-1"]))),
            "menu item is not available"
        );
        item.status = "active".into();
        item.sold_out = true;
        assert_eq!(
            bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["gang-1"]))),
            "menu item is not available"
        );
        // Checked before anything about the picks (rule order).
        item.sold_out = false;
        assert!(price_line(&item, &groups, "counter", &no_markup(), &picks(&["gang-1"])).is_ok());
    }

    #[test]
    fn only_applicable_groups_take_part() {
        // A group linked to ANOTHER item does not apply...
        let foreign = group(
            "foreign",
            Some("item-other"),
            false,
            None,
            false,
            vec![option("their-egg", 1000)],
        );
        let groups = vec![extras_group(), foreign];
        let item = made_to_order_item();
        assert_eq!(
            bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["their-egg"]))),
            "option their-egg does not apply to this item"
        );
        // ...a shop-wide group (menu_item_id NULL) does.
        let line = price_line(&item, &groups, "counter", &no_markup(), &picks(&["egg"])).unwrap();
        assert_eq!(line.unit_price, 6000 + 1000);
        // Unknown ids are rejected the same way.
        assert!(bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["nope"])))
            .contains("does not apply"));
    }

    #[test]
    fn duplicate_picks_and_sold_out_options_are_rejected() {
        let mut pot = option("crab", 2000);
        pot.sold_out = true;
        let groups = vec![group(
            "g",
            None,
            false,
            None,
            false,
            vec![option("egg", 1000), pot],
        )];
        let item = made_to_order_item();
        assert_eq!(
            bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["egg", "egg"]))),
            "option egg is picked more than once"
        );
        assert_eq!(
            bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["crab"]))),
            "option crab is sold out"
        );
    }

    #[test]
    fn pick_policy_is_enforced_per_group() {
        let groups = vec![
            group(
                "sizes",
                None,
                false,
                Some(1),
                false,
                vec![option("big", 500), option("small", 0)],
            ),
            group("spice", None, true, None, false, vec![option("hot", 0)]),
        ];
        let item = made_to_order_item();
        // max_select exceeded.
        assert!(bad(price_line(
            &item,
            &groups,
            "counter",
            &no_markup(),
            &picks(&["big", "small"])
        ))
        .contains("at most 1 picks"));
        // Required group without a pick.
        assert!(bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&["big"])))
            .contains("requires at least 1 pick"));
        // One size + spice is fine.
        let line =
            price_line(&item, &groups, "counter", &no_markup(), &picks(&["big", "hot"])).unwrap();
        assert_eq!(line.unit_price, 6000 + 500);
        // max_select NULL = unlimited.
        let groups = vec![group(
            "many",
            None,
            false,
            None,
            false,
            vec![option("a", 100), option("b", 200)],
        )];
        let line = price_line(&item, &groups, "counter", &no_markup(), &picks(&["a", "b"])).unwrap();
        assert_eq!(line.unit_price, 6000 + 300);
    }

    #[test]
    fn rice_curry_plate_prices_by_tier() {
        let groups = vec![curry_group(), extras_group()];
        let item = rice_curry_item();
        // A required tier group must be picked before its price is looked at.
        assert!(bad(price_line(&item, &groups, "counter", &no_markup(), &picks(&[])))
            .contains("requires at least 1 pick"));
        for (ids, expected) in [
            (&["gang-1"][..], 5000_i64),
            (&["gang-1", "gang-2"][..], 6000),
            (&["gang-1", "gang-2", "gang-3"][..], 7000),
        ] {
            let line = price_line(&item, &groups, "counter", &no_markup(), &picks(ids)).unwrap();
            assert_eq!(line.unit_price, expected);
        }
        // Add-ons from other groups land on top of the tier price.
        let line = price_line(
            &item,
            &groups,
            "counter",
            &no_markup(),
            &picks(&["gang-1", "gang-2", "egg"]),
        )
        .unwrap();
        assert_eq!(line.unit_price, 6000 + 1000);
    }

    #[test]
    fn missing_tier_price_is_rejected() {
        let mut item = rice_curry_item();
        item.price_3 = None;
        let groups = vec![curry_group()];
        assert_eq!(
            bad(price_line(
                &item,
                &groups,
                "counter",
                &no_markup(),
                &picks(&["gang-1", "gang-2", "gang-3"])
            )),
            "no price for 3 curries"
        );
        // Zero picks in a non-required tier group price nothing either.
        let mut optional = curry_group();
        optional.required = false;
        assert_eq!(
            bad(price_line(&item, &[optional], "counter", &no_markup(), &picks(&[]))),
            "no price for 0 curries"
        );
    }

    #[test]
    fn counter_is_base_plus_add_ons() {
        let groups = vec![extras_group()];
        let line = price_line(
            &made_to_order_item(),
            &groups,
            "counter",
            &no_markup(),
            &picks(&["egg", "extra-rice"]),
        )
        .unwrap();
        assert_eq!(line.unit_price, 6000 + 1000 + 500);
        // No picks at all: just the base price.
        let line = price_line(&made_to_order_item(), &groups, "counter", &no_markup(), &[]).unwrap();
        assert_eq!(line.unit_price, 6000);
    }

    #[test]
    fn options_keep_selection_order() {
        let groups = vec![extras_group()];
        let line = price_line(
            &made_to_order_item(),
            &groups,
            "counter",
            &no_markup(),
            &picks(&["extra-rice", "egg"]),
        )
        .unwrap();
        assert_eq!(
            line.options,
            vec![
                SelectedOption {
                    id: "extra-rice".into(),
                    name: "opt extra-rice".into(),
                    price_add: 500,
                },
                SelectedOption {
                    id: "egg".into(),
                    name: "opt egg".into(),
                    price_add: 1000,
                },
            ]
        );
    }

    #[test]
    fn delivery_markup_percent_rounds_up_to_whole_baht() {
        let groups = vec![extras_group()];
        let mut item = made_to_order_item();
        item.base_price = 4500;
        // 4500 satang + 30% = 5850 -> rounded up to 5900 (59 baht).
        let markup = json!({"grab": {"kind": "percent", "value": 30}});
        let line = price_line(&item, &groups, "grab", &markup, &[]).unwrap();
        assert_eq!(line.unit_price, 5900);
        // An exact whole baht stays put: 6000 + 10% = 6600.
        let markup = json!({"grab": {"kind": "percent", "value": 10}});
        let line =
            price_line(&made_to_order_item(), &groups, "grab", &markup, &[]).unwrap();
        assert_eq!(line.unit_price, 6600);
        // Add-ons are marked up together with the base: 4500 + 500 + 10% = 5500.
        let line = price_line(&item, &groups, "grab", &markup, &picks(&["extra-rice"])).unwrap();
        assert_eq!(line.unit_price, 5500);
    }

    #[test]
    fn delivery_markup_baht_adds_satang() {
        let groups = vec![extras_group()];
        let markup = json!({"lineman": {"kind": "baht", "value": 500}});
        let line = price_line(
            &made_to_order_item(),
            &groups,
            "lineman",
            &markup,
            &picks(&["egg"]),
        )
        .unwrap();
        assert_eq!(line.unit_price, 6000 + 1000 + 500);
    }

    #[test]
    fn delivery_without_markup_keeps_the_counter_price() {
        let groups = vec![extras_group()];
        // Empty markup object...
        let line = price_line(
            &made_to_order_item(),
            &groups,
            "foodpanda",
            &no_markup(),
            &picks(&["egg"]),
        )
        .unwrap();
        assert_eq!(line.unit_price, 7000);
        // ...or no rule for this channel.
        let markup = json!({"grab": {"kind": "percent", "value": 30}});
        let line = price_line(
            &made_to_order_item(),
            &groups,
            "foodpanda",
            &markup,
            &picks(&["egg"]),
        )
        .unwrap();
        assert_eq!(line.unit_price, 7000);
    }

    #[test]
    fn made_to_order_override_beats_the_markup() {
        let mut item = made_to_order_item();
        item.grab_price = Some(8000);
        let groups = vec![extras_group()];
        let markup = json!({"grab": {"kind": "percent", "value": 30}});
        // Override + add-ons, NO markup on top.
        let line = price_line(&item, &groups, "grab", &markup, &picks(&["egg"])).unwrap();
        assert_eq!(line.unit_price, 8000 + 1000);
        // A channel without an override still pays its markup: 6000+30% = 7800.
        let markup = json!({"lineman": {"kind": "percent", "value": 30}});
        let line = price_line(&item, &groups, "lineman", &markup, &[]).unwrap();
        assert_eq!(line.unit_price, 7800);
    }

    #[test]
    fn rice_curry_never_uses_the_channel_override() {
        // Override columns only carry made_to_order prices (3.6): a rice_curry
        // plate is priced from its tier + markup instead.
        let mut item = rice_curry_item();
        item.grab_price = Some(9999);
        let groups = vec![curry_group()];
        let markup = json!({"grab": {"kind": "baht", "value": 1000}});
        let line = price_line(&item, &groups, "grab", &markup, &picks(&["gang-1", "gang-2"]))
            .unwrap();
        assert_eq!(line.unit_price, 6000 + 1000);
    }

    #[test]
    fn unknown_channel_and_corrupt_markup_are_rejected() {
        let groups = vec![extras_group()];
        let item = made_to_order_item();
        assert!(bad(price_line(&item, &groups, "shopee", &no_markup(), &[])).contains("channel"));
        let corrupt = json!({"grab": {"kind": "euro", "value": 1}});
        assert!(bad(price_line(&item, &groups, "grab", &corrupt, &[])).contains("markup"));
        let corrupt = json!({"grab": {"kind": "percent", "value": "30"}});
        assert!(bad(price_line(&item, &groups, "grab", &corrupt, &[])).contains("markup"));
    }

    #[test]
    fn line_total_bounds_quantity_and_multiplies_checked() {
        assert!(matches!(line_total(5000, 0), Err(ApiError::BadRequest(_))));
        assert!(matches!(line_total(5000, 100), Err(ApiError::BadRequest(_))));
        assert!(matches!(line_total(5000, -1), Err(ApiError::BadRequest(_))));
        assert_eq!(line_total(5000, 1).unwrap(), 5000);
        assert_eq!(line_total(5000, 99).unwrap(), 495_000);
        // i64::MAX cannot be doubled, even for quantity 2.
        assert!(matches!(line_total(i64::MAX, 2), Err(ApiError::Internal(_))));
    }
}
