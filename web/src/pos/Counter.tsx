//! Staff selling screen, M1-6d rewrite: one-thumb counter flow.
//!
//! ช่องทาง -> ประเภท -> ติ๊กตัวเลือก -> ใส่ตะกร้า -> ส่งครัว / รับเงิน.
//! Kept from the old SalesApp: the idempotent client ids (order/line/payment,
//! reused on retry so a network error never double-charges), the localStorage
//! held bills (พักบิล), long-press sold-out toggles, the 10 s queue polling and
//! the satang money handling. Prices shown here are a PREVIEW via pricing.ts;
//! the server stays authoritative.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ApiError, api, errorCode, friendlyError } from '../api'
import type { MenuData, MenuItem, MenuOption, Order } from '../api'
import { applicableGroups, bahtToSatang, fmtBaht, priceLine, validateLine } from './pricing'
import type { Channel, GroupWithOptions } from './pricing'

// ---------------------------------------------------------------------------
// Constants / small helpers
// ---------------------------------------------------------------------------

const GREEN = '#17694A'
const INK = '#1B1C1A'
const MUTED = '#5E615B'
const LINE = '#E2E0DA'
const OFFWHITE = '#E9E7E1'
const ORANGE = '#B4530E'
const RED = '#A3341F'
const BORDER = '#D4D2CB'

/** One tap picks the sales channel; หน้าร้าน = counter, the rest = delivery. */
const CHANNELS: Array<{ id: Channel; label: string }> = [
  { id: 'counter', label: 'หน้าร้าน' },
  { id: 'grab', label: 'Grab' },
  { id: 'lineman', label: 'LINE MAN' },
  { id: 'foodpanda', label: 'Foodpanda' },
]

const CHANNEL_LABEL: Record<string, string> = {
  counter: 'หน้าร้าน',
  grab: 'Grab',
  lineman: 'LINE MAN',
  foodpanda: 'Foodpanda',
}

const CANCEL_REASONS = ['ลูกค้าเปลี่ยนใจ', 'สั่งผิด', 'ของหมด']
const BANKNOTES = [20, 50, 100, 500, 1000]

const ORDERS_POLL_MS = 10_000
/** One bill holds at most 50 lines (server bound). */
const MAX_LINES = 50
const DRAFTS_KEY = 'pos.drafts'
const CHANNEL_KEY = 'pos.channel'
const LONG_PRESS_MS = 550

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Start of the Bangkok (UTC+7) calendar day `now` falls in, unix ms. */
function bangkokDayStart(now: number): number {
  return Math.floor((now + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS
}

/** 2500 -> "฿25". Money stays integer satang everywhere in this file. */
function baht(satang: number): string {
  return `฿${fmtBaht(satang)}`
}

function isDeliveryChannel(ch: string): ch is Channel {
  return ch === 'grab' || ch === 'lineman' || ch === 'foodpanda'
}

function normalizeChannel(ch: string): Channel {
  return isDeliveryChannel(ch) ? ch : 'counter'
}

/** A "quick" type (เครื่องดื่ม, ทานเล่น): one pick-one list and no base price,
 *  so one tap on a choice IS the order — and the server names the line by the
 *  pick ("ชาเย็น", not "เครื่องดื่ม ชาเย็น"). */
function isQuickType(menu: MenuData, item: MenuItem): boolean {
  if (item.base_price !== 0) return false
  const gs = applicableGroups(menu, item)
  return gs.length === 1 && gs[0].group.max_select === 1
}

function samePicks(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x) => b.includes(x))
}

// ---------------------------------------------------------------------------
// Cart + held bills (localStorage, never lost by a reload)
// ---------------------------------------------------------------------------

interface CartLine {
  /** client UUID, made ONCE per line; retries reuse it */
  id: string
  menu_item_id: string
  option_ids: string[]
  quantity: number
}

interface Cart {
  /** client UUID, made ONCE per bill; retries reuse it */
  id: string
  channel: Channel
  lines: CartLine[]
}

interface Drafts {
  current: Cart
  held: Cart[]
}

function blankCart(channel: Channel): Cart {
  return { id: crypto.randomUUID(), channel, lines: [] }
}

function sanitizeCart(raw: unknown): Cart {
  const c = raw as Cart | null | undefined
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Array.isArray(c.lines)) {
    return blankCart('counter')
  }
  const lines = (c.lines as unknown[])
    .filter(
      (l): l is CartLine =>
        !!l &&
        typeof (l as CartLine).id === 'string' &&
        typeof (l as CartLine).menu_item_id === 'string' &&
        Array.isArray((l as CartLine).option_ids) &&
        typeof (l as CartLine).quantity === 'number',
    )
    .map((l) => ({
      id: l.id,
      menu_item_id: l.menu_item_id,
      option_ids: l.option_ids.filter((o): o is string => typeof o === 'string'),
      quantity: Math.min(99, Math.max(1, Math.round(l.quantity))),
    }))
  return { id: c.id, channel: normalizeChannel(typeof c.channel === 'string' ? c.channel : 'counter'), lines }
}

function loadDrafts(): Drafts {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (raw) {
      const d = JSON.parse(raw) as Drafts
      if (d && typeof d === 'object' && Array.isArray(d.held)) {
        return { current: sanitizeCart(d.current), held: d.held.map(sanitizeCart) }
      }
    }
  } catch {
    // corrupt storage -> start fresh, never crash the sale screen
  }
  return { current: blankCart(loadChannel()), held: [] }
}

