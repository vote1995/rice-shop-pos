//! `GET /owner/shops/{shop_id}/report` - the order-tab summary (owner only).
//!
//! Query (all optional):
//! - `from`, `to`       Bangkok days `YYYY-MM-DD`, inclusive (default: today);
//!   at most [`MAX_DAYS`] days. A month = its first and last day.
//! - `tfrom`, `tto`     time of day in MINUTES (0..=1440) Bangkok, `tfrom`
//!   inclusive / `tto` exclusive; `tfrom > tto` wraps midnight (22:00-02:00).
//! - `menu_item_id`     only bills with a line of this type ...
//! - `option_id`        ... (and, with it, a line that picked this choice)
//! - `ingredient_id`    only bills whose sale used this ingredient
//!
//! Every figure is computed over ONE set of bills (the `m` CTE below, repeated
//! per statement): money from paid bills minus their refunds, plates / menu /
//! choice counts from the lines of paid bills (narrowed to the filtered type
//! / choice when given), ingredient use from the stock journal of those
//! bills (a cancelled bill nets to zero there). Six aggregate statements plus
//! one capped bill list - never a query per bill.

use axum::{
    extract::{Path, RawQuery, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use super::orders::day_param_start_ms;
use super::query_param;
use crate::auth::owner::OwnerAuth;
use crate::util::{int, now_ms, parse_uuid, txt};
use crate::{db, error::ApiError, AppState};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS: i64 = 7 * 60 * 60 * 1000;
pub const MAX_DAYS: i64 = 366;
const MAX_BILLS: i64 = 200;

/// The filtered bills. Binds: ?1 shop, ?2 from ms, ?3 to ms (exclusive),
/// ?4/?5 time-of-day window ms, ?6 menu item | NULL, ?7 option | NULL,
/// ?8 ingredient | NULL. `tod` = ms since Bangkok midnight.
const MATCHED: &str = "WITH m AS (
  SELECT o.id, o.created_at, o.status, o.total_amount, o.channel, o.queue_number,
         o.total_amount - COALESCE((SELECT SUM(p.refund_amount) FROM payments p
                                    WHERE p.order_id = o.id AND p.status = 'refunded'), 0) AS net
  FROM orders o
  WHERE o.shop_id = ?1 AND o.created_at >= ?2 AND o.created_at < ?3
    AND ((?4 <= ?5 AND (o.created_at + 25200000) % 86400000 >= ?4
                   AND (o.created_at + 25200000) % 86400000 <  ?5)
      OR (?4 >  ?5 AND ((o.created_at + 25200000) % 86400000 >= ?4
                     OR (o.created_at + 25200000) % 86400000 <  ?5)))
    AND (?6 IS NULL OR EXISTS (
          SELECT 1 FROM order_items i
          WHERE i.order_id = o.id AND i.menu_item_id = ?6
            AND (?7 IS NULL OR EXISTS (SELECT 1 FROM json_each(i.options_json) j
                                       WHERE json_extract(j.value, '$.id') = ?7))))
    AND (?8 IS NULL OR EXISTS (SELECT 1 FROM stock_moves s
                               WHERE s.order_id = o.id AND s.kind = 'sale'
                                 AND s.ingredient_id = ?8))
)";

/// Lines that count for the menu/choice tables: of paid bills, and only the
/// filtered type / choice when given (same binds).
const LINE_FILTER: &str = "m.status = 'paid'
  AND (?6 IS NULL OR i.menu_item_id = ?6)
  AND (?7 IS NULL OR EXISTS (SELECT 1 FROM json_each(i.options_json) j
                             WHERE json_extract(j.value, '$.id') = ?7))";

#[derive(Debug, Clone, PartialEq)]
pub struct Filter {
    pub from_ms: i64,
    pub to_ms: i64,
    pub tod_from_ms: i64,
    pub tod_to_ms: i64,
    pub menu_item_id: Option<String>,
    pub option_id: Option<String>,
    pub ingredient_id: Option<String>,
}

fn minutes(raw: Option<String>, field: &str, default: i64) -> Result<i64, ApiError> {
    match raw {
        None => Ok(default),
        Some(v) => v
            .parse::<i64>()
            .ok()
            .filter(|m| (0..=1440).contains(m))
            .ok_or_else(|| ApiError::BadRequest(format!("{field} must be minutes 0..=1440"))),
    }
}

fn opt_uuid(raw: Option<String>, field: &str) -> Result<Option<String>, ApiError> {
    raw.filter(|v| !v.is_empty())
        .map(|v| parse_uuid(&v, field).map(|u| u.to_string()))
        .transpose()
}

/// Validates the query into a [`Filter`] (pure; `now` picks "today").
pub fn parse_filter(query: &Option<String>, now: i64) -> Result<Filter, ApiError> {
    let from_ms = day_param_start_ms(query_param(query, "from").as_deref(), now)?;
    let to_start = match query_param(query, "to") {
        Some(to) => day_param_start_ms(Some(&to), now)?,
        None => from_ms,
    };
    if to_start < from_ms {
        return Err(ApiError::BadRequest("to must not be before from".into()));
    }
    if (to_start - from_ms) / DAY_MS + 1 > MAX_DAYS {
        return Err(ApiError::BadRequest(format!("at most {MAX_DAYS} days")));
    }
    let option_id = opt_uuid(query_param(query, "option_id"), "option_id")?;
    let menu_item_id = opt_uuid(query_param(query, "menu_item_id"), "menu_item_id")?;
    if option_id.is_some() && menu_item_id.is_none() {
        return Err(ApiError::BadRequest("option_id needs menu_item_id".into()));
    }
    Ok(Filter {
        from_ms,
        to_ms: to_start + DAY_MS,
        tod_from_ms: minutes(query_param(query, "tfrom"), "tfrom", 0)? * 60_000,
        tod_to_ms: minutes(query_param(query, "tto"), "tto", 1440)? * 60_000,
        menu_item_id,
        option_id,
        ingredient_id: opt_uuid(query_param(query, "ingredient_id"), "ingredient_id")?,
    })
}

/// "YYYY-MM-DD" of a Bangkok day index (days since 1970-01-01 Bangkok).
pub fn day_label(day_index: i64) -> String {
    let z = day_index + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn binds(shop_id: &str, f: &Filter) -> Vec<JsValue> {
    let opt = |v: &Option<String>| v.as_deref().map_or(JsValue::NULL, txt);
    vec![
        txt(shop_id),
        int(f.from_ms),
        int(f.to_ms),
        int(f.tod_from_ms),
        int(f.tod_to_ms),
        opt(&f.menu_item_id),
        opt(&f.option_id),
        opt(&f.ingredient_id),
    ]
}

#[derive(Debug, Deserialize, Serialize)]
struct Summary {
    bills: i64,
    net: i64,
    refunds: i64,
    cancelled: i64,
    open: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct Bucket {
    k: i64,
    bills: i64,
    net: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct MenuRow {
    menu_item_id: String,
    name: String,
    qty: i64,
    amount: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct ChoiceRow {
    option_id: String,
    name: String,
    menu_item_id: String,
    qty: i64,
}

#[derive(Debug, Deserialize, Serialize)]
struct IngredientRow {
    ingredient_id: String,
    name: String,
    unit: String,
    used: f64,
}

#[derive(Debug, Deserialize, Serialize)]
struct BillRow {
    id: String,
    queue_number: i64,
    created_at: i64,
    channel: String,
    status: String,
    net: i64,
    lines: Option<String>,
}

#[worker::send]
pub async fn report(
    State(state): State<AppState>,
    _owner: OwnerAuth,
    Path(shop_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Result<Json<Value>, ApiError> {
    let shop_id = parse_uuid(&shop_id, "shop_id")?.to_string();
    let f = parse_filter(&query, now_ms())?;
    let env = &state.env;
    let b = binds(&shop_id, &f);
    let all = |sql: String| -> Result<worker::D1PreparedStatement, ApiError> {
        Ok(db::db(env)?.prepare(format!("{MATCHED} {sql}")).bind(&b)?)
    };

    let results = db::db(env)?
        .batch(vec![
            all("SELECT COUNT(CASE WHEN status = 'paid' THEN 1 END) AS bills,
                        COALESCE(SUM(CASE WHEN status = 'paid' THEN net END), 0) AS net,
                        COALESCE(SUM(CASE WHEN status = 'paid' THEN total_amount - net END), 0) AS refunds,
                        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) AS cancelled,
                        COUNT(CASE WHEN status IN ('preparing', 'served') THEN 1 END) AS open
                 FROM m".into())?,
            all(format!(
                "SELECT (created_at + {BANGKOK_OFFSET_MS}) / {DAY_MS} AS k, COUNT(*) AS bills,
                        SUM(net) AS net
                 FROM m WHERE status = 'paid' GROUP BY k ORDER BY k"
            ))?,
            all(format!(
                "SELECT ((created_at + {BANGKOK_OFFSET_MS}) % {DAY_MS}) / 3600000 AS k,
                        COUNT(*) AS bills, SUM(net) AS net
                 FROM m WHERE status = 'paid' GROUP BY k ORDER BY k"
            ))?,
            all(format!(
                "SELECT i.menu_item_id, COALESCE(mi.name, MAX(i.item_name)) AS name,
                        SUM(i.quantity) AS qty, SUM(i.line_total) AS amount
                 FROM order_items i JOIN m ON m.id = i.order_id
                 LEFT JOIN menu_items mi ON mi.id = i.menu_item_id
                 WHERE {LINE_FILTER}
                 GROUP BY i.menu_item_id ORDER BY qty DESC, amount DESC"
            ))?,
            all(format!(
                "SELECT json_extract(j.value, '$.id') AS option_id,
                        MAX(json_extract(j.value, '$.name')) AS name,
                        i.menu_item_id, SUM(i.quantity) AS qty
                 FROM order_items i JOIN m ON m.id = i.order_id, json_each(i.options_json) j
                 WHERE {LINE_FILTER}
                 GROUP BY option_id, i.menu_item_id ORDER BY qty DESC"
            ))?,
            all("SELECT s.ingredient_id, g.name, g.unit, -SUM(s.delta) AS used
                 FROM stock_moves s JOIN m ON m.id = s.order_id
                 JOIN ingredients g ON g.id = s.ingredient_id
                 WHERE s.kind IN ('sale', 'cancel')
                 GROUP BY s.ingredient_id HAVING ABS(used) > 0.00005
                 ORDER BY g.name".into())?,
            all(format!(
                "SELECT m.id, m.queue_number, m.created_at, m.channel, m.status, m.net,
                        (SELECT group_concat(i.quantity || '× ' || i.item_name, ', ')
                         FROM order_items i WHERE i.order_id = m.id) AS lines
                 FROM m ORDER BY m.created_at DESC LIMIT {MAX_BILLS}"
            ))?,
        ])
        .await?;
    let [summary, by_day, by_hour, menu, choices, ingredients, bills] = results
        .try_into()
        .map_err(|_| ApiError::Internal("report batch returned a wrong count".into()))?;

    let summary = summary
        .results::<Summary>()?
        .pop()
        .ok_or_else(|| ApiError::Internal("report summary row missing".into()))?;
    let menu = menu.results::<MenuRow>()?;
    let plates: i64 = menu.iter().map(|r| r.qty).sum();
    Ok(Json(json!({
        "from": day_label((f.from_ms + BANGKOK_OFFSET_MS) / DAY_MS),
        "to": day_label((f.to_ms - DAY_MS + BANGKOK_OFFSET_MS) / DAY_MS),
        "summary": {
            "bills": summary.bills,
            "net": summary.net,
            "refunds": summary.refunds,
            "cancelled": summary.cancelled,
            "open": summary.open,
            "plates": plates,
            "avg_bill": if summary.bills > 0 { summary.net / summary.bills } else { 0 },
        },
        "by_day": by_day.results::<Bucket>()?.into_iter()
            .map(|r| json!({ "day": day_label(r.k), "bills": r.bills, "net": r.net }))
            .collect::<Vec<_>>(),
        "by_hour": by_hour.results::<Bucket>()?.into_iter()
            .map(|r| json!({ "hour": r.k, "bills": r.bills, "net": r.net }))
            .collect::<Vec<_>>(),
        "menu": menu,
        "choices": choices.results::<ChoiceRow>()?,
        "ingredients": ingredients.results::<IngredientRow>()?.into_iter()
            .map(|r| json!({ "ingredient_id": r.ingredient_id, "name": r.name, "unit": r.unit,
                             "used": (r.used * 10_000.0).round() / 10_000.0 }))
            .collect::<Vec<_>>(),
        "bills": bills.results::<BillRow>()?,
        "bills_capped_at": MAX_BILLS,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z = 07:00 Bangkok
    fn q(s: &str) -> Option<String> {
        Some(s.to_owned())
    }

    #[test]
    fn defaults_to_today_whole_day() {
        let f = parse_filter(&None, NOW).unwrap();
        assert_eq!(day_label((f.from_ms + BANGKOK_OFFSET_MS) / DAY_MS), "2026-10-31");
        assert_eq!(f.to_ms - f.from_ms, DAY_MS);
        assert_eq!((f.tod_from_ms, f.tod_to_ms), (0, DAY_MS));
        assert_eq!(f.menu_item_id, None);
    }

    #[test]
    fn period_is_inclusive_and_bounded() {
        let f = parse_filter(&q("from=2026-10-22&to=2026-10-30"), NOW).unwrap();
        assert_eq!((f.to_ms - f.from_ms) / DAY_MS, 9);
        assert!(parse_filter(&q("from=2026-10-30&to=2026-10-22"), NOW).is_err());
        assert!(parse_filter(&q("from=2025-01-01&to=2026-10-30"), NOW).is_err());
        assert!(parse_filter(&q("from=2026-02-30"), NOW).is_err());
    }

    #[test]
    fn time_window_and_ids_are_validated() {
        let f = parse_filter(&q("tfrom=660&tto=840"), NOW).unwrap();
        assert_eq!((f.tod_from_ms, f.tod_to_ms), (660 * 60_000, 840 * 60_000));
        assert!(parse_filter(&q("tfrom=1500"), NOW).is_err());
        assert!(parse_filter(&q("menu_item_id=nope"), NOW).is_err());
        let id = "0b6f1c1e-6a52-4d0e-9a51-6f3d7c2b9e10";
        assert!(parse_filter(&q(&format!("option_id={id}")), NOW).is_err());
        let f = parse_filter(&q(&format!("menu_item_id={id}&option_id={id}&ingredient_id=")), NOW).unwrap();
        assert_eq!(f.option_id.as_deref(), Some(id));
        assert_eq!(f.ingredient_id, None);
    }

    #[test]
    fn day_labels() {
        assert_eq!(day_label(0), "1970-01-01");
        assert_eq!(day_label(19_782), "2024-02-29");
        assert_eq!(day_label(20_757), "2026-10-31");
    }
}
