//! Client-side order-line price PREVIEW — mirrors api/src/pricing.rs exactly
//! (ROADMAP M1-3b; FEATURES 3.4-3.6). Money is INTEGER satang, integer math
//! only (no floats). The SERVER total is authoritative; everything here is
//! only the live preview / local validation before "ส่งครัว".

import type { ChannelMarkup, MenuData, MenuItem, MenuOption, OptionGroup } from '../api'

/** The four sales channels (orders.channel, schema 0001). */
export type Channel = 'counter' | 'grab' | 'lineman' | 'foodpanda'

/** One option group with its options, as it applies to one item. */
export interface GroupWithOptions {
  readonly group: OptionGroup
  readonly options: MenuOption[]
}

/** A picked option, in selection order (the same snapshot the server stores). */
export interface PricedPick {
  readonly id: string
  readonly name: string
  readonly price_add: number
}

/** priceLine either prices the line or says (in Thai) why it cannot be sold. */
export type LineResult =
  | { ok: true; unitPrice: number; options: PricedPick[] }
  | { ok: false; error: string }

/**
 * The groups that take part when `item` is priced: the item's own groups plus
 * the shop-wide ones (menu_item_id NULL). A group linked to another item never
 * applies — same filter as the server engine.
 */
export function applicableGroups(menu: MenuData, item: MenuItem): GroupWithOptions[] {
  return menu.option_groups
    .filter((g) => g.menu_item_id === null || g.menu_item_id === item.id)
    // Stable sort: ties keep the server order (sort_order, created_at, id) =
    // the order the owner created them in, same as the owner editor.
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((group) => ({
      group,
      options: menu.options
        .filter((o) => o.option_group_id === group.id)
        .sort((a, b) => a.sort_order - b.sort_order),
    }))
}

/** The rice_curry plate price for `picks` curries (base_price/price_2/price_3). */
function tierPrice(item: MenuItem, picks: number): number | null {
  if (picks === 1) return item.base_price
  if (picks === 2) return item.price_2
  if (picks === 3) return item.price_3
  return null
}

/** The made_to_order per-channel final price column, if set (FEATURES 3.6). */
function channelOverride(item: MenuItem, channel: Channel): number | null {
  switch (channel) {
    case 'grab':
      return item.grab_price
    case 'lineman':
      return item.lineman_price
    case 'foodpanda':
      return item.foodpanda_price
    default:
      return null
  }
}

/**
 * The shop's markup rule for one delivery channel (FEATURES 3.6):
 * - channel absent from the markup object -> price unchanged,
 * - baht -> price + value satang,
 * - percent -> price*(100+p)/100 rounded UP to a whole baht, integer math
 *   (mirrors the server's div_ceil(10_000)*100).
 */
function applyMarkup(price: number, channel: Channel, markup: ChannelMarkup): number {
  const rule = channel === 'counter' ? undefined : markup[channel]
  if (!rule) return price
  if (rule.kind === 'baht') return price + rule.value
  return Math.ceil((price * (rule.value + 100)) / 10_000) * 100
}

/**
 * Prices ONE line: `item` with `selected` option ids (selection order kept)
 * sold on `channel`. Rules and their order mirror price_line in pricing.rs:
 * sellable item -> resolve picks (unknown/duplicate/sold-out/stock-out rejected) ->
 * per-group pick policy -> tier base price -> add-ons -> counter price or
 * (made_to_order override | shop markup).
 */