function loadChannel(): Channel {
  try {
    const raw = localStorage.getItem(CHANNEL_KEY)
    return normalizeChannel(typeof raw === 'string' ? raw : '')
  } catch {
    return 'counter'
  }
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

interface PaymentJson {
  id: string
  method: string
  amount: number
  cash_received: number | null
  cash_change: number | null
  status: string
}

interface PayResult {
  order: Order
  payment: PaymentJson
}

interface PricedCartLine {
  line: CartLine
  name: string
  optionsText: string
  error: string | null
  total: number | null
}

interface ToastState {
  text: string
  label: string | null
  run: (() => void) | null
}

// ---------------------------------------------------------------------------
// Button styles (inline: this screen has its own tighter look, no CSS change)
// ---------------------------------------------------------------------------

const S = {
  root: {
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    margin: '0 -16px -16px',
  } as CSSProperties,
  body: {
    flex: '1 1 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    padding: '10px 16px 12px',
  } as CSSProperties,
  panel: {
    background: '#FFFFFF',
    borderTop: `1px solid ${LINE}`,
    padding: '8px 16px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } as CSSProperties,
  channelBtn: (on: boolean) =>
    ({
      flex: 1,
      height: 44,
      minHeight: 44,
      borderRadius: 10,
      fontSize: 13,
      fontWeight: 600,
      padding: '0 4px',
      border: `1.5px solid ${on ? GREEN : BORDER}`,
      background: on ? GREEN : '#FFFFFF',
      color: on ? '#FFFFFF' : INK,
    }) as CSSProperties,
  typeBtn: (on: boolean) =>
    ({
      height: 52,
      minHeight: 52,
      borderRadius: 12,
      fontSize: 15,
      fontWeight: 700,
      padding: '0 4px',
      border: 0,
      background: on ? INK : OFFWHITE,
      color: on ? '#FFFFFF' : INK,
      lineHeight: 1.2,
    }) as CSSProperties,
  chip: (on: boolean) =>
    ({
      minHeight: 44,
      padding: '0 14px',
      borderRadius: 22,
      fontSize: 15,
      fontWeight: 600,
      border: `1.5px solid ${on ? GREEN : BORDER}`,
      background: on ? GREEN : '#FFFFFF',
      color: on ? '#FFFFFF' : INK,
    }) as CSSProperties,
  bigBtn: (bg: string, fg: string, border: string) =>
    ({
      height: 50,
      minHeight: 50,
      borderRadius: 14,
      border: `1.5px solid ${border}`,
      background: bg,
      color: fg,
      fontSize: 16,
      fontWeight: 700,
      padding: '0 14px',
    }) as CSSProperties,
  cardBtn: (bg: string, fg: string, border: string) =>
    ({
      height: 44,
      minHeight: 44,
      borderRadius: 12,
      border: `1.5px solid ${border}`,
      background: bg,
      color: fg,
      fontSize: 14,
      fontWeight: 700,
      padding: '0 12px',
    }) as CSSProperties,
  linkBtn: {
    background: 'none',
    border: 0,
    color: RED,
    fontSize: 14,
    fontWeight: 600,
    minHeight: 44,
    padding: '0 10px',
  } as CSSProperties,
  nav: {
    display: 'flex',
    background: '#FFFFFF',
    borderTop: `1px solid ${LINE}`,
  } as CSSProperties,
  navBtn: (on: boolean) =>
    ({
      flex: 1,
      height: 56,
      minHeight: 56,
      border: 0,
      borderTop: `3px solid ${on ? GREEN : 'transparent'}`,
      background: 'none',
      color: on ? GREEN : MUTED,
      fontSize: 16,
      fontWeight: 700,
      borderRadius: 0,
    }) as CSSProperties,
  pill: (bg: string, fg: string) =>
    ({ background: bg, color: fg }) as CSSProperties,
  field: {
    flex: 1,
    minWidth: 0,
    height: 46,
    minHeight: 46,
    borderRadius: 12,
    border: `1.5px solid ${BORDER}`,
    padding: '0 12px',
    fontSize: 16,
    color: INK,
    background: '#FFFFFF',
  } as CSSProperties,
}

// ---------------------------------------------------------------------------
// Long-press button: tap = pick, press-and-hold = toggle sold-out
// ---------------------------------------------------------------------------

function LongPressButton({
  style,
  onLong,
  onTap,
  children,
  ariaLabel,
}: {
  style: CSSProperties
  onLong: () => void
  onTap: () => void
  children: ReactNode
  ariaLabel?: string
}) {
  const timer = useRef<number | null>(null)
  const fired = useRef(false)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  function clear() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  function down() {
    fired.current = false
    clear()
    timer.current = window.setTimeout(() => {
      timer.current = null
      fired.current = true
      onLong()
    }, LONG_PRESS_MS)
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      style={style}
      onPointerDown={down}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (fired.current) {
          fired.current = false
          return // the long-press already handled this gesture
        }
        onTap()
      }}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

export default function Counter({
  onSessionExpired,
  onRevoked,
}: {
  onSessionExpired: () => void
  onRevoked: () => void
}) {
  const [tab, setTab] = useState<'sell' | 'queue'>('sell')
  const [menu, setMenu] = useState<MenuData | null>(null)
  const [menuErr, setMenuErr] = useState('')
  const [menuLoading, setMenuLoading] = useState(true)
  const [orders, setOrders] = useState<Order[]>([])
  const [ordersErr, setOrdersErr] = useState('')
  const [channel, setChannel] = useState<Channel>(loadChannel)
  const [drafts, setDrafts] = useState<Drafts>(loadDrafts)
  const [typeId, setTypeId] = useState<string | null>(null)
  const [picks, setPicks] = useState<string[]>([])
  const [cartOpen, setCartOpen] = useState(false)
  const [payFor, setPayFor] = useState<Order | null>(null)
  const [payResult, setPayResult] = useState<PayResult | null>(null)
  const [cancelFor, setCancelFor] = useState<Order | null>(null)
  const [addTo, setAddTo] = useState<Order | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)

  // keep the latest callbacks without re-creating the poller below
  const expiredRef = useRef(onSessionExpired)
  const revokedRef = useRef(onRevoked)
  useEffect(() => {
    expiredRef.current = onSessionExpired
    revokedRef.current = onRevoked
  })

  const toastTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    },
    [],
  )

  function clearToast() {
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current)
      toastTimer.current = null
    }
    setToast(null)
  }

  /** Short toast; with an action it stays 5 s (the "เลิกทำ" window). */
  function flash(text: string, action?: { label: string; run: () => void }) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    setToast(action ? { text, label: action.label, run: action.run } : { text, label: null, run: null })
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 5000 : 1800)
  }

  // ---- data loading ------------------------------------------------------

  const loadMenu = useCallback(async () => {
    setMenuLoading(true)
    try {
      const d = await api<MenuData>('GET', '/api/menu', undefined, 'both')
      setMenu(d)
      setMenuErr('')
    } catch (e) {
      if (errorCode(e) === 'session_invalid') return expiredRef.current()
      if (errorCode(e) === 'device_revoked') return revokedRef.current()
      setMenuErr(friendlyError(e))
    } finally {
      setMenuLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMenu()
  }, [loadMenu])

  const loadOrders = useCallback(async () => {
    try {
      const d = await api<{ orders: Order[] }>('GET', '/api/orders', undefined, 'both')
      setOrders(d.orders)
      setOrdersErr('')
    } catch (e) {
      if (errorCode(e) === 'session_invalid') return expiredRef.current()
      if (errorCode(e) === 'device_revoked') return revokedRef.current()
      setOrdersErr(friendlyError(e))
    }
  }, [])

  // 10 s polling while visible + on focus + after every action
  useEffect(() => {
    void loadOrders()
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadOrders()
    }, ORDERS_POLL_MS)
    const onFocus = () => {
      if (document.visibilityState === 'visible') void loadOrders()
    }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadOrders])

  // the picked channel and the cart/held bills survive a reload
  useEffect(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    } catch {
      // storage full/blocked — selling continues, just without persistence
    }
  }, [drafts])

  useEffect(() => {
    try {
      localStorage.setItem(CHANNEL_KEY, channel)
    } catch {
      // ignore
    }
  }, [channel])

  /**
   * Runs one mutation: busy flag, friendly Thai error, 401 session/revoked
   * hand-off, 409 -> reload the queue. Network/5xx NEVER clears the cart and
   * NEVER logs out (the client ids make the retry idempotent).
   */
  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true)
    try {
      const r = await fn()
      setMsg('')
      return r
    } catch (e) {
      if (errorCode(e) === 'session_invalid') {
        expiredRef.current()
        return null
      }
      if (errorCode(e) === 'device_revoked') {
        revokedRef.current()
        return null
      }
      setMsg(friendlyError(e))
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) void loadOrders()
      return null
    } finally {
      setBusy(false)
    }
  }

  // ---- derived data ------------------------------------------------------

  const cart = drafts.current
  /** The channel that prices what is on screen right now. */
  const activeChannel: Channel = addTo ? normalizeChannel(addTo.channel) : channel

  const items = useMemo(
    () =>
      menu
        ? [...menu.items]
            .filter((i) => i.status === 'active')
            .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'th'))
        : [],
    [menu],
  )

  const type: MenuItem | null = useMemo(
    () => items.find((i) => i.id === typeId) ?? items[0] ?? null,
    [items, typeId],
  )

  const groups = useMemo(
    () => (type && menu ? applicableGroups(menu, type) : []),
    [menu, type],
  )

  const quick = !!type && !!menu && isQuickType(menu, type)

  // changing the type starts a fresh plate
  useEffect(() => {
    setPicks([])
  }, [type?.id])

  const priced = useMemo(
    () => (type && menu ? priceLine(menu, type, activeChannel, picks) : null),
    [menu, type, activeChannel, picks],
  )

  const missingGroups = useMemo(
    () =>
      groups
        .filter(
          (g) =>
            g.group.required && !picks.some((id) => g.options.some((o) => o.id === id)),
        )
        .map((g) => g.group.name),
    [groups, picks],
  )

  const cartLines: PricedCartLine[] = useMemo(() => {
    if (!menu) {
      return cart.lines.map((l) => ({
        line: l,
        name: '…',
        optionsText: '',
        error: 'กำลังโหลดเมนู',
        total: null,
      }))
    }
    return cart.lines.map((l) => {
      const item = menu.items.find((i) => i.id === l.menu_item_id)
      const optionsText = l.option_ids
        .map((id) => menu.options.find((o) => o.id === id)?.name ?? '')
        .filter(Boolean)
        .join(', ')
      if (!item) {
        return {
          line: l,
          name: 'เมนูไม่พบ',
          optionsText,
          error: 'ไม่พบเมนูนี้แล้ว — ลบรายการนี้ออกก่อนส่ง',
          total: null,
        }
      }
      const r = priceLine(menu, item, activeChannel, l.option_ids)
      // a quick line is named by its pick, exactly like the kitchen ticket
      const name =
        isQuickType(menu, item) && l.option_ids.length === 1
          ? (menu.options.find((o) => o.id === l.option_ids[0])?.name ?? item.name)
          : item.name
      return {
        line: l,
        name,
        optionsText,
        error: r.ok ? null : r.error,
        total: r.ok ? r.unitPrice * l.quantity : null,
      }
    })
  }, [cart.lines, menu, activeChannel])

  const cartTotal = cartLines.reduce((s, c) => s + (c.total ?? 0), 0)
  const cartCount = cart.lines.reduce((s, l) => s + l.quantity, 0)
  const cartHasError = cartLines.some((c) => c.error !== null)

  /** Still in the kitchen (or paid but not served yet). */
  const queueOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.status === 'preparing' ||
          o.status === 'served' ||
          (o.status === 'paid' && o.served_at === null),
      ),
    [orders],
  )

  const paidToday = useMemo(() => {
    const start = bangkokDayStart(Date.now())
    return orders.filter((o) => o.status === 'paid' && o.created_at >= start)
  }, [orders])

  const dayTotal = paidToday.reduce((s, o) => s + o.total_amount, 0)

  // ---- cart editing ------------------------------------------------------

  function patchCart(patch: Partial<Cart>) {
    setDrafts((prev) => ({ ...prev, current: { ...prev.current, ...patch } }))
  }

  /** Adds/merges one line; returns false when the bill is already full. */
  function pushLine(item: MenuItem, optionIds: string[]): boolean {
    const lines = [...cart.lines]
    const idx = lines.findIndex(
      (l) => l.menu_item_id === item.id && samePicks(l.option_ids, optionIds),
    )
    if (idx >= 0) {
      lines[idx] = { ...lines[idx], quantity: Math.min(99, lines[idx].quantity + 1) }
    } else if (lines.length >= MAX_LINES) {
      setMsg(`บิลเดียวได้สูงสุด ${MAX_LINES} รายการ — ส่งครัวก่อนแล้วเปิดบิลใหม่`)
      return false
    } else {
      lines.push({
        id: crypto.randomUUID(),
        menu_item_id: item.id,
        option_ids: [...optionIds],
        quantity: 1,
      })
    }
    setMsg('')
    patchCart({ lines })
    return true
  }

  function setLineQty(id: string, delta: number) {
    setDrafts((prev) => {
      const lines = prev.current.lines
        .map((l) => (l.id === id ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity >= 1)
      return { ...prev, current: { ...prev.current, lines } }
    })
  }

  function clearCart() {
    patchCart({ lines: [] })
  }

  function holdCart() {
    setDrafts((prev) =>
      prev.current.lines.length === 0
        ? prev
        : { current: blankCart(channel), held: [...prev.held, prev.current] },
    )
    setCartOpen(false)
    flash('พักบิลแล้ว')
  }

  function restoreHeld(i: number) {
    const restored = drafts.held[i]
    if (!restored) return
    setChannel(restored.channel) // prices follow the bill's own channel
    setDrafts((prev) => {
      const held = [...prev.held]
      held.splice(i, 1)
      const keepCurrent = prev.current.lines.length > 0
      return { current: restored, held: keepCurrent ? [...held, prev.current] : held }
    })
  }

  function discardHeld(i: number) {
    setDrafts((prev) => ({ ...prev, held: prev.held.filter((_, idx) => idx !== i) }))
  }

  // ---- selling -----------------------------------------------------------

  function pickChannel(c: Channel) {
    setChannel(c)
    setDrafts((prev) => ({ ...prev, current: { ...prev.current, channel: c } }))
    setMsg('')
  }

  function tapType(item: MenuItem) {
    if (item.sold_out) return // long-press toggles it back on
    setTypeId(item.id)
    setMsg('')
  }

  /** Group mode straight from the fields (no owner-set "mode" column). */
  function tapOption(g: GroupWithOptions, opt: MenuOption) {
    if (opt.sold_out || !type) return
    const single = g.group.max_select === 1
    if (picks.includes(opt.id)) {
      // required pick-one: a required choice can never be un-tapped, only switched
      if (single && g.group.required) return
      setPicks(picks.filter((x) => x !== opt.id))
      return
    }
    if (single) {
      setPicks([...picks.filter((id) => !g.options.some((o) => o.id === id)), opt.id])
      return
    }
    const inGroup = picks.filter((id) => g.options.some((o) => o.id === id)).length
    const max = g.group.max_select
    if (max !== null && inGroup >= max) {
      setMsg(`"${g.group.name}" เลือกได้สูงสุด ${max} อย่าง`)
      return
    }
    setMsg('')
    setPicks([...picks, opt.id])
  }

  /** QUICK type: one tap on a choice goes straight into the cart. */
  function tapQuickOption(item: MenuItem, opt: MenuOption) {
    if (opt.sold_out || !menu) return
    const r = priceLine(menu, item, activeChannel, [opt.id])
    if (!r.ok) {
      setMsg(r.error)
      return
    }
    if (!pushLine(item, [opt.id])) return
    flash(`+1 ${opt.name}`)
  }

  function addFromBuilder() {
    if (!type || !menu || busy) return
    if (missingGroups.length > 0) {
      setMsg(`ยังไม่ได้เลือก: ${missingGroups.join(', ')}`)
      return
    }
    if (!priced || !priced.ok) {
      setMsg(priced && !priced.ok ? priced.error : 'ยังเลือกไม่ครบ')
      return
    }
    const name =
      priced.options.length === 1 && isQuickType(menu, type)
        ? priced.options[0].name
        : [type.name, ...priced.options.map((o) => o.name)].join(' ').trim()
    if (!pushLine(type, picks)) return
    setPicks([]) // the next plate of this type starts clean
    flash(`+1 ${name}`)
  }

  // ---- sold-out (long press) --------------------------------------------

  async function toggleItemSoldOut(item: MenuItem) {
    const res = await run(() =>
      api<MenuItem>(
        'POST',
        `/api/menu/items/${encodeURIComponent(item.id)}/sold-out`,
        { sold_out: !item.sold_out },
        'both',
      ),
    )
    if (res) {
      setMenu((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((i) =>
                i.id === res.id ? { ...i, sold_out: res.sold_out } : i,
              ),
            }
          : prev,
      )
      flash(res.sold_out ? `ปิดขาย "${item.name}" แล้ว` : `เปิดขาย "${item.name}" แล้ว`)
    }
  }

  async function toggleOptionSoldOut(opt: MenuOption) {
    const res = await run(() =>
      api<MenuOption>(
        'POST',
        `/api/menu/options/${encodeURIComponent(opt.id)}/sold-out`,
        { sold_out: !opt.sold_out },
        'both',
      ),
    )
    if (res) {
      setMenu((prev) =>
        prev
          ? {
              ...prev,
              options: prev.options.map((o) =>
                o.id === res.id ? { ...o, sold_out: res.sold_out } : o,
              ),
            }
          : prev,
      )
      flash(res.sold_out ? `ปิด "${opt.name}" แล้ว` : `เปิด "${opt.name}" แล้ว`)
    }
  }

  // ---- submit / add-to / queue actions -----------------------------------

  function lineBodies() {
    return cart.lines.map((l) => ({
      id: l.id,
      menu_item_id: l.menu_item_id,
      option_ids: l.option_ids,
      quantity: l.quantity,
      note: null,
    }))
  }

  /** Client-side validation of every line; first Thai error or null. */
  function firstLineError(): string | null {
    if (!menu) return 'ยังโหลดเมนูไม่สำเร็จ'
    for (const l of cart.lines) {
      const item = menu.items.find((i) => i.id === l.menu_item_id)
      if (!item) return 'มีรายการในตะกร้าที่ไม่พบในเมนูแล้ว — ลบรายการนั้นก่อน'
      const err = validateLine(menu, item, activeChannel, l.option_ids, l.quantity)
      if (err) return err
    }
    return null
  }

  /** `andPay` opens the pay sheet for the bill that was just keyed. */
  async function submitCart(andPay: boolean) {
    if (busy || cart.lines.length === 0) return
    if (addTo) return submitAddTo()
    const err = firstLineError()
    if (err) {
      setMsg(err)
      return
    }
    const order = await run(() =>
      api<Order>(
        'POST',
        '/api/orders',
        {
          id: cart.id, // idempotent retry keeps the SAME id
          order_type: activeChannel === 'counter' ? 'dine_in' : 'delivery',
          channel: activeChannel,
          table_no: null,
          note: null,
          items: lineBodies(),
        },
        'both',
      ),
    )
    if (!order) return // network/5xx: keep the cart, the retry is safe
    setDrafts((prev) => ({ ...prev, current: blankCart(channel) }))
    setPicks([])
    void loadOrders()
    if (andPay) {
      setPayResult(null)
      setPayFor(order)
    } else {
      flash(`ส่งครัวแล้ว · คิว #${order.queue_number}`)
    }
  }

  async function submitAddTo() {
    if (!addTo || busy || cart.lines.length === 0) return
    const err = firstLineError()
    if (err) {
      setMsg(err)
      return
    }
    const target = addTo
    const order = await run(() =>
      api<Order>(
        'POST',
        `/api/orders/${encodeURIComponent(target.id)}/items`,
        { items: lineBodies() },
        'both',
      ),
    )
    if (!order) return
    setAddTo(null)
    setDrafts((prev) => ({ ...prev, current: blankCart(channel) }))
    setPicks([])
    void loadOrders()
    setTab('queue')
    flash(`เพิ่มเข้าคิว #${order.queue_number} แล้ว · ${baht(order.total_amount)}`)
  }

  function startAddTo(o: Order) {
    // never mix the additions into another bill in progress
    setDrafts((prev) =>
      prev.current.lines.length > 0
        ? { current: blankCart(normalizeChannel(o.channel)), held: [...prev.held, prev.current] }
        : prev,
    )
    setAddTo(o)
    setPicks([])
    setMsg('')
    setTab('sell')
  }

  function exitAddTo() {
    setDrafts((prev) =>
      prev.current.lines.length > 0
        ? { current: blankCart(channel), held: [...prev.held, prev.current] }
        : prev,
    )
    setAddTo(null)
    setPicks([])
    setMsg('')
  }

  async function serveOrder(o: Order) {
    const r = await run(() =>
      api<Order>('POST', `/api/orders/${encodeURIComponent(o.id)}/serve`, undefined, 'both'),
    )
    if (!r) return
    void loadOrders()
    flash(`เสิร์ฟคิว #${r.queue_number} แล้ว`, {
      label: 'เลิกทำ',
      run: () => void unserveOrder(r.id, r.queue_number),
    })
  }

  async function unserveOrder(id: string, queueNumber: number) {
    clearToast()
    const r = await run(() =>
      api<Order>('POST', `/api/orders/${encodeURIComponent(id)}/unserve`, undefined, 'both'),
    )
    if (r) {
      void loadOrders()
      flash(`เลิกทำแล้ว · คิว #${queueNumber} กลับไปที่ครัว`)
    }
  }

  async function payOrder(
    o: Order,
    method: 'cash' | 'delivery_app',
    paymentId: string,
    cashReceived?: number,
  ) {
    const body: Record<string, unknown> = { payment_id: paymentId, method }
    if (method === 'cash') body['cash_received'] = cashReceived
    const r = await run(() =>
      api<PayResult>(
        'POST',
        `/api/orders/${encodeURIComponent(o.id)}/pay`,
        body,
        'both',
      ),
    )
    if (!r) return
    setPayResult(r) // the sheet flips to the change view
    void loadOrders()
  }

  async function cancelOrder(o: Order, reason: string) {
    const r = await run(() =>
      api<Order>(
        'POST',
        `/api/orders/${encodeURIComponent(o.id)}/cancel`,
        { reason },
        'both',
      ),
    )
    if (!r) return
    setCancelFor(null)
    void loadOrders()
    flash(`ยกเลิกคิว #${r.queue_number} แล้ว · ${r.cancel_reason ?? reason}`)
  }

  // ---- render ------------------------------------------------------------

  const pickedNames = groups.flatMap((g) =>
    g.options.filter((o) => picks.includes(o.id)).map((o) => o.name),
  )
  const addReady =
    !!type && missingGroups.length === 0 && !!priced && priced.ok && !type.sold_out
  const addLabel = !type
    ? ''
    : type.sold_out
      ? `เมนูนี้ของหมดอยู่`
      : missingGroups.length > 0
        ? `ยังไม่ได้เลือก: ${missingGroups.join(', ')}`
        : priced && priced.ok
          ? `ใส่ตะกร้า · ${baht(priced.unitPrice)}`
          : (priced && !priced.ok ? priced.error : 'ยังเลือกไม่ครบ')

  return (
    <div style={S.root}>
      {tab === 'sell' ? renderSell() : renderQueue()}

      {/* everything the staff must always see stays pinned to the bottom */}
      <div style={{ position: 'sticky', bottom: 0, marginTop: 'auto', zIndex: 20 }}>
        {msg ? (
          <p
            className="error"
            role="alert"
            style={{ margin: '0 16px', padding: '6px 0', fontSize: 14 }}
          >
            {msg}
          </p>
        ) : null}

        {tab === 'sell' && type && !quick ? (
          <div style={S.panel}>
            <div
              style={{
                fontSize: 14,
                color: MUTED,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {pickedNames.length > 0 ? `${type.name} ${pickedNames.join(' ')}` : 'ติ๊กตัวเลือกที่ลูกค้าสั่ง'}
            </div>
            <button
              type="button"
              disabled={!addReady || busy}
              style={{
                ...S.bigBtn(GREEN, '#FFFFFF', GREEN),
                background: addReady ? GREEN : '#9FA39A',
                borderColor: addReady ? GREEN : '#9FA39A',
              }}
              onClick={addFromBuilder}
            >
              {addLabel}
            </button>
          </div>
        ) : null}

        {tab === 'sell' && cart.lines.length > 0 ? (
          <div style={{ ...S.panel, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={() => setCartOpen(true)}
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: 'left',
                background: 'none',
                border: 0,
                padding: 0,
                color: INK,
                minHeight: 52,
              }}
            >
              <span style={{ display: 'block', fontSize: 13, color: GREEN, fontWeight: 600 }}>
                ตะกร้า {cartCount} รายการ · ดู/แก้
              </span>
              <span style={{ display: 'block', fontSize: 20, fontWeight: 700 }}>{baht(cartTotal)}</span>
            </button>
            {addTo ? (
              <button
                type="button"
                style={S.bigBtn(GREEN, '#FFFFFF', GREEN)}
                disabled={busy || cartHasError}
                onClick={() => void submitAddTo()}
              >
                เพิ่มเข้าคิว #{addTo.queue_number}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  style={S.bigBtn('#FFFFFF', GREEN, GREEN)}
                  disabled={busy || cartHasError}
                  onClick={() => void submitCart(false)}
                >
                  ส่งครัว
                </button>
                <button
                  type="button"
                  style={S.bigBtn(GREEN, '#FFFFFF', GREEN)}
                  disabled={busy || cartHasError}
                  onClick={() => void submitCart(true)}
                >
                  ส่ง + รับเงิน
                </button>
              </>
            )}
          </div>
        ) : null}

        <nav style={S.nav} aria-label="หน้าหลัก">
          <button
            type="button"
            style={S.navBtn(tab === 'sell')}
            aria-current={tab === 'sell' ? 'page' : undefined}
            onClick={() => setTab('sell')}
          >
            ขาย
          </button>
          <button
            type="button"
            style={S.navBtn(tab === 'queue')}
            aria-current={tab === 'queue' ? 'page' : undefined}
            onClick={() => setTab('queue')}
          >
            {queueOrders.length > 0 ? `คิว (${queueOrders.length})` : 'คิว'}
          </button>
        </nav>
      </div>

      {cartOpen ? (
        <CartSheet
          lines={cartLines}
          total={cartTotal}
          held={drafts.held}
          addToNo={addTo?.queue_number ?? null}
          onClose={() => setCartOpen(false)}
          onQty={setLineQty}
          onHold={holdCart}
          onRestore={restoreHeld}
          onDiscard={discardHeld}
          onClear={clearCart}
        />
      ) : null}

      {payFor ? (
        <PaySheet
          key={payFor.id}
          order={payFor}
          busy={busy}
          result={payResult}
          onClose={() => {
            setPayFor(null)
            setPayResult(null)
          }}
          onCash={(paymentId, satang) => void payOrder(payFor, 'cash', paymentId, satang)}
          onApp={(paymentId) => void payOrder(payFor, 'delivery_app', paymentId)}
        />
      ) : null}

      {cancelFor ? (
        <CancelSheet
          order={cancelFor}
          busy={busy}
          onClose={() => setCancelFor(null)}
          onConfirm={(reason) => void cancelOrder(cancelFor, reason)}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 84,
            zIndex: 60,
            width: 'min(358px, calc(100vw - 32px))',
            background: INK,
            color: '#FFFFFF',
            borderRadius: 14,
            padding: '10px 10px 10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 15,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
          }}
        >
          <span style={{ flex: 1 }}>{toast.text}</span>
          {toast.label && toast.run ? (
            <button
              type="button"
              style={{
                minHeight: 44,
                height: 44,
                padding: '0 12px',
                borderRadius: 10,
                border: 0,
                background: 'rgba(255,255,255,0.14)',
                color: '#9FE0C1',
                fontSize: 15,
                fontWeight: 700,
              }}
              onClick={() => {
                const action = toast.run
                clearToast()
                if (action) action()
              }}
            >
              {toast.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )

  // ---- SELL --------------------------------------------------------------

  function renderSell() {
    if (!menu) {
      return (
        <div style={S.body}>
          <div className="card center">
            {menuLoading ? <div className="spinner" aria-hidden="true" /> : null}
            <p className="muted">{menuErr || 'กำลังโหลดเมนู…'}</p>
            {menuErr ? (
              <button type="button" className="btn" onClick={() => void loadMenu()}>
                ลองใหม่
              </button>
            ) : null}
          </div>
        </div>
      )
    }

    return (
      <div style={S.body}>
        {addTo ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 4px',
              borderRadius: 12,
              background: '#FDEBD8',
              color: '#8A3D06',
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              สั่งเพิ่ม คิว #{addTo.queue_number} ·{' '}
              {CHANNEL_LABEL[addTo.channel] ?? addTo.channel}
            </span>
            <button type="button" style={S.linkBtn} disabled={busy} onClick={exitAddTo}>
              ยกเลิกสั่งเพิ่ม
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="ช่องทางขาย">
            {CHANNELS.map((c) => (
              <button
                type="button"
                key={c.id}
                style={S.channelBtn(channel === c.id)}
                onClick={() => pickChannel(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
          {items.map((it) => (
            <LongPressButton
              key={it.id}
              style={{ ...S.typeBtn(type?.id === it.id), opacity: it.sold_out ? 0.45 : 1 }}
              onLong={() => void toggleItemSoldOut(it)}
              onTap={() => tapType(it)}
            >
              {it.name}
              {it.sold_out ? (
                <span style={{ display: 'block', fontSize: 11, fontWeight: 600 }}>ของหมด</span>
              ) : null}
            </LongPressButton>
          ))}
        </div>
        {items.length === 0 ? (
          <p className="muted center-text">ยังไม่มีเมนู — รอเจ้าของร้านเพิ่มเมนูก่อน</p>
        ) : null}

        {type ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 0 8px' }}>
            {groups.map((g) => renderGroup(g))}
            {groups.length === 0 ? (
              <p className="muted small">ประเภทนี้ไม่มีตัวเลือก — กดปุ่มใส่ตะกร้าด้านล่างได้เลย</p>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  function groupHint(g: GroupWithOptions, picked: number): { text: string; color: string } {
    if (g.group.required && picked === 0) return { text: ' · ต้องเลือก', color: ORANGE }
    if (g.group.max_select === 1) {
      return g.group.required ? { text: '', color: MUTED } : { text: ' · ไม่เลือกก็ได้', color: MUTED }
    }
    return g.group.max_select === null
      ? { text: ' · เลือกได้หลายอย่าง', color: MUTED }
      : { text: ` · เลือกได้สูงสุด ${g.group.max_select} อย่าง`, color: MUTED }
  }

  function renderGroup(g: GroupWithOptions) {
    const picked = picks.filter((id) => g.options.some((o) => o.id === id)).length
    const hint = groupHint(g, picked)
    return (
      <div key={g.group.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>
          {g.group.name} <span style={{ fontWeight: 500, color: hint.color }}>{hint.text}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {g.options.map((o) => renderChoice(g, o))}
        </div>
        {g.options.length === 0 ? (
          <p className="muted small">ยังไม่มีตัวเลือกในหัวข้อนี้</p>
        ) : null}
      </div>
    )
  }

  function renderChoice(g: GroupWithOptions, o: MenuOption) {
    if (!type || !menu) return null
    const on = picks.includes(o.id)
    const inCart = quick ? cartQtyOf(type.id, o.id) : 0
    const label = quick
      ? `${o.name} ${baht(optionPrice(type, o))}${inCart > 0 ? `  ×${inCart}` : ''}`
      : `${o.name}${o.price_add > 0 ? ` +${fmtBaht(o.price_add)}` : ''}`
    return (
      <LongPressButton
        key={o.id}
        style={{ ...S.chip(on || inCart > 0), opacity: o.sold_out ? 0.45 : 1 }}
        onLong={() => void toggleOptionSoldOut(o)}
        onTap={() => (quick ? tapQuickOption(type, o) : tapOption(g, o))}
      >
        {label}
        {o.sold_out ? ' (หมด)' : ''}
      </LongPressButton>
    )
  }

  /** How many of this quick choice already sit in the cart ("×n" chip). */
  function cartQtyOf(itemId: string, optionId: string): number {
    return cart.lines
      .filter(
        (l) =>
          l.menu_item_id === itemId && l.option_ids.length === 1 && l.option_ids[0] === optionId,
      )
      .reduce((s, l) => s + l.quantity, 0)
  }

  /** Live price of one quick choice on the current channel (preview only). */
  function optionPrice(item: MenuItem, o: MenuOption): number {
    if (!menu) return 0
    const r = priceLine(menu, item, activeChannel, [o.id])
    return r.ok ? r.unitPrice : item.base_price
  }

  // ---- QUEUE -------------------------------------------------------------

  function renderQueue() {
    return (
      <div style={{ ...S.body, gap: 10 }}>
        <div style={{ fontSize: 14, color: MUTED }}>
          วันนี้: จ่ายแล้ว {paidToday.length} บิล · {baht(dayTotal)}
        </div>
        {ordersErr ? (
          <p className="error" role="alert">
            {ordersErr}
          </p>
        ) : null}
        {queueOrders.length === 0 && !ordersErr ? (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: MUTED, fontSize: 15 }}>
            ยังไม่มีคิว — อัปเดตอัตโนมัติทุก 10 วินาที
          </div>
        ) : null}
        {queueOrders.map((o) => renderOrder(o))}
      </div>
    )
  }

  function statusPill(o: Order): { label: string; style: CSSProperties } {
    if (o.served_at === null && o.status !== 'paid') {
      return { label: 'กำลังทำ', style: S.pill('#FDEBD8', '#8A3D06') }
    }
    if (o.served_at === null) {
      return { label: 'จ่ายแล้ว · รอเสิร์ฟ', style: S.pill('#E3F1EA', '#0F4D35') }
    }
    return { label: 'เสิร์ฟแล้ว · รอจ่าย', style: S.pill('#E6ECF7', '#1D3F7A') }
  }

  function renderOrder(o: Order) {
    const pill = statusPill(o)
    const paid = o.status === 'paid'
    return (
      <div
        key={o.id}
        style={{
          background: '#FFFFFF',
          borderRadius: 16,
          border: `1px solid ${LINE}`,
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}>#{o.queue_number}</span>
          <span style={{ fontSize: 14, color: MUTED, flex: 1, minWidth: 0 }}>
            {CHANNEL_LABEL[o.channel] ?? o.channel}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 12,
              whiteSpace: 'nowrap',
              ...pill.style,
            }}
          >
            {pill.label}
          </span>
        </div>

        {o.items.map((it) => {
          const names = it.options.map((x) => x.name)
          // a quick line is already named by its pick — don't print it twice
          const opts =
            it.options.length === 1 && it.options[0].name === it.item_name
              ? ''
              : names.join(' ')
          return (
            <div key={it.id} style={{ fontSize: 15, lineHeight: 1.4 }}>
              {it.quantity}× {it.item_name}
              {opts ? ` ${opts}` : ''}
              {it.note ? <span className="muted"> ({it.note})</span> : null}
            </div>
          )
        })}

        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontSize: 18, fontWeight: 700, flex: 1, minWidth: 60 }}>
            {baht(o.total_amount)}
          </span>
          {!paid ? (
            <button
              type="button"
              style={{ ...S.cardBtn('none', RED, 'transparent'), background: 'none' }}
              disabled={busy}
              onClick={() => setCancelFor(o)}
            >
              ยกเลิก
            </button>
          ) : null}
          {!paid ? (
            <button
              type="button"
              style={S.cardBtn('#FFFFFF', GREEN, GREEN)}
              disabled={busy}
              onClick={() => startAddTo(o)}
            >
              สั่งเพิ่ม
            </button>
          ) : null}
          {o.served_at === null ? (
            <button
              type="button"
              style={S.cardBtn('#FFFFFF', GREEN, GREEN)}
              disabled={busy}
              onClick={() => void serveOrder(o)}
            >
              เสิร์ฟแล้ว
            </button>
          ) : null}
          {!paid ? (
            <button
              type="button"
              style={S.cardBtn(GREEN, '#FFFFFF', GREEN)}
              disabled={busy}
              onClick={() => {
                setPayResult(null)
                setPayFor(o)
              }}
            >
              รับเงิน
            </button>
          ) : null}
        </div>
      </div>
    )
  }
}

// ---------------------------------------------------------------------------
// Cart sheet (ดู/แก้ + พักบิล + ล้างทั้งหมด)
// ---------------------------------------------------------------------------

function CartSheet({
  lines,
  total,
  held,
  addToNo,
  onClose,
  onQty,
  onHold,
  onRestore,
  onDiscard,
  onClear,
}: {
  lines: PricedCartLine[]
  total: number
  held: Cart[]
  addToNo: number | null
  onClose: () => void
  onQty: (id: string, delta: number) => void
  onHold: () => void
  onRestore: (i: number) => void
  onDiscard: (i: number) => void
  onClear: () => void
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="ตะกร้า"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>
            ตะกร้า{addToNo ? ` · เพิ่มเข้าคิว #${addToNo}` : ''}
          </h2>
          <button type="button" style={S.linkBtn} disabled={lines.length === 0} onClick={onClear}>
            ล้างทั้งหมด
          </button>
        </div>

        {lines.map((c) => (
          <div
            key={c.line.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 0',
              borderBottom: '1px solid #EEEDE8',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</div>
              {c.optionsText ? (
                <div className="muted small">{c.optionsText}</div>
              ) : null}
              {c.error ? <div className="error small">{c.error}</div> : null}
            </div>
            <button
              type="button"
              aria-label="ลดจำนวน"
              style={S.cardBtn('#FFFFFF', INK, BORDER)}
              onClick={() => onQty(c.line.id, -1)}
            >
              −
            </button>
            <span style={{ width: 22, textAlign: 'center', fontSize: 16, fontWeight: 700 }}>
              {c.line.quantity}
            </span>
            <button
              type="button"
              aria-label="เพิ่มจำนวน"
              style={S.cardBtn('#FFFFFF', INK, BORDER)}
              disabled={c.line.quantity >= 99}
              onClick={() => onQty(c.line.id, 1)}
            >
              +
            </button>
            <span style={{ width: 58, textAlign: 'right', fontSize: 15, fontWeight: 600 }}>
              {c.total !== null ? baht(c.total) : '—'}
            </span>
          </div>
        ))}

        {held.length > 0 ? (
          <div className="chips" aria-label="บิลที่พักไว้">
            {held.map((h, i) => (
              <span className="chip-group" key={h.id}>
                <button type="button" className="chip" onClick={() => onRestore(i)}>
                  พัก {i + 1} ({h.lines.reduce((s, l) => s + l.quantity, 0)})
                </button>
                <button
                  type="button"
                  className="chip chip-x"
                  aria-label={`ทิ้งบิลพักที่ ${i + 1}`}
                  onClick={() => onDiscard(i)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {lines.length > 0 && addToNo === null ? (
          <button type="button" className="btn ghost" onClick={onHold}>
            พักบิล (เก็บไว้ก่อน กลับมาแก้ต่อได้)
          </button>
        ) : null}
        <button
          type="button"
          style={S.bigBtn(GREEN, '#FFFFFF', GREEN)}
          disabled={lines.length === 0}
          onClick={onClose}
        >
          เสร็จ · {baht(total)}
        </button>
        <p className="muted small center-text">
          ราคานี้เป็นยอดคำนวณหน้าจอ — ยอดจริงตามที่ระบบคิดหลังส่งครัว
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pay sheet: one tap closes a cash bill; delivery is settled in the app
// ---------------------------------------------------------------------------

function PaySheet({
  order,
  busy,
  result,
  onClose,
  onCash,
  onApp,
}: {
  order: Order
  busy: boolean
  result: PayResult | null
  onClose: () => void
  onCash: (paymentId: string, cashSatang: number) => void
  onApp: (paymentId: string) => void
}) {
  // one payment id per sheet open — a retry after a network error reuses it
  const [paymentId] = useState(() => crypto.randomUUID())
  const [other, setOther] = useState('')
  const total = order.total_amount
  const counter = order.channel === 'counter'
  const otherSat = bahtToSatang(other)

  const cashButtons = useMemo(
    () => [total, ...BANKNOTES.map((v) => v * 100).filter((v) => v > total)].slice(0, 4),
    [total],
  )

  if (result) {
    const cash = result.payment.method === 'cash'
    const change = result.payment.cash_change ?? 0
    const doneBig = cash && change > 0 ? baht(change) : baht(result.payment.amount)
    return (
      <div className="sheet-backdrop">
        <div className="sheet" role="dialog" aria-label="รับเงินเรียบร้อย">
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '10px 0 4px',
            }}
          >
            <span style={{ fontSize: 16, color: MUTED }}>
              {cash && change > 0 ? 'ทอนเงิน' : 'รับเงินแล้ว'}
            </span>
            <span style={{ fontSize: 56, fontWeight: 700, color: GREEN, lineHeight: 1.1 }}>
              {doneBig}
            </span>
            <span style={{ fontSize: 14, color: MUTED }}>
              คิว #{result.order.queue_number} ·{' '}
              {cash
                ? `รับ ${baht(result.payment.cash_received ?? 0)}`
                : `${CHANNEL_LABEL[result.order.channel] ?? result.order.channel}`}
              {result.order.served_at === null ? ' · รอเสิร์ฟ' : ''}
            </span>
            <button
              type="button"
              style={{ ...S.bigBtn(GREEN, '#FFFFFF', GREEN), marginTop: 10 }}
              onClick={onClose}
            >
              ขายต่อ
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="รับเงิน"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 600, flex: 1 }}>รับเงิน คิว #{order.queue_number}</span>
          <span style={{ fontSize: 32, fontWeight: 700 }}>{baht(total)}</span>
        </div>

        {counter ? (
          <>
            <div style={{ fontSize: 14, color: MUTED }}>ลูกค้าให้เงินมา — กดครั้งเดียวจบ</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {cashButtons.map((v, i) => (
                <button
                  type="button"
                  key={v}
                  disabled={busy}
                  style={{
                    height: 62,
                    minHeight: 62,
                    borderRadius: 14,
                    fontSize: 20,
                    fontWeight: 700,
                    padding: 0,
                    border: `1.5px solid ${GREEN}`,
                    background: i === 0 ? GREEN : '#FFFFFF',
                    color: i === 0 ? '#FFFFFF' : GREEN,
                  }}
                  onClick={() => onCash(paymentId, v)}
                >
                  {i === 0 ? `พอดี ${baht(v)}` : baht(v)}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 14, color: MUTED, fontWeight: 600, flex: 'none' }}>
                จำนวนอื่น ฿
              </span>
              <input
                value={other}
                inputMode="decimal"
                placeholder="0"
                aria-label="รับเงินจำนวนอื่น (บาท)"
                style={S.field}
                onChange={(e) => setOther(e.target.value)}
              />
              <button
                type="button"
                style={S.bigBtn(GREEN, '#FFFFFF', GREEN)}
                disabled={busy || otherSat === null || otherSat < total}
                onClick={() => {
                  if (otherSat !== null) onCash(paymentId, otherSat)
                }}
              >
                รับเงิน
              </button>
            </div>
            {otherSat !== null && otherSat < total ? (
              <p className="error small">ยังขาดอีก {fmtBaht(total - otherSat)} บาท</p>
            ) : null}
            {otherSat !== null && otherSat >= total ? (
              <p className="muted small">เงินทอน {baht(otherSat - total)}</p>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            style={{ ...S.bigBtn(GREEN, '#FFFFFF', GREEN), height: 60, minHeight: 60, fontSize: 17 }}
            disabled={busy}
            onClick={() => onApp(paymentId)}
          >
            ลูกค้าจ่ายผ่าน {CHANNEL_LABEL[order.channel] ?? order.channel} แล้ว
          </button>
        )}

        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
          ปิด
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cancel sheet: one tap per reason, อื่น ๆ asks for the text
// ---------------------------------------------------------------------------

function CancelSheet({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: Order
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}) {
  const [other, setOther] = useState('')
  const [askOther, setAskOther] = useState(false)
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label="ยกเลิกออเดอร์"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>ยกเลิกคิว #{order.queue_number} — เหตุผล?</h2>
        {CANCEL_REASONS.map((r) => (
          <button
            type="button"
            key={r}
            disabled={busy}
            style={{
              height: 50,
              minHeight: 50,
              borderRadius: 14,
              border: '1.5px solid #E2C9C2',
              background: '#FFFFFF',
              color: RED,
              fontSize: 16,
              fontWeight: 600,
              padding: 0,
            }}
            onClick={() => onConfirm(r)}
          >
            {r}
          </button>
        ))}
        {askOther ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={other}
              maxLength={200}
              placeholder="ระบุเหตุผล"
              aria-label="เหตุผลอื่น ๆ"
              autoFocus
              style={S.field}
              onChange={(e) => setOther(e.target.value)}
            />
            <button
              type="button"
              style={S.bigBtn(RED, '#FFFFFF', RED)}
              disabled={busy || other.trim() === ''}
              onClick={() => onConfirm(other.trim())}
            >
              ยืนยัน
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            style={{
              height: 50,
              minHeight: 50,
              borderRadius: 14,
              border: '1.5px solid #E2C9C2',
              background: '#FFFFFF',
              color: RED,
              fontSize: 16,
              fontWeight: 600,
              padding: 0,
            }}
            onClick={() => setAskOther(true)}
          >
            อื่น ๆ
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
          ไม่ยกเลิก
        </button>
      </div>
    </div>
  )
}
