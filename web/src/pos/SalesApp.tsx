import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, errorCode, friendlyError } from '../api'
import type { MenuData, MenuItem, MenuOption } from '../api'
import {
  applicableGroups,
  bahtToSatang,
  fmtBaht,
  priceLine,
  previewUnitPrice,
  validateLine,
} from './pricing'
import type { Channel, GroupWithOptions } from './pricing'

// ---------------------------------------------------------------------------
// Shared shapes / labels
// ---------------------------------------------------------------------------

type OrderType = 'dine_in' | 'take_away' | 'delivery'

const ORDER_TYPES: Array<{ id: OrderType; label: string }> = [
  { id: 'dine_in', label: 'กินที่ร้าน' },
  { id: 'take_away', label: 'กลับบ้าน' },
  { id: 'delivery', label: 'เดลิเวอรี่' },
]

const DELIVERY_CHANNELS: Array<{ id: Channel; label: string }> = [
  { id: 'grab', label: 'Grab' },
  { id: 'lineman', label: 'LINE MAN' },
  { id: 'foodpanda', label: 'Foodpanda' },
]

const TYPE_LABELS: Record<string, string> = {
  dine_in: 'กินที่ร้าน',
  take_away: 'กลับบ้าน',
  delivery: 'เดลิเวอรี่',
}

const CHANNEL_LABELS: Record<string, string> = {
  counter: 'หน้าร้าน',
  grab: 'Grab',
  lineman: 'LINE MAN',
  foodpanda: 'Foodpanda',
}

const NOTE_CHIPS = ['ไม่เผ็ด', 'แยกน้ำแกง', 'ห่อกลับ']
const CANCEL_REASONS = ['ลูกค้ายกเลิก', 'คีย์ผิด', 'ของหมด']
const BANKNOTES = [20, 50, 100, 500, 1000]

interface OrderItemJson {
  id: string
  menu_item_id: string
  item_name: string
  options: Array<{ id: string; name: string; price_add: number }>
  quantity: number
  note: string | null
  unit_price: number
  discount_amount: number
  line_total: number
}

interface Order {
  id: string
  queue_number: number
  order_type: string
  channel: string
  table_no: string | null
  note: string | null
  status: 'preparing' | 'served' | 'paid' | 'cancelled'
  total_amount: number
  discount_amount: number
  created_at: number
  paid_at: number | null
  cancel_reason: string | null
  items: OrderItemJson[]
}

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

// ---------------------------------------------------------------------------
// Cart / held-bill drafts (persisted in localStorage 'pos.drafts', 3.13)
// ---------------------------------------------------------------------------

interface CartLine {
  id: string // client UUID, made ONCE per line; retries reuse it (3.70)
  menu_item_id: string
  option_ids: string[]
  quantity: number
  note: string
}

interface Cart {
  id: string // order UUID, made ONCE per cart; retries reuse it (3.70)
  order_type: OrderType
  channel: Channel | '' // '' = delivery channel not chosen yet
  table_no: string
  note: string
  lines: CartLine[]
}

interface Drafts {
  current: Cart
  held: Cart[]
}

const DRAFTS_KEY = 'pos.drafts'
/** One bill holds at most 50 lines (server bound); bigger orders go as two bills. */
const MAX_LINES = 50
const ORDERS_POLL_MS = 10_000

function isDeliveryChannel(ch: string): ch is Channel {
  return ch === 'grab' || ch === 'lineman' || ch === 'foodpanda'
}

function sanitizeChannel(orderType: OrderType, ch: string): Channel | '' {
  if (orderType === 'delivery') return isDeliveryChannel(ch) ? ch : ''
  return 'counter'
}

function blankCart(prev?: Cart): Cart {
  const orderType: OrderType = prev?.order_type ?? 'dine_in'
  return {
    id: crypto.randomUUID(),
    order_type: orderType,
    channel: prev ? sanitizeChannel(orderType, prev.channel) : 'counter',
    table_no: '',
    note: '',
    lines: [],
  }
}

function sanitizeCart(raw: unknown): Cart {
  const c = raw as Cart | null | undefined
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Array.isArray(c.lines)) {
    return blankCart()
  }
  const orderType: OrderType =
    c.order_type === 'take_away' || c.order_type === 'delivery' ? c.order_type : 'dine_in'
  return {
    id: c.id,
    order_type: orderType,
    channel: sanitizeChannel(orderType, typeof c.channel === 'string' ? c.channel : ''),
    table_no: typeof c.table_no === 'string' ? c.table_no : '',
    note: typeof c.note === 'string' ? c.note : '',
    lines: (c.lines as unknown[])
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
        note: typeof l.note === 'string' ? l.note : '',
      })),
  }
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
  return { current: blankCart(), held: [] }
}

function samePicks(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x) => b.includes(x))
}

function ageText(createdAt: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - createdAt) / 60_000))
  if (mins === 0) return 'เพิ่งสั่ง'
  if (mins < 60) return `${mins} นาที`
  return `${Math.floor(mins / 60)} ชม. ${mins % 60} น.`
}

interface CalloutData {
  title: string
  queue?: number
  lines?: string[]
}

// ---------------------------------------------------------------------------
// SalesApp
// ---------------------------------------------------------------------------

