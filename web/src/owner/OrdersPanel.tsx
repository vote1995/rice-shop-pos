//! Owner "ออเดอร์" tab — the bills of one Bangkok sale day with the owner-only
//! money actions (ROADMAP M1-4b; FEATURES 3.28, 3.47, 3.60).
//!
//! Patterns copied from MenuPanel: the shop select, ONE busy flag for the
//! whole panel, `run()` (friendly Thai error + reload after every mutation,
//! never assuming success) and baht <-> satang through the shared helpers of
//! `pos/pricing` (the backend stores INTEGER satang, the UI shows/enters
//! baht). Bangkok is UTC+7 all year, so every clock here is a fixed offset
//! from UTC — exactly the math the server uses for the sale day.
//!
//! Existing discounts (old bills, staff meals) are still SHOWN read-only; the
//! stored total is the only authority.

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, api, friendlyError } from '../api'
import type {
  Order,
  OrderChannel,
  OrderStatus,
  OwnerDayOrder,
  OwnerDayOrdersData,
  Payment,
} from '../api'
import { bahtToSatang, fmtBaht } from '../pos/pricing'
import { useOwnerShop } from './shopContext'

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

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

const STATUS_LABELS: Record<string, string> = {
  preparing: 'กำลังทำ',
  served: 'เสิร์ฟแล้ว',
  paid: 'จ่ายแล้ว',
  cancelled: 'ยกเลิก',
}

/** badge colour classes of the owner stylesheets. */
const STATUS_BADGE: Record<string, string> = {
  preparing: 'pending',
  served: '',
  paid: 'approved',
  cancelled: 'revoked',
}

const METHOD_LABELS: Record<string, string> = {
  cash: 'เงินสด',
  delivery_app: 'แอปเดลิเวอรี่',
  promptpay: 'PromptPay',
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  succeeded: 'สำเร็จ',
  refunded: 'คืนเงินแล้ว',
  pending: 'รอชำระ',
  expired: 'หมดอายุ',
}

const CHANNELS: Array<{ id: OrderChannel; label: string }> = [
  { id: 'counter', label: 'หน้าร้าน' },
  { id: 'grab', label: 'Grab' },
  { id: 'lineman', label: 'LINE MAN' },
  { id: 'foodpanda', label: 'Foodpanda' },
]

type Filter = 'all' | 'open' | 'paid' | 'cancelled'

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'ทั้งหมด' },
  { id: 'open', label: 'ค้าง' },
  { id: 'paid', label: 'จ่ายแล้ว' },
  { id: 'cancelled', label: 'ยกเลิก' },
]

const CANCEL_REASONS = ['ลูกค้ายกเลิก', 'คีย์ผิด', 'ของหมด']

// ---------------------------------------------------------------------------
// Bangkok (UTC+7) clock — the sale day boundary the server uses
// ---------------------------------------------------------------------------

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000

const THAI_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
]

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Shift the instant into the Bangkok day, then read it as UTC. */
function bangkokDate(ms: number): Date {
  return new Date(ms + BANGKOK_OFFSET_MS)
}