export function priceLine(
  menu: MenuData,
  item: MenuItem,
  channel: Channel,
  selected: readonly string[],
): LineResult {
  // Rule 1: sellable right now.
  if (item.status !== 'active' || item.sold_out) {
    return { ok: false, error: `เมนู "${item.name}" ของหมดอยู่ ขายไม่ได้` }
  }
  // Rule 1, stock half: the item's own recipe is short of an auto_block
  // ingredient (derived stock_out, migration 0010). Same refusal as sold_out,
  // message mirrors the server's Thai one in pricing.rs.
  if (item.stock_out) {
    return { ok: false, error: `เมนู "${item.name}" ยังขายไม่ได้: วัตถุดิบไม่พอ` }
  }

  // Rule 2: resolve every picked id, at most once, not sold out.
  const groups = applicableGroups(menu, item)
  const options: PricedPick[] = []
  const picksPerGroup: number[] = groups.map(() => 0)
  for (const id of selected) {
    let gi = -1
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].options.some((o) => o.id === id)) {
        gi = i
        break
      }
    }
    if (gi < 0) return { ok: false, error: 'มีตัวเลือกที่ใช้กับเมนูนี้ไม่ได้ ลองเลือกใหม่' }
    if (options.some((p) => p.id === id)) return { ok: false, error: 'เลือกตัวเลือกเดียวกันซ้ำ' }
    const opt = groups[gi].options.find((o) => o.id === id)
    if (!opt) return { ok: false, error: 'ไม่พบตัวเลือกนี้' }
    if (opt.sold_out) return { ok: false, error: `ตัวเลือก "${opt.name}" ของหมดแล้ว` }
    // Rule 2, stock half: derived stock_out — same refusal as sold_out, the
    // message mirrors the server's Thai one in pricing.rs.
    if (opt.stock_out) return { ok: false, error: `ตัวเลือก "${opt.name}" ยังขายไม่ได้: วัตถุดิบไม่พอ` }
    picksPerGroup[gi] += 1
    options.push({ id: opt.id, name: opt.name, price_add: opt.price_add })
  }

  // Rule 3: per-group pick policy.
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i].group
    if (g.max_select !== null && picksPerGroup[i] > g.max_select) {
      return { ok: false, error: `"${g.name}" เลือกได้สูงสุด ${g.max_select} อย่าง` }
    }
    if (g.required && picksPerGroup[i] === 0) {
      return { ok: false, error: `"${g.name}" ต้องเลือกอย่างน้อย 1 อย่าง` }
    }
  }

  // Rule 4: the base price — rice_curry with a tier group prices by pick count.
  let base = item.base_price
  if (item.menu_type === 'rice_curry') {
    const ti = groups.findIndex((g) => g.group.tier_pricing)
    if (ti >= 0) {
      const tp = tierPrice(item, picksPerGroup[ti])
      if (tp === null) {
        return {
          ok: false,
          error:
            picksPerGroup[ti] === 0
              ? 'ยังไม่ได้เลือกแกง'
              : 'เลือกแกงได้ 1-3 อย่างเท่านั้น',
        }
      }
      base = tp
    }
  }

  // Rules 5-6: add-ons, then the channel.
  const addOns = options.reduce((s, o) => s + o.price_add, 0)
  const withAddOns = base + addOns
  let unitPrice: number
  if (channel === 'counter') {
    unitPrice = withAddOns
  } else {
    const override =
      item.menu_type === 'made_to_order' ? channelOverride(item, channel) : null
    unitPrice =
      override !== null
        ? override + addOns
        : applyMarkup(withAddOns, channel, menu.channel_markup)
  }
  return { ok: true, unitPrice, options }
}

/**
 * Local pre-submit validation of one line (the same rules as priceLine plus
 * the 1..99 quantity bound of the server's line_total). Returns the first
 * Thai error, or null when the line can be keyed as-is.
 */
export function validateLine(
  menu: MenuData,
  item: MenuItem,
  channel: Channel,
  selected: readonly string[],
  quantity: number,
): string | null {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return 'จำนวนต้องอยู่ระหว่าง 1-99'
  }
  const r = priceLine(menu, item, channel, selected)
  return r.ok ? null : r.error
}

/**
 * The single price shown on an item button: the price of the simplest line of
 * that item on `channel` (no add-ons; a tier rice_curry plate shows its
 * 1-อย่าง price). Works for sold-out items too (the button is dimmed anyway).
 */
export function previewUnitPrice(menu: MenuData, item: MenuItem, channel: Channel): number {
  if (channel === 'counter') return item.base_price
  const override = item.menu_type === 'made_to_order' ? channelOverride(item, channel) : null
  return override !== null ? override : applyMarkup(item.base_price, channel, menu.channel_markup)
}

// ---- money helpers (backend stores INTEGER satang; UI shows/enters baht) ----

/** 5500 -> "55", 5550 -> "55.50". */
export function fmtBaht(satang: number): string {
  const b = satang / 100
  return Number.isInteger(b) ? String(b) : b.toFixed(2)
}

/** '' -> null; unparsable/negative -> null; else satang rounded to whole stang. */
export function bahtToSatang(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return null
  const v = Math.round(n * 100)
  return Number.isSafeInteger(v) ? v : null
}