export default function SalesApp({
  onSessionExpired,
  onRevoked,
}: {
  onSessionExpired: () => void
  onRevoked: () => void
}) {
  const [tab, setTab] = useState<'order' | 'queue'>('order')
  const [menu, setMenu] = useState<MenuData | null>(null)
  const [menuErr, setMenuErr] = useState('')
  const [menuLoading, setMenuLoading] = useState(true)
  const [orders, setOrders] = useState<Order[]>([])
  const [ordersErr, setOrdersErr] = useState('')
  const [drafts, setDrafts] = useState<Drafts>(loadDrafts)
  const [catPick, setCatPick] = useState<string | null>(null)
  const [soldOutEdit, setSoldOutEdit] = useState(false)
  const [sheetItem, setSheetItem] = useState<MenuItem | null>(null)
  const [payFor, setPayFor] = useState<Order | null>(null)
  const [cancelFor, setCancelFor] = useState<Order | null>(null)
  const [addTo, setAddTo] = useState<Order | null>(null)
  const [callout, setCallout] = useState<CalloutData | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [showClosed, setShowClosed] = useState(false)
  const [now, setNow] = useState(Date.now())

  // keep the latest callbacks without re-creating the poller below
  const expiredRef = useRef(onSessionExpired)
  const revokedRef = useRef(onRevoked)
  useEffect(() => {
    expiredRef.current = onSessionExpired
    revokedRef.current = onRevoked
  })

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

  // 3.19: poll the queue every 10 s while visible + on (tab) focus + after actions
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

  // keeps "x นาทีที่แล้ว" fresh without re-fetching
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // persist the cart + held bills so a reload/lock never loses them (3.13)
  useEffect(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    } catch {
      // storage full/blocked — selling continues, just without persistence
    }
  }, [drafts])

  /**
   * Runs one mutation: busy flag, friendly Thai error, 401 session/revoked
   * hand-off, 409 -> reload the queue. Network/5xx NEVER clears the cart and
   * NEVER logs out (the cart ids make the retry idempotent).
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
      // the bill's state changed under us (or it vanished) -> refresh the queue
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) void loadOrders()
      return null
    } finally {
      setBusy(false)
    }
  }

  // ---- derived data ------------------------------------------------------

  const cart = drafts.current
  const channel: Channel = useMemo(() => {
    if (addTo) return addTo.channel as Channel
    return isDeliveryChannel(cart.channel) ? cart.channel : 'counter'
  }, [addTo, cart.channel])

  const items = useMemo(
    () =>
      menu
        ? [...menu.items].sort(
            (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'th'),
          )
        : [],
    [menu],
  )

  const categories = useMemo(() => {
    const cs: string[] = []
    for (const it of items) if (!cs.includes(it.category)) cs.push(it.category)
    return cs
  }, [items])

  const activeCat =
    catPick !== null && categories.includes(catPick) ? catPick : (categories[0] ?? '')
  const catItems = activeCat === '' ? [] : items.filter((i) => i.category === activeCat)
  const deliveryBlocked = !addTo && cart.order_type === 'delivery' && cart.channel === ''

  const openOrders = orders.filter((o) => o.status === 'preparing' || o.status === 'served')
  const closedOrders = orders.filter((o) => o.status === 'paid' || o.status === 'cancelled')

  interface PricedCartLine {
    line: CartLine
    name: string
    optionsText: string
    note: string
    error: string | null
    total: number | null
  }

  const cartLines: PricedCartLine[] = useMemo(() => {
    if (!menu) {
      return cart.lines.map((l) => ({
        line: l,
        name: '…',
        optionsText: '',
        note: l.note,
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
          note: l.note,
          error: 'ไม่พบเมนูนี้แล้ว — ลบรายการนี้ออกก่อนส่ง',
          total: null,
        }
      }
      const r = priceLine(menu, item, channel, l.option_ids)
      return {
        line: l,
        name: item.name,
        optionsText,
        note: l.note,
        error: r.ok ? null : r.error,
        total: r.ok ? r.unitPrice * l.quantity : null,
      }
    })
  }, [cart.lines, menu, channel])

  const cartTotal = cartLines.reduce((s, c) => s + (c.total ?? 0), 0)
  const cartHasError = cartLines.some((c) => c.error !== null)

  // ---- cart editing ------------------------------------------------------

  function patchCart(patch: Partial<Cart>) {
    setDrafts((prev) => ({ ...prev, current: { ...prev.current, ...patch } }))
  }

  function setOrderType(t: OrderType) {
    setDrafts((prev) => ({
      ...prev,
      current: {
        ...prev.current,
        order_type: t,
        channel: sanitizeChannel(t, prev.current.channel),
        table_no: t === 'dine_in' ? prev.current.table_no : '',
      },
    }))
  }

  function addLine(item: MenuItem, optionIds: string[], quantity: number, note: string) {
    const lines = [...cart.lines]
    const idx = lines.findIndex(
      (l) => l.menu_item_id === item.id && samePicks(l.option_ids, optionIds) && l.note === note,
    )
    if (idx >= 0) {
      lines[idx] = { ...lines[idx], quantity: Math.min(99, lines[idx].quantity + quantity) }
    } else if (lines.length >= MAX_LINES) {
      setMsg(`บิลเดียวได้สูงสุด ${MAX_LINES} รายการ — ส่งครัวก่อนแล้วเปิดบิลใหม่`)
      return
    } else {
      lines.push({
        id: crypto.randomUUID(),
        menu_item_id: item.id,
        option_ids: optionIds,
        quantity,
        note,
      })
    }
    setMsg('')
    patchCart({ lines })
  }

  function setLineQty(id: string, delta: number) {
    setDrafts((prev) => {
      const lines = prev.current.lines
        .map((l) => (l.id === id ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity >= 1)
      return { ...prev, current: { ...prev.current, lines } }
    })
  }

  function removeLine(id: string) {
    setDrafts((prev) => ({
      ...prev,
      current: { ...prev.current, lines: prev.current.lines.filter((l) => l.id !== id) },
    }))
  }

  function holdCart() {
    setDrafts((prev) =>
      prev.current.lines.length === 0
        ? prev
        : { current: blankCart(prev.current), held: [...prev.held, prev.current] },
    )
  }

  function restoreHeld(i: number) {
    setDrafts((prev) => {
      const held = [...prev.held]
      const restored = held.splice(i, 1)[0]
      if (!restored) return prev
      const keepCurrent = prev.current.lines.length > 0
      return { current: restored, held: keepCurrent ? [...held, prev.current] : held }
    })
  }

  function discardHeld(i: number) {
    setDrafts((prev) => ({ ...prev, held: prev.held.filter((_, idx) => idx !== i) }))
  }

  // ---- item taps / sold-out (3.5) ----------------------------------------

  function tapItem(item: MenuItem) {
    if (!menu) return
    if (deliveryBlocked) {
      setMsg('เลือกแอปเดลิเวอรี่ (Grab / LINE MAN / Foodpanda) ก่อนสั่ง')
      return
    }
    if (!soldOutEdit && item.sold_out) return
    const groups = applicableGroups(menu, item)
    if (groups.length === 0) {
      addLine(item, [], 1, '') // 1 tap = 1 plate (3.2)
      return
    }
    setSheetItem(item)
  }

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
          ? { ...prev, items: prev.items.map((i) => (i.id === res.id ? { ...i, sold_out: res.sold_out } : i)) }
          : prev,
      )
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
          ? { ...prev, options: prev.options.map((o) => (o.id === res.id ? { ...o, sold_out: res.sold_out } : o)) }
          : prev,
      )
    }
  }

  // ---- submit / add-to-order / queue actions ------------------------------

  function lineBodies() {
    return cart.lines.map((l) => ({
      id: l.id,
      menu_item_id: l.menu_item_id,
      option_ids: l.option_ids,
      quantity: l.quantity,
      note: l.note.trim() === '' ? undefined : l.note.trim(),
    }))
  }

  /** Client-side validation of every line; returns the first Thai error or null. */
  function firstLineError(): string | null {
    if (!menu) return 'ยังโหลดเมนูไม่สำเร็จ'
    for (const l of cart.lines) {
      const item = menu.items.find((i) => i.id === l.menu_item_id)
      if (!item) return 'มีรายการในตะกร้าที่ไม่พบในเมนูแล้ว — ลบรายการนั้นก่อน'
      const err = validateLine(menu, item, channel, l.option_ids, l.quantity)
      if (err) return err
    }
    return null
  }

  async function submitCart() {
    if (busy || cart.lines.length === 0) return
    if (addTo) return submitAddTo()
    if (deliveryBlocked) {
      setMsg('เลือกแอปเดลิเวอรี่ (Grab / LINE MAN / Foodpanda) ก่อนส่งครัว')
      return
    }
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
          id: cart.id, // idempotent retry keeps the SAME id (3.70)
          order_type: cart.order_type,
          channel,
          table_no: cart.table_no.trim() === '' ? undefined : cart.table_no.trim(),
          note: cart.note.trim() === '' ? undefined : cart.note.trim(),
          items: lineBodies(),
        },
        'both',
      ),
    )
    if (!order) return // network/5xx: keep the cart, retry is safe
    setDrafts((prev) => ({ current: blankCart(prev.current), held: prev.held }))
    setTab('queue')
    setCallout({
      title: 'ส่งครัวแล้ว',
      queue: order.queue_number,
      lines: [`ยอดตามบิล ${fmtBaht(order.total_amount)} บาท`],
    })
    void loadOrders()
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
    setDrafts((prev) => ({ current: blankCart(prev.current), held: prev.held }))
    setTab('queue')
    setCallout({
      title: `เพิ่มรายการ คิว #${order.queue_number} แล้ว`,
      lines: [`ยอดรวมใหม่ ${fmtBaht(order.total_amount)} บาท`],
    })
    void loadOrders()
  }

  function startAddTo(o: Order) {
    setAddTo(o)
    setTab('order')
    setMsg('')
    // never mix the additions into another table's bill in progress
    setDrafts((prev) =>
      prev.current.lines.length > 0
        ? { current: blankCart(prev.current), held: [...prev.held, prev.current] }
        : prev,
    )
  }

  function exitAddTo() {
    setAddTo(null)
    setDrafts((prev) =>
      prev.current.lines.length > 0
        ? { current: blankCart(prev.current), held: [...prev.held, prev.current] }
        : prev,
    )
  }

  async function serveOrder(o: Order) {
    const r = await run(() =>
      api<Order>('POST', `/api/orders/${encodeURIComponent(o.id)}/serve`, undefined, 'both'),
    )
    if (r) {
      setCallout({ title: 'เสร็จแล้ว เรียกคิว', queue: r.queue_number }) // 3.14
      void loadOrders()
    }
  }

  async function payCash(o: Order, paymentId: string, cashSatang: number) {
    const r = await run(() =>
      api<PayResult>(
        'POST',
        `/api/orders/${encodeURIComponent(o.id)}/pay`,
        { payment_id: paymentId, method: 'cash', cash_received: cashSatang },
        'both',
      ),
    )
    if (r) {
      setPayFor(null)
      setCallout({
        title: 'จ่ายแล้ว',
        queue: r.order.queue_number,
        lines: [
          `รับเงิน ${fmtBaht(r.payment.cash_received ?? 0)} บาท`,
          `เงินทอน ${fmtBaht(r.payment.cash_change ?? 0)} บาท`,
        ],
      })
      void loadOrders()
    }
  }

  async function payDeliveryApp(o: Order, paymentId: string) {
    const r = await run(() =>
      api<PayResult>(
        'POST',
        `/api/orders/${encodeURIComponent(o.id)}/pay`,
        { payment_id: paymentId, method: 'delivery_app' },
        'both',
      ),
    )
    if (r) {
      setPayFor(null)
      setCallout({
        title: 'รับเงินผ่านแอปแล้ว',
        queue: r.order.queue_number,
        lines: [`ยอด ${fmtBaht(r.payment.amount)} บาท`],
      })
      void loadOrders()
    }
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
    if (r) {
      setCancelFor(null)
      setCallout({
        title: `ยกเลิกคิว #${r.queue_number} แล้ว`,
        lines: [`เหตุผล: ${r.cancel_reason ?? reason}`],
      })
      void loadOrders()
    }
  }

  const closeCallout = useCallback(() => setCallout(null), [])

  // ---- render -------------------------------------------------------------

  return (
    <>
      <div className="pos-tabs" role="tablist" aria-label="หน้าหลัก">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'order'}
          className={`pos-tab${tab === 'order' ? ' on' : ''}`}
          onClick={() => setTab('order')}
        >
          รับออเดอร์
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'queue'}
          className={`pos-tab${tab === 'queue' ? ' on' : ''}`}
          onClick={() => setTab('queue')}
        >
          คิว ({openOrders.length})
        </button>
      </div>

      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}

      {tab === 'order' ? renderOrderTab() : renderQueueTab()}

      {sheetItem && menu ? (
        <OptionSheet
          key={sheetItem.id}
          item={sheetItem}
          menu={menu}
          channel={channel}
          editSoldOut={soldOutEdit}
          busy={busy}
          onToggleItemSoldOut={() => void toggleItemSoldOut(sheetItem)}
          onToggleOptionSoldOut={(o) => void toggleOptionSoldOut(o)}
          onClose={() => setSheetItem(null)}
          onConfirm={(optionIds, quantity, note) => {
            addLine(sheetItem, optionIds, quantity, note)
            setSheetItem(null)
          }}
        />
      ) : null}

      {payFor && payFor.channel === 'counter' ? (
        <CashSheet
          order={payFor}
          busy={busy}
          onClose={() => setPayFor(null)}
          onConfirm={(paymentId, satang) => void payCash(payFor, paymentId, satang)}
        />
      ) : null}
      {payFor && payFor.channel !== 'counter' ? (
        <DeliveryPaySheet
          order={payFor}
          busy={busy}
          onClose={() => setPayFor(null)}
          onConfirm={(paymentId) => void payDeliveryApp(payFor, paymentId)}
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

      {callout ? (
        <Callout title={callout.title} queue={callout.queue} lines={callout.lines} onClose={closeCallout} />
      ) : null}
    </>
  )

  function renderOrderTab() {
    if (!menu) {
      return (
        <div className="card center">
          {menuLoading ? <div className="spinner" aria-hidden="true" /> : null}
          <p className="muted">{menuErr || 'กำลังโหลดเมนู…'}</p>
          {menuErr ? (
            <button type="button" className="btn" onClick={() => void loadMenu()}>
              ลองใหม่
            </button>
          ) : null}
        </div>
      )
    }

    return (
      <>
        {addTo ? (
          <div className="card addto-banner">
            <div className="row">
              <strong className="grow">
                สั่งเพิ่ม คิว #{addTo.queue_number} ·{' '}
                {CHANNEL_LABELS[addTo.channel] ?? addTo.channel}
              </strong>
              <button type="button" className="btn ghost" onClick={exitAddTo}>
                เลิกสั่งเพิ่ม
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="seg" role="group" aria-label="ประเภทออเดอร์">
              {ORDER_TYPES.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={cart.order_type === t.id ? 'on' : ''}
                  onClick={() => setOrderType(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {cart.order_type === 'delivery' ? (
              <div className="seg" role="group" aria-label="แอปเดลิเวอรี่">
                {DELIVERY_CHANNELS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={cart.channel === c.id ? 'on' : ''}
                    onClick={() => patchCart({ channel: c.id })}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="row">
              {cart.order_type === 'dine_in' ? (
                <label className="grow">
                  โต๊ะ (ไม่ใส่ก็ได้)
                  <input
                    value={cart.table_no}
                    maxLength={20}
                    inputMode="text"
                    placeholder="เช่น 7"
                    onChange={(e) => patchCart({ table_no: e.target.value })}
                  />
                </label>
              ) : null}
              <label className="grow">
                หมายเหตุบิล (ไม่ใส่ก็ได้)
                <input
                  value={cart.note}
                  maxLength={200}
                  placeholder="เช่น ลูกค้ารอก่อน 15:00"
                  onChange={(e) => patchCart({ note: e.target.value })}
                />
              </label>
            </div>
          </>
        )}

        {categories.length === 0 ? (
          <p className="muted center-text">ยังไม่มีเมนู — รอเจ้าของร้านเพิ่มเมนูก่อน</p>
        ) : (
          <>
            <div className="chips" role="group" aria-label="หมวดเมนู">
              {categories.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`chip${activeCat === c ? ' on' : ''}`}
                  onClick={() => setCatPick(c)}
                >
                  {c}
                </button>
              ))}
            </div>

            <div className="row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={soldOutEdit}
                  onChange={(e) => setSoldOutEdit(e.target.checked)}
                />
                แก้ของหมด
              </label>
              <span className="muted small grow">
                {soldOutEdit ? 'กดค้างที่ปุ่มเมนู หรือกดปุ่มเล็กใต้ปุ่มเมนู เพื่อปิด/เปิดขาย' : ''}
              </span>
            </div>

            {deliveryBlocked ? (
              <p className="muted">เลือกแอปเดลิเวอรี่ก่อนจึงสั่งได้ (ราคาต่างกันตามช่องทาง)</p>
            ) : null}

            <div className="item-grid">
              {catItems.map((it) => (
                <ItemTile
                  key={it.id}
                  item={it}
                  price={previewUnitPrice(menu, it, channel)}
                  editMode={soldOutEdit}
                  blocked={deliveryBlocked}
                  busy={busy}
                  onTap={() => tapItem(it)}
                  onToggleSoldOut={() => void toggleItemSoldOut(it)}
                />
              ))}
            </div>
          </>
        )}

        {cartLines.length > 0 ? (
          <div className="card cart-lines">
            <h2>ตะกร้า ({cart.lines.length})</h2>
            {cartLines.map((c) => (
              <div className="cart-line" key={c.line.id}>
                <div className="grow">
                  <strong>{c.name}</strong>
                  {c.optionsText ? <p className="muted small">{c.optionsText}</p> : null}
                  {c.note ? <p className="muted small">หมายเหตุ: {c.note}</p> : null}
                  {c.error ? <p className="error small">{c.error}</p> : null}
                </div>
                <div className="qty-ctl">
                  <button
                    type="button"
                    aria-label="ลดจำนวน"
                    onClick={() => setLineQty(c.line.id, -1)}
                  >
                    −
                  </button>
                  <span>{c.line.quantity}</span>
                  <button
                    type="button"
                    aria-label="เพิ่มจำนวน"
                    disabled={c.line.quantity >= 99}
                    onClick={() => setLineQty(c.line.id, 1)}
                  >
                    +
                  </button>
                </div>
                <span className="line-total">
                  {c.total !== null ? `${fmtBaht(c.total)} บาท` : '—'}
                </span>
                <button type="button" className="btn ghost" onClick={() => removeLine(c.line.id)}>
                  ลบ
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {cart.lines.length > 0 || (!addTo && drafts.held.length > 0) ? (
          <div className="cart-dock">
            {!addTo && drafts.held.length > 0 ? (
              <div className="chips">
                {drafts.held.map((h, i) => (
                  <span className="chip-group" key={h.id}>
                    <button type="button" className="chip" onClick={() => restoreHeld(i)}>
                      พัก {i + 1} ({h.lines.length})
                    </button>
                    <button
                      type="button"
                      className="chip chip-x"
                      aria-label={`ทิ้งบิลพักที่ ${i + 1}`}
                      onClick={() => discardHeld(i)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="row">
              <strong className="grow total-big">รวม {fmtBaht(cartTotal)} บาท</strong>
              {!addTo ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy || cart.lines.length === 0}
                  onClick={holdCart}
                >
                  พักบิล
                </button>
              ) : null}
              <button
                type="button"
                className="btn primary"
                disabled={busy || cart.lines.length === 0 || cartHasError}
                onClick={() => void submitCart()}
              >
                {addTo ? `เพิ่มไปบิล #${addTo.queue_number}` : 'ส่งครัว'}
              </button>
            </div>
            <p className="muted small">ราคานี้เป็นยอดคำนวณหน้าจอ — ยอดจริงตามที่ระบบคิดหลังส่งครัว</p>
          </div>
        ) : null}
      </>
    )
  }

  function renderQueueTab() {
    return (
      <>
        {ordersErr ? <p className="error">{ordersErr}</p> : null}
        {openOrders.length === 0 && !ordersErr ? (
          <p className="muted center-text">ยังไม่มีออเดอร์ค้าง — อัปเดตอัตโนมัติทุก 10 วินาที</p>
        ) : null}
        {openOrders.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            now={now}
            busy={busy}
            onServe={() => void serveOrder(o)}
            onPay={() => setPayFor(o)}
            onAddItems={() => startAddTo(o)}
            onCancel={() => setCancelFor(o)}
          />
        ))}

        <button type="button" className="btn ghost" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? 'ซ่อนรายการที่ปิดแล้ว' : `วันนี้ปิดแล้ว (${closedOrders.length})`}
        </button>
        {showClosed ? (
          closedOrders.length === 0 ? (
            <p className="muted small">ยังไม่มีบิลที่ปิดวันนี้</p>
          ) : (
            <div className="card closed-list">
              {closedOrders.map((o) => (
                <div className="row closed-row" key={o.id}>
                  <strong>#{o.queue_number}</strong>
                  <span className="muted small grow">
                    {TYPE_LABELS[o.order_type] ?? o.order_type} ·{' '}
                    {CHANNEL_LABELS[o.channel] ?? o.channel}
                  </span>
                  <span>{fmtBaht(o.total_amount)} บาท</span>
                  {o.status === 'paid' ? (
                    <span className="badge approved">จ่ายแล้ว</span>
                  ) : (
                    <span className="badge revoked">
                      ยกเลิก{o.cancel_reason ? `: ${o.cancel_reason}` : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )
        ) : null}
      </>
    )
  }
}

// ---------------------------------------------------------------------------
// Item button (long-press = sold-out toggle, 3.5)
// ---------------------------------------------------------------------------

function ItemTile({
  item,
  price,
  editMode,
  blocked,
  busy,
  onTap,
  onToggleSoldOut,
}: {
  item: MenuItem
  price: number
  editMode: boolean
  blocked: boolean
  busy: boolean
  onTap: () => void
  onToggleSoldOut: () => void
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
      onToggleSoldOut()
    }, 550)
  }

  return (
    <div className="tile-wrap">
      <button
        type="button"
        className={`tile${item.sold_out ? ' soldout' : ''}`}
        disabled={busy || blocked || (!editMode && item.sold_out)}
        onPointerDown={down}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (fired.current) {
            fired.current = false
            return
          }
          onTap()
        }}
      >
        <span className="tile-name">{item.name}</span>
        <span className="tile-price">{fmtBaht(price)} บาท</span>
        {item.sold_out ? <span className="badge pending">ของหมด</span> : null}
      </button>
      {editMode ? (
        <button type="button" className="mini-btn" disabled={busy} onClick={onToggleSoldOut}>
          {item.sold_out ? 'เปิดขาย' : 'ปิดขาย (หมด)'}
        </button>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Option sheet (per-plate options, tier curries, note, live preview — 3.3/3.4/3.12)
// ---------------------------------------------------------------------------

function groupLabel(g: GroupWithOptions): string {
  return g.group.tier_pricing ? 'เลือกแกง (1-3 อย่าง)' : g.group.name
}

function OptionSheet({
  item,
  menu,
  channel,
  editSoldOut,
  busy,
  onToggleItemSoldOut,
  onToggleOptionSoldOut,
  onClose,
  onConfirm,
}: {
  item: MenuItem
  menu: MenuData
  channel: Channel
  editSoldOut: boolean
  busy: boolean
  onToggleItemSoldOut: () => void
  onToggleOptionSoldOut: (o: MenuOption) => void
  onClose: () => void
  onConfirm: (optionIds: string[], quantity: number, note: string) => void
}) {
  const groups = useMemo(() => applicableGroups(menu, item), [menu, item])
  const [selected, setSelected] = useState<string[]>([])
  const [qty, setQty] = useState(1)
  const [note, setNote] = useState('')
  const [hint, setHint] = useState('')

  const result = priceLine(menu, item, channel, selected)

  function togglePick(g: GroupWithOptions, opt: MenuOption) {
    if (opt.sold_out) return
    if (selected.includes(opt.id)) {
      setSelected(selected.filter((x) => x !== opt.id))
      setHint('')
      return
    }
    const inGroup = selected.filter((id) => g.options.some((o) => o.id === id)).length
    const max = g.group.max_select
    if (max !== null && inGroup >= max) {
      setHint(`"${groupLabel(g)}" เลือกได้สูงสุด ${max} อย่าง`)
      return
    }
    setHint('')
    setSelected([...selected, opt.id])
  }

  function toggleNoteChip(chip: string) {
    const parts = note
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const i = parts.indexOf(chip)
    if (i >= 0) parts.splice(i, 1)
    else parts.push(chip)
    setNote(parts.join(', '))
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label={item.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <h2 className="grow">{item.name}</h2>
          {item.sold_out ? <span className="badge pending">ของหมด</span> : null}
        </div>

        {groups.map((g) => (
          <div className="group-block" key={g.group.id}>
            <div className="group-head">
              <strong>{groupLabel(g)}</strong>
              {g.group.required ? <span className="badge pending">ต้องเลือก</span> : null}
              {g.group.max_select !== null && !g.group.tier_pricing ? (
                <span className="muted small">เลือกได้สูงสุด {g.group.max_select} อย่าง</span>
              ) : null}
            </div>
            <div className="opt-grid">
              {g.options.map((o) => (
                <div className="opt-wrap" key={o.id}>
                  <button
                    type="button"
                    className={`opt-chip${selected.includes(o.id) ? ' on' : ''}${o.sold_out ? ' soldout' : ''}`}
                    disabled={o.sold_out}
                    onClick={() => togglePick(g, o)}
                  >
                    {o.name}
                    {o.price_add > 0 ? <span className="opt-price"> +{fmtBaht(o.price_add)}</span> : null}
                    {o.sold_out ? <span className="badge pending">หมด</span> : null}
                  </button>
                  {editSoldOut ? (
                    <button
                      type="button"
                      className="mini-btn"
                      disabled={busy}
                      onClick={() => onToggleOptionSoldOut(o)}
                    >
                      {o.sold_out ? 'มีของ' : 'ของหมด'}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {g.options.length === 0 ? (
              <p className="muted small">ยังไม่มีตัวเลือกในกลุ่มนี้</p>
            ) : null}
          </div>
        ))}

        <div className="row">
          <span>จำนวน</span>
          <div className="qty-ctl">
            <button type="button" aria-label="ลด" disabled={qty <= 1} onClick={() => setQty((q) => q - 1)}>
              −
            </button>
            <span>{qty}</span>
            <button
              type="button"
              aria-label="เพิ่ม"
              disabled={qty >= 99}
              onClick={() => setQty((q) => q + 1)}
            >
              +
            </button>
          </div>
        </div>

        <label>
          หมายเหตุแถวนี้ (ไม่ใส่ก็ได้)
          <input
            value={note}
            maxLength={200}
            placeholder="เช่น ไม่เผ็ดเลย ไม่ผักชี"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="chips">
          {NOTE_CHIPS.map((c) => (
            <button
              type="button"
              key={c}
              className={`chip${note
                .split(',')
                .map((s) => s.trim())
                .includes(c) ? ' on' : ''}`}
              onClick={() => toggleNoteChip(c)}
            >
              {c}
            </button>
          ))}
        </div>

        {hint ? <p className="muted small">{hint}</p> : null}
        <p className={`preview-line${result.ok ? '' : ' err'}`}>
          {result.ok
            ? `รวม ${fmtBaht(result.unitPrice * qty)} บาท${qty > 1 ? ` (${fmtBaht(result.unitPrice)}/จาน)` : ''}`
            : result.error}
        </p>

        {editSoldOut ? (
          <button type="button" className="btn ghost" disabled={busy} onClick={onToggleItemSoldOut}>
            {item.sold_out ? 'เปิดขายเมนูนี้' : 'ปิดขายเมนูนี้ (ของหมด)'}
          </button>
        ) : null}

        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={!result.ok || busy}
            onClick={() => onConfirm(selected, qty, note.trim())}
          >
            ใส่ตะกร้า{qty > 1 ? ` (${qty})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pay sheets (3.23: cash with change; delivery settled in the app)
// ---------------------------------------------------------------------------

function CashSheet({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: Order
  busy: boolean
  onClose: () => void
  onConfirm: (paymentId: string, cashSatang: number) => void
}) {
  // one payment id per sheet open — a retry after a network error reuses it
  const [paymentId] = useState(() => crypto.randomUUID())
  const [received, setReceived] = useState('')
  const total = order.total_amount
  const rec = bahtToSatang(received)
  const change = rec !== null && rec >= total ? rec - total : null
  const missing = rec !== null && rec < total ? total - rec : null

  function addBanknote(baht: number) {
    setReceived(fmtBaht((bahtToSatang(received) ?? 0) + baht * 100))
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="รับเงินสด" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">คิว #{order.queue_number}</h2>
          <span className="badge">{TYPE_LABELS[order.order_type] ?? order.order_type}</span>
        </div>
        <p className="pay-total">ยอดรวม {fmtBaht(total)} บาท</p>
        <label>
          รับเงิน (บาท)
          <input
            value={received}
            inputMode="decimal"
            placeholder="0"
            onChange={(e) => setReceived(e.target.value)}
            autoFocus
          />
        </label>
        <div className="chips">
          <button type="button" className="chip" onClick={() => setReceived(fmtBaht(total))}>
            พอดี
          </button>
          {BANKNOTES.map((v) => (
            <button type="button" key={v} className="chip" onClick={() => addBanknote(v)}>
              +{v}
            </button>
          ))}
          <button type="button" className="chip" onClick={() => setReceived('')}>
            ล้าง
          </button>
        </div>
        {change !== null ? (
          <p className="preview-line">เงินทอน {fmtBaht(change)} บาท</p>
        ) : null}
        {missing !== null ? <p className="error">ยังขาดอีก {fmtBaht(missing)} บาท</p> : null}
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={busy || rec === null || rec < total}
            onClick={() => {
              if (rec !== null) onConfirm(paymentId, rec)
            }}
          >
            ยืนยันรับเงิน
          </button>
        </div>
      </div>
    </div>
  )
}

function DeliveryPaySheet({
  order,
  busy,
  onClose,
  onConfirm,
}: {
  order: Order
  busy: boolean
  onClose: () => void
  onConfirm: (paymentId: string) => void
}) {
  const [paymentId] = useState(() => crypto.randomUUID())
  const ch = CHANNEL_LABELS[order.channel] ?? order.channel
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="รับเงินผ่านแอป" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">คิว #{order.queue_number}</h2>
          <span className="badge">{ch}</span>
        </div>
        <p className="pay-total">ยอดรวม {fmtBaht(order.total_amount)} บาท</p>
        <p className="muted small">เดลิเวอรี่เก็บเงินผ่านแอป — ยืนยันเมื่อเห็นยอดในแอปแล้ว</p>
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ยกเลิก
          </button>
          <button
            type="button"
            className="btn primary grow"
            disabled={busy}
            onClick={() => onConfirm(paymentId)}
          >
            ยืนยันรับเงินผ่านแอป ({ch})
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cancel sheet (3.15: reason mandatory)
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
  const [reason, setReason] = useState('')
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-label="ยกเลิกออเดอร์"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (reason.trim() !== '' && !busy) onConfirm(reason.trim())
        }}
      >
        <h2>ยกเลิกคิว #{order.queue_number}</h2>
        <div className="chips">
          {CANCEL_REASONS.map((r) => (
            <button
              type="button"
              key={r}
              className={`chip${reason === r ? ' on' : ''}`}
              onClick={() => setReason(r)}
            >
              {r}
            </button>
          ))}
        </div>
        <label>
          เหตุผล (จำเป็น)
          <input
            value={reason}
            maxLength={200}
            placeholder="ระบุเหตุผลที่ยกเลิก"
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </label>
        <div className="row">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            ไม่ยกเลิก
          </button>
          <button type="submit" className="btn danger grow" disabled={busy || reason.trim() === ''}>
            ยืนยันยกเลิก
          </button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Queue callout (3.14: the number HUGE, dismissable)
// ---------------------------------------------------------------------------

function Callout({
  title,
  queue,
  lines,
  onClose,
}: {
  title: string
  queue?: number
  lines?: string[]
  onClose: () => void
}) {
  useEffect(() => {
    const t = window.setTimeout(onClose, 20_000)
    return () => window.clearTimeout(t)
  }, [onClose])
  return (
    <div className="callout" onClick={onClose} role="alert">
      <div className="callout-box" onClick={(e) => e.stopPropagation()}>
        <p className="callout-title">{title}</p>
        {typeof queue === 'number' ? <p className="callout-q">#{queue}</p> : null}
        {lines ? lines.map((l, i) => <p className="callout-line" key={i}>{l}</p>) : null}
        <button type="button" className="btn primary" onClick={onClose}>
          ปิด
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One open order on the queue screen (3.19)
// ---------------------------------------------------------------------------

function OrderCard({
  order,
  now,
  busy,
  onServe,
  onPay,
  onAddItems,
  onCancel,
}: {
  order: Order
  now: number
  busy: boolean
  onServe: () => void
  onPay: () => void
  onAddItems: () => void
  onCancel: () => void
}) {
  return (
    <div className={`card order-card${order.status === 'served' ? ' served-card' : ''}`}>
      <div className="row">
        <span className="qnum">#{order.queue_number}</span>
        <div className="grow">
          <div className="chips">
            <span className="badge">{TYPE_LABELS[order.order_type] ?? order.order_type}</span>
            <span className="badge">{CHANNEL_LABELS[order.channel] ?? order.channel}</span>
            {order.table_no ? <span className="badge approved">โต๊ะ {order.table_no}</span> : null}
          </div>
          <span className={`status-tag ${order.status}`}>
            {order.status === 'preparing' ? 'กำลังทำ' : 'เสิร์ฟแล้ว'}
          </span>
        </div>
        <span className="muted small">{ageText(order.created_at, now)}</span>
      </div>

      {order.note ? <p className="muted small">หมายเหตุบิล: {order.note}</p> : null}

      <ul className="order-items">
        {order.items.map((it) => (
          <li key={it.id}>
            <strong>×{it.quantity}</strong> {it.item_name}
            {it.options.length > 0 ? (
              <span className="muted"> — {it.options.map((x) => x.name).join(', ')}</span>
            ) : null}
            {it.note ? <span className="linenote"> ({it.note})</span> : null}
          </li>
        ))}
      </ul>

      <p className="total-big">รวม {fmtBaht(order.total_amount)} บาท</p>

      <div className="row">
        {order.status === 'preparing' ? (
          <button type="button" className="btn primary grow" disabled={busy} onClick={onServe}>
            เสร็จ / เสิร์ฟ
          </button>
        ) : (
          <button type="button" className="btn primary grow" disabled={busy} onClick={onPay}>
            รับเงิน
          </button>
        )}
        <button type="button" className="btn" disabled={busy} onClick={onAddItems}>
          สั่งเพิ่ม
        </button>
        <button type="button" className="btn danger" disabled={busy} onClick={onCancel}>
          ยกเลิก
        </button>
      </div>
    </div>
  )
}