/** "HH:MM" of the Bangkok wall clock. */
function fmtBangkokTime(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  const d = bangkokDate(v)
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

/** "15 ม.ค. 12:34" (Bangkok wall clock) — used for refunds, which can land on another day. */
function fmtBangkokDateTime(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  const d = bangkokDate(v)
  return `${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()] ?? ''} ${fmtBangkokTime(v)}`
}

/** Today as "YYYY-MM-DD" in the Bangkok calendar day (the `?day=` shape). */
function bangkokToday(): string {
  const d = bangkokDate(Date.now())
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

/** "2024-01-15" -> "15 ม.ค. 2567" (Buddhist era); anything odd is shown as-is. */
function fmtDayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (!m) return day
  const month = THAI_MONTHS[Number(m[2]) - 1]
  if (!month) return day
  return `${Number(m[3])} ${month} ${Number(m[1]) + 543}`
}

// ---------------------------------------------------------------------------
// Money / bill math (mirrors the server, which stores INTEGER satang)
// ---------------------------------------------------------------------------

/** An unpaid bill can still be cancelled (owner only). */
function isUnpaid(o: Order): boolean {
  return o.status === 'preparing' || o.status === 'served'
}

/** A payment whose money is in the day's sales / can be refunded. */
function countedPayment(p: Payment): boolean {
  return p.status === 'succeeded' || p.status === 'refunded'
}

/** Net satang of one payment: its amount minus whatever was refunded. */
function netPayment(p: Payment): number {
  return p.amount - (p.refund_amount ?? 0)
}

interface DaySummary {
  paidBills: number
  /** สวัสดิการพนักงาน plates of the day (not in paidBills / sales). */
  staffMeals: number
  openBills: number
  cancelledBills: number
  sales: number
  refunds: number
  channels: Array<{ id: OrderChannel; label: string; bills: number; sales: number }>
}

/** The day's headline numbers, all in satang, from the day view rows. */
function summarize(orders: OwnerDayOrder[]): DaySummary {
  const summary: DaySummary = {
    paidBills: 0,
    staffMeals: 0,
    openBills: 0,
    cancelledBills: 0,
    sales: 0,
    refunds: 0,
    channels: CHANNELS.map((c) => ({ ...c, bills: 0, sales: 0 })),
  }
  for (const o of orders) {
    // สวัสดิการพนักงาน: billed 0, never a sale - counted on its own line
    if (o.staff_meal) {
      if (o.status !== 'cancelled') summary.staffMeals += 1
      continue
    }
    const payments = o.payments.filter(countedPayment)
    const net = payments.reduce((s, p) => s + netPayment(p), 0)
    const refunded = payments.reduce((s, p) => s + (p.refund_amount ?? 0), 0)
    summary.sales += net
    summary.refunds += refunded
    if (o.status === 'cancelled') summary.cancelledBills += 1
    else if (isUnpaid(o)) summary.openBills += 1
    else summary.paidBills += 1
    if (payments.length > 0) {
      const ch = summary.channels.find((c) => c.id === o.channel)
      if (ch) {
        ch.bills += 1
        ch.sales += net
      }
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// OrdersPanel
// ---------------------------------------------------------------------------

export function OrdersPanel() {
  const { shopId } = useOwnerShop()
  const [day, setDay] = useState<string>(() => bangkokToday())
  const [data, setData] = useState<OwnerDayOrdersData | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  // one inline form at a time, keyed by order / payment id
  const [cancelFor, setCancelFor] = useState<string | null>(null)
  const [refundFor, setRefundFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!shopId) {
      setData(null)
      return
    }
    setBusy(true)
    try {
      const q = day.trim() === '' ? '' : `?day=${encodeURIComponent(day.trim())}`
      const d = await api<OwnerDayOrdersData>(
        'GET',
        `/api/owner/shops/${encodeURIComponent(shopId)}/orders${q}`,
      )
      setData(d)
      setMsg('')
    } catch (e) {
      setMsg(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }, [shopId, day])

  useEffect(() => {
    void load()
  }, [load])

  // another shop / day means another set of bills: drop any open form
  useEffect(() => {
    setCancelFor(null)
    setRefundFor(null)
  }, [shopId, day])

  /** Run one mutation with the busy flag + friendly error + reload. Returns success. */
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    try {
      await fn()
      setMsg('')
      await load()
      return true
    } catch (e) {
      setMsg(friendlyError(e))
      // 409/404: the bill changed under us — show what it is now.
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) await load()
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveCancel(order: OwnerDayOrder, reason: string) {
    const ok = await run(() =>
      api('POST', `/api/owner/orders/${encodeURIComponent(order.id)}/cancel`, { reason }),
    )
    if (ok) setCancelFor(null)
  }

  async function saveRefund(payment: Payment, reason: string, amount: number | null) {
    const ok = await run(() =>
      api('POST', `/api/owner/payments/${encodeURIComponent(payment.id)}/refund`, {
        reason,
        amount,
      }),
    )
    if (ok) setRefundFor(null)
  }

  const orders = data?.orders ?? []
  const summary = summarize(orders)
  const counts: Record<Filter, number> = {
    all: orders.length,
    open: orders.filter((o) => isUnpaid(o)).length,
    paid: orders.filter((o) => o.status === 'paid').length,
    cancelled: orders.filter((o) => o.status === 'cancelled').length,
  }
  const visible = orders.filter((o) => {
    if (filter === 'open') return isUnpaid(o)
    if (filter === 'paid') return o.status === 'paid'
    if (filter === 'cancelled') return o.status === 'cancelled'
    return true
  })
  const dayLabel = day.trim() === '' ? 'วันนี้' : fmtDayLabel(day)

  return (
    <section>
      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}

      <div className="row">
        <label className="grow">
          วันที่ (เวลากรุงเทพฯ)
          <input type="date" value={day} onChange={(e) => setDay(e.target.value)} disabled={busy} />
        </label>
      </div>

      <div className="row">
        <h2 className="grow">ออเดอร์ ({visible.length})</h2>
        <button className="btn ghost" disabled={busy} onClick={() => setDay(bangkokToday())}>
          วันนี้
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => void load()}>
          รีเฟรช
        </button>
      </div>

      <section className="card">
        <h2>สรุปวันที่ {dayLabel}</h2>
        <div className="sum-grid">
          <div className="sum-box">
            <span className="muted small">จำนวนบิลที่จ่าย</span>
            <span className="sum-val">{summary.paidBills} บิล</span>
          </div>
          <div className="sum-box">
            <span className="muted small">ยอดขาย</span>
            <span className="sum-val">{fmtBaht(summary.sales)} บาท</span>
          </div>
          <div className="sum-box">
            <span className="muted small">ยอดคืนเงิน</span>
            <span className="sum-val">{fmtBaht(summary.refunds)} บาท</span>
          </div>
          <div className="sum-box">
            <span className="muted small">จำนวนบิลยกเลิก</span>
            <span className="sum-val">{summary.cancelledBills} บิล</span>
          </div>
        </div>
        <div className="chips" role="group" aria-label="แยกตามช่องทาง">
          {summary.channels.map((c) => (
            <span className={`badge${c.bills > 0 ? ' approved' : ''}`} key={c.id}>
              {c.label} {c.bills} บิล · {fmtBaht(c.sales)} บาท
            </span>
          ))}
        </div>
        <p className="muted small">
          ยอดขาย = ยอดที่ชำระแล้วหักเงินที่คืน · ค้างอยู่ {summary.openBills} บิล
          {summary.staffMeals > 0 ? ` · สวัสดิการพนักงาน ${summary.staffMeals} จาน (ไม่นับเป็นยอดขาย)` : ''}
          {' '}· เปลี่ยนวันที่ด้านบนเพื่อดูยอดย้อนหลัง
        </p>
      </section>

      <div className="chips" role="group" aria-label="กรองตามสถานะ">
        {FILTERS.map((f) => (
          <button
            type="button"
            key={f.id}
            className={`chip${filter === f.id ? ' on' : ''}`}
            disabled={busy}
            onClick={() => setFilter(f.id)}
          >
            {f.label} ({counts[f.id]})
          </button>
        ))}
      </div>

      {orders.length === 0 ? (
        <p className="muted">ยังไม่มีออเดอร์วันนี้</p>
      ) : visible.length === 0 ? (
        <p className="muted">ไม่มีออเดอร์ที่ตรงกับตัวกรองนี้</p>
      ) : null}

      <div className="list">
        {visible.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            busy={busy}
            cancelFor={cancelFor}
            refundFor={refundFor}
            actions={{
              openCancel: setCancelFor,
              closeCancel: () => setCancelFor(null),
              saveCancel: (order, reason) => void saveCancel(order, reason),
              openRefund: setRefundFor,
              closeRefund: () => setRefundFor(null),
              saveRefund: (payment, reason, amount) => void saveRefund(payment, reason, amount),
            }}
          />
        ))}
      </div>
    </section>
  )
}

export default OrdersPanel

// ---------------------------------------------------------------------------
// One bill of the day
// ---------------------------------------------------------------------------

interface CardActions {
  openCancel(id: string): void
  closeCancel(): void
  saveCancel(order: OwnerDayOrder, reason: string): void
  openRefund(id: string): void
  closeRefund(): void
  saveRefund(payment: Payment, reason: string, amount: number | null): void
}

function statusBadgeClass(status: OrderStatus): string {
  return STATUS_BADGE[status] ?? ''
}

function OrderCard({
  order,
  busy,
  cancelFor,
  refundFor,
  actions,
}: {
  order: OwnerDayOrder
  busy: boolean
  cancelFor: string | null
  refundFor: string | null
  actions: CardActions
}) {
  const unpaid = isUnpaid(order)
  return (
    <div className="item">
      <div className="row">
        <strong className="grow">
          #{order.queue_number} · {fmtBangkokTime(order.created_at)}
        </strong>
        <span className={`badge ${statusBadgeClass(order.status)}`}>
          {STATUS_LABELS[order.status] ?? order.status}
        </span>
      </div>
      <div className="chips">
        <span className="badge">{TYPE_LABELS[order.order_type] ?? order.order_type}</span>
        <span className="badge">{CHANNEL_LABELS[order.channel] ?? order.channel}</span>
        {order.staff_meal ? <span className="badge pending">สวัสดิการพนักงาน</span> : null}
        {order.table_no ? <span className="badge approved">โต๊ะ {order.table_no}</span> : null}
      </div>
      {order.note ? <p className="muted small">หมายเหตุบิล: {order.note}</p> : null}

      <div className="order-lines">
        {order.items.map((it) => (
          <div className="order-line" key={it.id}>
            <span className="grow">
              <strong>{it.item_name}</strong>
              {it.options.length > 0 ? (
                <span className="muted small"> — {it.options.map((x) => x.name).join(', ')}</span>
              ) : null}
              {it.note ? <p className="muted small">หมายเหตุ: {it.note}</p> : null}
            </span>
            <span className="muted small">
              {it.quantity} × {fmtBaht(it.unit_price)} บาท
            </span>
            {it.discount_amount > 0 ? (
              <span className="badge pending">-{fmtBaht(it.discount_amount)}</span>
            ) : null}
            <span className="line-amt">{fmtBaht(it.line_total)} บาท</span>
          </div>
        ))}
        {order.items.length === 0 ? <p className="muted small">ไม่มีรายการในบิลนี้</p> : null}
      </div>

      {order.discount_amount > 0 ? (
        <p className="muted small disc-line">
          <span>ส่วนลดทั้งบิล</span>
          <span>-{fmtBaht(order.discount_amount)} บาท</span>
        </p>
      ) : null}
      <p className="total-big">รวม {fmtBaht(order.total_amount)} บาท</p>

      {order.status === 'cancelled' && order.cancel_reason ? (
        <p className="error small">เหตุผลที่ยกเลิก: {order.cancel_reason}</p>
      ) : null}

      {order.payments.length > 0 ? (
        <div className="subblock">
          {order.payments.map((p) => (
            <div className="pay-line" key={p.id}>
              <div className="row">
                <span className="grow">
                  <strong>{METHOD_LABELS[p.method] ?? p.method}</strong>{' '}
                  <span className="muted small">{fmtBangkokDateTime(p.created_at)}</span>
                </span>
                <span className={`badge ${p.status === 'refunded' ? 'revoked' : 'approved'}`}>
                  {PAYMENT_STATUS_LABELS[p.status] ?? p.status}
                </span>
              </div>
              <p className="small">
                ยอดชำระ {fmtBaht(p.amount)} บาท
                {p.cash_received !== null ? ` · รับเงิน ${fmtBaht(p.cash_received)} บาท` : ''}
                {p.cash_change !== null && p.cash_change > 0
                  ? ` · ทอน ${fmtBaht(p.cash_change)} บาท`
                  : ''}
              </p>
              {p.status === 'refunded' ? (
                <p className="error small">
                  คืนเงิน {fmtBaht(p.refund_amount ?? 0)} บาท · {p.refund_reason ?? '-'} ·{' '}
                  {fmtBangkokDateTime(p.refunded_at)}
                </p>
              ) : null}
              {p.status === 'succeeded' ? (
                refundFor === p.id ? (
                  <RefundForm
                    payment={p}
                    busy={busy}
                    onSave={actions.saveRefund}
                    onCancel={actions.closeRefund}
                  />
                ) : (
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy}
                    onClick={() => actions.openRefund(p.id)}
                  >
                    คืนเงิน
                  </button>
                )
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {unpaid ? (
        <>
          <div className="row">
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => actions.openCancel(order.id)}
            >
              ยกเลิกบิล
            </button>
          </div>
          {cancelFor === order.id ? (
            <CancelForm
              order={order}
              busy={busy}
              onSave={actions.saveCancel}
              onCancel={actions.closeCancel}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cancel form (3.15): a reason is mandatory
// ---------------------------------------------------------------------------

function CancelForm({
  order,
  busy,
  onSave,
  onCancel,
}: {
  order: OwnerDayOrder
  busy: boolean
  onSave: (order: OwnerDayOrder, reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const r = reason.trim()
    if (r === '') {
      setErr('กรอกเหตุผลที่ยกเลิก')
      return
    }
    setErr('')
    onSave(order, r)
  }

  return (
    <form className="group-block" onSubmit={submit}>
      <h3>ยกเลิกบิล #{order.queue_number}</h3>
      {err ? <p className="error small">{err}</p> : null}
      <div className="chips">
        {CANCEL_REASONS.map((r) => (
          <button
            type="button"
            key={r}
            className={`chip${reason === r ? ' on' : ''}`}
            disabled={busy}
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
          placeholder="ระบุเหตุผลที่ยกเลิกบิลนี้"
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p className="muted small">ยกเลิกได้เฉพาะบิลที่ยังไม่จ่าย และย้อนกลับไม่ได้</p>
      <div className="row">
        <button className="btn danger" type="submit" disabled={busy || reason.trim() === ''}>
          ยืนยันยกเลิกบิล
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          ปิด
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Refund form (3.28): reason + whole/partial, confirmed before sending
// ---------------------------------------------------------------------------

function RefundForm({
  payment,
  busy,
  onSave,
  onCancel,
}: {
  payment: Payment
  busy: boolean
  onSave: (payment: Payment, reason: string, amount: number | null) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'all' | 'part'>('all')
  const [amount, setAmount] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    const r = reason.trim()
    if (r === '') {
      setErr('กรอกเหตุผลที่คืนเงิน')
      return
    }
    let amt: number | null = null
    if (mode === 'part') {
      const v = bahtToSatang(amount)
      if (v === null || v < 1 || v > payment.amount) {
        setErr(`จำนวนเงินต้องอยู่ระหว่าง 0.01 - ${fmtBaht(payment.amount)} บาท`)
        return
      }
      amt = v
    }
    setErr('')
    const question =
      amt === null
        ? `คืนเงินทั้งยอด ${fmtBaht(payment.amount)} บาท?`
        : `คืนเงิน ${fmtBaht(amt)} บาท (จาก ${fmtBaht(payment.amount)} บาท)?`
    if (!window.confirm(question)) return
    onSave(payment, r, amt)
  }

  return (
    <form className="group-block" onSubmit={submit}>
      <h3>คืนเงิน {METHOD_LABELS[payment.method] ?? payment.method}</h3>
      {err ? <p className="error small">{err}</p> : null}
      <label>
        เหตุผล (จำเป็น)
        <input
          value={reason}
          maxLength={200}
          placeholder="ระบุเหตุผลที่คืนเงิน"
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="row">
        <label className="check">
          <input
            type="radio"
            name={`refund-mode-${payment.id}`}
            checked={mode === 'all'}
            onChange={() => setMode('all')}
            disabled={busy}
          />
          ทั้งหมด ({fmtBaht(payment.amount)} บาท)
        </label>
        <label className="check">
          <input
            type="radio"
            name={`refund-mode-${payment.id}`}
            checked={mode === 'part'}
            onChange={() => setMode('part')}
            disabled={busy}
          />
          บางส่วน
        </label>
      </div>
      {mode === 'part' ? (
        <label>
          จำนวนเงินที่คืน (บาท, ไม่เกิน {fmtBaht(payment.amount)})
          <input
            value={amount}
            inputMode="decimal"
            placeholder="เช่น 20"
            disabled={busy}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      ) : null}
      {payment.method === 'promptpay' ? (
        <p className="muted small">บิลที่จ่ายผ่าน Beam ให้คืนเงินใน Beam dashboard ก่อน แล้วค่อยบันทึกที่นี่</p>
      ) : null}
      <div className="row">
        <button
          className="btn danger"
          type="submit"
          disabled={busy || reason.trim() === '' || (mode === 'part' && bahtToSatang(amount) === null)}
        >
          ยืนยันคืนเงิน
        </button>
        <button className="btn ghost" type="button" onClick={onCancel} disabled={busy}>
          ปิด
        </button>
      </div>
    </form>
  )
}
