// OWNER sales summary (ROADMAP M2-R1) — the "สรุปยอด" sub-tab of the order
// tab (web only). ONE GET /api/owner/shops/{id}/report call per filter
// change; the server does all the aggregation and money comes back as
// INTEGER satang, so the UI only divides by 100 (fmtBaht).
//
// Patterns kept from StockPanel: ONE busy flag, one friendly-error line. The
// shop is not chosen here anymore — it comes from the shared sidebar switcher
// (shopContext), so changing it there refetches everything below. The filter
// dropdowns are fed by the endpoints the other owner tabs already use — menu
// (types + the choices of a type) and stock (ingredients). A sequence number
// drops stale responses, because every filter change refetches immediately
// and the owner taps faster than the network answers.
//
// Every date here is a Bangkok calendar day: "today" comes from
// Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Bangkok'}) (the device may be
// in any zone), the rest is plain "YYYY-MM-DD" arithmetic, and bill stamps
// use the fixed UTC+7 offset the server prices sale days with.
//
// UI-3: the screen is laid out as a restaurant DASHBOARD (filter bar, KPI
// cards, charts + "ต้องดู", table cards, bill list). All of that look lives
// in the `.dash-*` rules appended under the `.owner` scope of styles.css and
// uses nothing but theme tokens, so light and dark both work. The icons are
// the inline SVG line paths in ICONS below (no icon library). Data loading,
// filters and API calls are untouched by the restyle.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, friendlyError } from '../api'
import type {
  MenuData,
  ReportData,
  StockData,
} from '../api'
import { fmtBaht } from '../pos/pricing'
import { useOwnerShop } from './shopContext'
import StockCheck from './StockCheck'

const METHOD_LABELS: Record<string, string> = {
  cash: 'เงินสด',
  promptpay: 'QR พร้อมเพย์',
  delivery_app: 'แอปเดลิเวอรี่',
  card: 'บัตร',
  ewallet: 'e-wallet',
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const CHANNEL_LABELS: Record<string, string> = {
  counter: 'หน้าร้าน',
  grab: 'Grab',
  lineman: 'LINE MAN',
  foodpanda: 'Foodpanda',
}

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

// ---------------------------------------------------------------------------
// Inline SVG line icons (24px grid, stroked with currentColor)
// ---------------------------------------------------------------------------

type IconName =
  | 'banknote'
  | 'receipt'
  | 'bowl'
  | 'calc'
  | 'clock'
  | 'calendar'
  | 'chart'
  | 'alert'
  | 'x-circle'
  | 'refund'
  | 'hourglass'
  | 'box'
  | 'check'
  | 'refresh'
  | 'x'

const ICONS: Record<IconName, ReactNode> = {
  banknote: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 10.5v3" />
      <path d="M18 10.5v3" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z" />
      <path d="M9.5 8.5h5" />
      <path d="M9.5 12.5h5" />
    </>
  ),
  bowl: (
    <>
      <path d="M3.5 11h17a8.5 8.5 0 0 1-17 0z" />
      <path d="M9 7.5c0-1.6 1-2.1 1-3.5" />
      <path d="M14 7.5c0-1.6 1-2.1 1-3.5" />
    </>
  ),
  calc: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7.5h6" />
      <path d="M9 12h.01" />
      <path d="M12 12h.01" />
      <path d="M15 12h.01" />
      <path d="M9 16h.01" />
      <path d="M12 16h.01" />
      <path d="M15 16h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17" />
      <path d="M8 3.5v3" />
      <path d="M16 3.5v3" />
    </>
  ),
  chart: (
    <>
      <path d="M3 21h18" />
      <path d="M6 21v-7" />
      <path d="M11 21V9" />
      <path d="M16 21v-4" />
      <path d="M21 21V4" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5 21 19.5H3z" />
      <path d="M12 10v4" />
      <path d="M12 16.9v.01" />
    </>
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5l5 5" />
      <path d="M14.5 9.5l-5 5" />
    </>
  ),
  refund: (
    <>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M4 4.5V9h4.5" />
    </>
  ),
  hourglass: (
    <>
      <path d="M7.5 3.5h9" />
      <path d="M7.5 20.5h9" />
      <path d="M8.5 3.5v3c0 2 3.5 3.6 3.5 5.5s-3.5 3.5-3.5 5.5v3" />
      <path d="M15.5 3.5v3c0 2-3.5 3.6-3.5 5.5s3.5 3.5 3.5 5.5v3" />
    </>
  ),
  box: (
    <>
      <path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z" />
      <path d="M3.5 8 12 12l8.5-4" />
      <path d="M12 12v8" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4.5V9h-4.5" />
    </>
  ),
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Bangkok calendar-day math ("YYYY-MM-DD" strings, no Date parsing)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000
/** the server refuses more than this many days in one report. */
const MAX_DAYS = 366
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function p2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Today as "YYYY-MM-DD" in the Bangkok calendar day. */
function bangkokToday(): string {
  // en-CA is the locale that formats as YYYY-MM-DD; the browser zone is ignored.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
}

/** "2026-10-31" -> UTC ms of that civil date (pure calendar math); null when odd. */
function dayToMs(day: string): number | null {
  const m = DAY_RE.exec(day.trim())
  if (m === null) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(t) ? null : t
}

function msToDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

function addDays(day: string, n: number): string {
  const t = dayToMs(day)
  return t === null ? day : msToDay(t + n * DAY_MS)
}

/** "2026-10-31" -> "2026-10". */
function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** "2026-10" -> "2026-10-01". */
function monthStart(month: string): string {
  return `${month}-01`
}

/** "2026-10" -> "2026-10-31" (the day before the next month's first). */
function monthEnd(month: string): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const ny = m === 12 ? y + 1 : y
  const nm = m === 12 ? 1 : m + 1
  return msToDay(Date.UTC(ny, nm - 1, 1) - DAY_MS)
}

/** "2026-10-05" -> "05/10" (fixed width, so the bars line up). */
function fmtDayMonth(day: string): string {
  const m = DAY_RE.exec(day)
  return m === null ? day : `${m[3]}/${m[2]}`
}

/** "2026-10-31" -> "31 ต.ค. 2569" (Buddhist era). */
function fmtDayLong(day: string): string {
  const m = DAY_RE.exec(day)
  const mo = m === null ? undefined : THAI_MONTHS[Number(m[2]) - 1]
  return m === null || mo === undefined ? day : `${Number(m[3])} ${mo} ${Number(m[1]) + 543}`
}

/** Bill stamp "31/10 12:34" on the Bangkok wall clock. */
function fmtBillStamp(ms: number): string {
  const d = new Date(ms + BANGKOK_OFFSET_MS)
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

// ---------------------------------------------------------------------------
// Time-of-day helpers ("HH:MM" <-> minutes of the Bangkok day)
// ---------------------------------------------------------------------------

/** "06:30" -> 390; '' or anything odd -> null (param omitted = "all"). */
function toMinutes(v: string): number | null {
  const t = v.trim()
  if (t === '') return null
  const m = /^(\d{1,2}):(\d{2})/.exec(t)
  if (m === null) return null
  const mins = Number(m[1]) * 60 + Number(m[2])
  return mins >= 0 && mins <= 1440 ? mins : null
}

/** 390 -> "06:30"; 1320 -> "22:00"; 1440 -> "24:00". */
function minutesLabel(mins: number): string {
  return `${p2(Math.floor(mins / 60) % 24)}:${p2(mins % 60)}`
}

/** "0.27 กก." — at most 2 decimals, trailing ".0" dropped. */
function fmtUsed(v: number, unit: string): string {
  return `${Math.round(v * 100) / 100} ${unit}`
}

// ---------------------------------------------------------------------------
// Filter presets
// ---------------------------------------------------------------------------

type RangeId = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'lastMonth' | 'custom'

/** `short` is what the compact segmented control shows, `label` its tooltip. */
const RANGES: Array<{ id: RangeId; label: string; short: string }> = [
  { id: 'today', label: 'วันนี้', short: 'วันนี้' },
  { id: 'yesterday', label: 'เมื่อวาน', short: 'เมื่อวาน' },
  { id: 'last7', label: '7 วันล่าสุด', short: '7 วัน' },
  { id: 'thisMonth', label: 'เดือนนี้', short: 'เดือนนี้' },
  { id: 'lastMonth', label: 'เดือนที่แล้ว', short: 'เดือนที่แล้ว' },
  { id: 'custom', label: 'เลือกวันเอง', short: 'เลือกเอง' },
]

type SpanId = 'all' | 'morning' | 'lunch' | 'afternoon' | 'evening' | 'custom'

/** tfrom/tto in minutes; null = omit the param (the whole day). */
const SPANS: Array<{ id: SpanId; label: string; short: string; from: number | null; to: number | null }> = [
  { id: 'all', label: 'ทั้งวัน', short: 'ทั้งวัน', from: null, to: null },
  { id: 'morning', label: 'เช้า 06:00–11:00', short: 'เช้า', from: 360, to: 660 },
  { id: 'lunch', label: 'กลางวัน 11:00–14:00', short: 'กลางวัน', from: 660, to: 840 },
  { id: 'afternoon', label: 'บ่าย 14:00–17:00', short: 'บ่าย', from: 840, to: 1020 },
  { id: 'evening', label: 'เย็น 17:00–22:00', short: 'เย็น', from: 1020, to: 1320 },
  { id: 'custom', label: 'เลือกเวลาเอง', short: 'เลือกเอง', from: null, to: null },
]

/** The from/to pair a chip stands for ("today" is recomputed on every render). */
function periodOf(range: RangeId, fromDay: string, toDay: string, today: string): { from: string; to: string } {
  switch (range) {
    case 'yesterday': {
      const y = addDays(today, -1)
      return { from: y, to: y }
    }
    case 'last7':
      return { from: addDays(today, -6), to: today }
    case 'thisMonth':
      return { from: monthStart(monthOf(today)), to: monthEnd(monthOf(today)) }
    case 'lastMonth': {
      const prev = monthOf(addDays(monthStart(monthOf(today)), -1))
      return { from: monthStart(prev), to: monthEnd(prev) }
    }
    case 'custom':
      return { from: fromDay.trim(), to: toDay.trim() }
    default:
      return { from: today, to: today }
  }
}

/** The tfrom/tto pair a time chip stands for (null = leave the param out). */
function todOf(span: SpanId, timeFrom: string, timeTo: string): { from: number | null; to: number | null } {
  const preset = SPANS.find((s) => s.id === span)
  if (preset !== undefined && preset.id !== 'custom') return { from: preset.from, to: preset.to }
  return { from: toMinutes(timeFrom), to: toMinutes(timeTo) }
}

/** ?from&to&tfrom&tto&menu_item_id&option_id&ingredient_id — only what is set. */
function buildQuery(
  period: { from: string; to: string },
  tod: { from: number | null; to: number | null },
  menuItemId: string,
  optionId: string,
  ingredientId: string,
): string {
  const q: string[] = [`from=${encodeURIComponent(period.from)}`, `to=${encodeURIComponent(period.to)}`]
  if (tod.from !== null) q.push(`tfrom=${tod.from}`)
  if (tod.to !== null) q.push(`tto=${tod.to}`)
  if (menuItemId !== '') {
    q.push(`menu_item_id=${encodeURIComponent(menuItemId)}`)
    // option_id alone is a 400 — it only rides along with its type.
    if (optionId !== '') q.push(`option_id=${encodeURIComponent(optionId)}`)
  }
  if (ingredientId !== '') q.push(`ingredient_id=${encodeURIComponent(ingredientId)}`)
  return `?${q.join('&')}`
}

// ---------------------------------------------------------------------------
// Bill status (three states are all the dashboard needs)
// ---------------------------------------------------------------------------

function billStatusLabel(status: string): string {
  if (status === 'paid') return 'จ่ายแล้ว'
  if (status === 'cancelled') return 'ยกเลิก'
  if (status === 'staff') return 'สวัสดิการ'
  if (status === 'staff_cancelled') return 'ยกเลิก (สวัสดิการ)'
  if (status === 'test') return 'ร้านทดสอบ (ไม่นับยอด)'
  if (status === 'test_cancelled') return 'ยกเลิก (ร้านทดสอบ)'
  return 'ยังไม่ปิด'
}

/** success / warning / danger — the dot AND the text use this tone. */
function billStatusTone(status: string): 'ok' | 'warn' | 'bad' {
  if (status === 'paid' || status === 'staff') return 'ok'
  if (status === 'cancelled' || status === 'staff_cancelled' || status === 'test_cancelled') return 'bad'
  return 'warn'
}

// ---------------------------------------------------------------------------
// ReportPanel
// ---------------------------------------------------------------------------

export default function ReportPanel() {
  // the ONE shop selection of the owner app (picked in the sidebar)
  const { shopId, error: shopErr } = useOwnerShop()
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // filter sources: types/choices from the menu, ingredients from the stock
  const [menu, setMenu] = useState<MenuData | null>(null)
  const [stock, setStock] = useState<StockData | null>(null)
  const [srcErr, setSrcErr] = useState('')
  // filters (1 date range · 2 time of day · 3 type/choice · 4 ingredient)
  const [range, setRange] = useState<RangeId>('today')
  const [fromDay, setFromDay] = useState('')
  const [toDay, setToDay] = useState('')
  const [span, setSpan] = useState<SpanId>('all')
  const [timeFrom, setTimeFrom] = useState('')
  const [timeTo, setTimeTo] = useState('')
  const [menuItemId, setMenuItemId] = useState('')
  const [optionId, setOptionId] = useState('')
  const [ingredientId, setIngredientId] = useState('')
  // result
  const [data, setData] = useState<ReportData | null>(null)
  const [nonce, setNonce] = useState(0) // the รีเฟรช button
  const seq = useRef(0) // drops responses of filters already changed again

  // another shop = another menu, another stock and other ids in the dropdowns
  useEffect(() => {
    setMenuItemId('')
    setOptionId('')
    setIngredientId('')
    setData(null) // never show one shop's money under another shop's name
    if (shopId === '') {
      setMenu(null)
      setStock(null)
      return
    }
    let on = true
    setSrcErr('')
    void (async () => {
      try {
        const [m, s] = await Promise.all([
          api<MenuData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/menu`),
          api<StockData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/stock`),
        ])
        if (!on) return
        setMenu(m)
        setStock(s)
      } catch (e) {
        if (on) setSrcErr(friendlyError(e))
      }
    })()
    return () => {
      on = false
    }
  }, [shopId])

  const today = bangkokToday()
  const period = periodOf(range, fromDay, toDay, today)
  const tod = todOf(span, timeFrom, timeTo)

  // only the custom range can be incomplete or out of bounds — say so in Thai
  // instead of letting the server 400.
  const fromMs = dayToMs(period.from)
  const toMs = dayToMs(period.to)
  const periodError =
    range !== 'custom'
      ? null
      : period.from === '' || period.to === ''
        ? 'เลือกวันเริ่มต้นและวันสิ้นสุดก่อน'
        : fromMs === null || toMs === null
          ? 'รูปแบบวันที่ไม่ถูกต้อง'
          : toMs < fromMs
            ? 'วันสิ้นสุดต้องไม่ก่อนวันเริ่มต้น'
            : (toMs - fromMs) / DAY_MS + 1 > MAX_DAYS
              ? `ดูย้อนหลังได้ไม่เกิน ${MAX_DAYS} วันต่อครั้ง`
              : null

  const query = shopId === '' || periodError !== null ? null : buildQuery(period, tod, menuItemId, optionId, ingredientId)

  // every filter change refetches at once; stale answers are dropped by seq.
  useEffect(() => {
    if (query === null) return
    const mine = ++seq.current
    let on = true
    setBusy(true)
    void (async () => {
      try {
        const d = await api<ReportData>('GET', `/api/owner/shops/${encodeURIComponent(shopId)}/report${query}`)
        if (!on || mine !== seq.current) return
        setData(d)
        setMsg('')
      } catch (e) {
        if (!on || mine !== seq.current) return
        setData(null)
        setMsg(friendlyError(e))
      } finally {
        if (on && mine === seq.current) setBusy(false)
      }
    })()
    return () => {
      on = false
    }
  }, [shopId, query, nonce])

  // ---- derived dropdown rows ----

  const items = [...(menu?.items ?? [])].sort((a, b) => a.sort_order - b.sort_order)
  // choices of a type = the options of the lists that belong to that type
  const typeGroups = new Set(
    (menu?.option_groups ?? []).filter((g) => g.menu_item_id === menuItemId).map((g) => g.id),
  )
  const choices = menuItemId === ''
    ? []
    : menu === null
      ? []
      : [...menu.options]
          .filter((o) => typeGroups.has(o.option_group_id))
          .sort((a, b) => a.sort_order - b.sort_order)
  const ingredients = stock?.ingredients ?? []
  const itemName = (id: string): string | undefined => menu?.items.find((i) => i.id === id)?.name
  const optionName = (id: string): string | undefined => menu?.options.find((o) => o.id === id)?.name
  const ingredientName = (id: string): string | undefined =>
    stock?.ingredients.find((i) => i.id === id)?.name

  const canClear =
    span !== 'all' || timeFrom !== '' || timeTo !== '' || menuItemId !== '' || optionId !== '' || ingredientId !== ''

  function clearFilters() {
    setSpan('all')
    setTimeFrom('')
    setTimeTo('')
    setMenuItemId('')
    setOptionId('')
    setIngredientId('')
  }

  // the month box mirrors the custom pair: filled only when it IS one month
  const wholeMonth =
    period.from !== '' && period.to !== '' && period.from === monthStart(monthOf(period.from)) && period.to === monthEnd(monthOf(period.from))
      ? monthOf(period.from)
      : ''

  const timeLabel =
    tod.from === null && tod.to === null
      ? null
      : `${tod.from === null ? '00:00' : minutesLabel(tod.from)}–${tod.to === null ? '24:00' : minutesLabel(tod.to)}`

  // what the numbers below are filtered by, in one short line
  const filterBits: string[] = []
  if (timeLabel !== null) filterBits.push(`เวลา ${timeLabel} น.`)
  if (menuItemId !== '') {
    filterBits.push(itemName(menuItemId) ?? 'ประเภทที่เลือก')
    if (optionId !== '') filterBits.push(optionName(optionId) ?? 'ตัวเลือกที่เลือก')
  }
  if (ingredientId !== '') filterBits.push(ingredientName(ingredientId) ?? 'วัตถุดิบที่เลือก')

  const s = data?.summary
  const hasBills = (data?.bills.length ?? 0) > 0

  // the period of the loaded report, as the KPI footnote shows it
  const periodLabel =
    data === null
      ? ''
      : data.from === data.to
        ? fmtDayLong(data.from)
        : `${fmtDayMonth(data.from)} – ${fmtDayLong(data.to)}`

  return (
    <section className="dash">
      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}
      {shopErr ? <p className="error small">{shopErr}</p> : null}
      {periodError ? <p className="error small">{periodError}</p> : null}
      {srcErr ? <p className="error small">{srcErr}</p> : null}

      {/* ================= filter bar (compact, refetch on every change) ================= */}
      <section className="card dash-card dash-filters" aria-label="ตัวกรองรายงาน">
        <div className="dash-tools">
          <div className="dash-seg" role="group" aria-label="ช่วงวันที่">
            {RANGES.map((r) => (
              <button
                type="button"
                key={r.id}
                className={range === r.id ? 'on' : ''}
                title={r.label}
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
              >
                {r.short}
              </button>
            ))}
          </div>
          <span className="dash-spacer" aria-hidden="true" />
          {busy ? <span className="muted small dash-busy">กำลังโหลด…</span> : null}
          <button
            type="button"
            className="btn ghost dash-mini"
            disabled={busy || shopId === '' || query === null}
            onClick={() => setNonce((n) => n + 1)}
          >
            <Icon name="refresh" size={15} />
            รีเฟรช
          </button>
        </div>

        {range === 'custom' ? (
          <div className="dash-tools dash-inline">
            <label className="dash-field">
              <span>จาก</span>
              <input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
            </label>
            <label className="dash-field">
              <span>ถึง</span>
              <input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
            </label>
            <label className="dash-field">
              <span>ทั้งเดือน</span>
              <input
                type="month"
                value={wholeMonth}
                onChange={(e) => {
                  const m = e.target.value
                  setFromDay(m === '' ? '' : monthStart(m))
                  setToDay(m === '' ? '' : monthEnd(m))
                }}
              />
            </label>
          </div>
        ) : null}

        <div className="dash-tools">
          <div className="dash-seg" role="group" aria-label="ช่วงเวลา">
            {SPANS.map((sp) => (
              <button
                type="button"
                key={sp.id}
                className={span === sp.id ? 'on' : ''}
                title={sp.label}
                aria-pressed={span === sp.id}
                onClick={() => setSpan(sp.id)}
              >
                {sp.short}
              </button>
            ))}
          </div>
          <label className="dash-field">
            <span>เมนู</span>
            <select
              value={menuItemId}
              onChange={(e) => {
                setMenuItemId(e.target.value)
                setOptionId('') // a choice only means something for its type
              }}
            >
              <option value="">ทุกประเภท</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
          </label>
          {menuItemId !== '' ? (
            <label className="dash-field">
              <span>ตัวเลือก</span>
              <select value={optionId} onChange={(e) => setOptionId(e.target.value)}>
                <option value="">ทุกตัวเลือก</option>
                {choices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="dash-field">
            <span>วัตถุดิบ</span>
            <select value={ingredientId} onChange={(e) => setIngredientId(e.target.value)}>
              <option value="">ทุกวัตถุดิบ</option>
              {ingredients.map((ing) => (
                <option key={ing.id} value={ing.id}>
                  {ing.name}
                </option>
              ))}
            </select>
          </label>
          <span className="dash-spacer" aria-hidden="true" />
          <button type="button" className="btn ghost dash-mini" disabled={!canClear} onClick={clearFilters}>
            <Icon name="x" size={15} />
            ล้างตัวกรอง
          </button>
        </div>

        {span === 'custom' ? (
          <div className="dash-tools dash-inline">
            <label className="dash-field">
              <span>จาก</span>
              <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
            </label>
            <label className="dash-field">
              <span>ถึง</span>
              <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
            </label>
          </div>
        ) : null}

        {filterBits.length > 0 ? <p className="muted small dash-active">กรองอยู่: {filterBits.join(' · ')}</p> : null}
      </section>

      {/* ================= results ================= */}
      {shopId !== '' && data === null && msg === '' && periodError === null ? (
        <p className="muted">กำลังโหลดสรุปยอด…</p>
      ) : null}

      {data !== null && !hasBills ? (
        <section className="card dash-card dash-empty">
          <span className="dash-ic">
            <Icon name="receipt" />
          </span>
          <p className="muted">ไม่มีบิลในช่วงนี้</p>
        </section>
      ) : null}
      {data !== null && !hasBills && data.stock_check.length > 0 ? <StockCheck rows={data.stock_check} /> : null}

      {data !== null && s !== undefined && hasBills ? (
        <>
          {/* ---------- KPI cards ---------- */}
          <div className="dash-kpis">
            <Kpi icon="banknote" label="ยอดสุทธิ" value={`฿${fmtBaht(s.net)}`} note={`คืนเงิน ฿${fmtBaht(s.refunds)}`} tone="accent" />
            <Kpi icon="receipt" label="บิลที่จ่าย" value={`${s.bills} บิล`} note={`ยกเลิก ${s.cancelled} บิล`} />
            <Kpi icon="bowl" label="จานที่ขาย" value={`${s.plates} จาน`} note={periodLabel} />
            <Kpi icon="calc" label="เฉลี่ยต่อบิล" value={`฿${fmtBaht(s.avg_bill)}`} note={`ยังไม่ปิด ${s.open} บิล`} />
          </div>

          {/* ---------- charts + "needs attention" ---------- */}
          <div className="dash-cols">
            <div className="dash-col">
              <section className="card dash-card">
                <div className="dash-head">
                  <h2>ยอดตามชั่วโมง</h2>
                  <p className="muted small">{data.by_hour.length > 0 ? `${data.by_hour.length} ชั่วโมงที่มีขาย` : 'ไม่มีข้อมูล'}</p>
                </div>
                {data.by_hour.length === 0 ? (
                  <p className="muted small">ไม่มีข้อมูล</p>
                ) : (
                  <BarList
                    rows={data.by_hour.map((h) => ({
                      key: String(h.hour),
                      label: `${p2(h.hour)}:00`,
                      bills: h.bills,
                      net: h.net,
                    }))}
                  />
                )}
              </section>

              <section className="card dash-card">
                <div className="dash-head">
                  <h2>ยอดรายวัน</h2>
                  <p className="muted small">{data.by_day.length > 1 ? `${data.by_day.length} วัน` : ''}</p>
                </div>
                {data.by_day.length > 1 ? (
                  <BarList
                    rows={data.by_day.map((d) => ({ key: d.day, label: fmtDayMonth(d.day), bills: d.bills, net: d.net }))}
                  />
                ) : (
                  <p className="muted small">เลือกช่วงวันที่หลายวันเพื่อดูยอดแยกรายวัน</p>
                )}
              </section>
            </div>

            <section className="card dash-card">
              <div className="dash-head">
                <h2>ต้องดู</h2>
                <p className="muted small">จากช่วงที่เลือก</p>
              </div>
              <div className="dash-attn">
                {attentionRows(data).map((r) => (
                  <div className="dash-attn-row" key={r.id}>
                    <span className={`dash-ic${r.tone === '' ? '' : ` ${r.tone}`}`}>
                      <Icon name={r.icon} size={16} />
                    </span>
                    <span className="dash-attn-text">
                      <strong>{r.title}</strong>
                      <span className="muted small">{r.sub}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* ---------- payment methods + staff meals ---------- */}
          <div className="dash-cols even">
            <section className="card dash-card">
              <div className="dash-head">
                <h2>วิธีชำระเงิน</h2>
                <p className="muted small">บิลที่จ่ายแล้ว</p>
              </div>
              {data.by_method.length === 0 ? (
                <p className="muted small">ไม่มีข้อมูล</p>
              ) : (
                <BarList
                  rows={data.by_method.map((m) => ({
                    key: m.method,
                    label: METHOD_LABELS[m.method] ?? m.method,
                    bills: m.bills,
                    net: m.net,
                  }))}
                />
              )}
            </section>

            <section className="card dash-card">
              <div className="dash-head">
                <h2>สวัสดิการพนักงาน</h2>
                <p className="muted small">ไม่นับเป็นยอดขาย · วันละ 2 จาน/คน</p>
              </div>
              {data.staff_meals.length === 0 ? (
                <p className="muted small">ไม่มีในช่วงนี้</p>
              ) : (
                <TableBox head={[{ text: 'พนักงาน' }, { text: 'จาน', num: true }, { text: 'มูลค่า ฿', num: true }]}>
                  {data.staff_meals.map((r) => (
                    <Row
                      key={r.user_id}
                      cells={[
                        { text: r.name },
                        { text: String(r.plates), num: true },
                        { text: fmtBaht(r.value), num: true },
                      ]}
                    />
                  ))}
                </TableBox>
              )}
            </section>
          </div>

          {/* ---------- table cards ---------- */}
          <section className="card dash-card">
            <div className="dash-head">
              <h2>เมนูขายดี</h2>
              <p className="muted small">{data.menu.length} รายการ</p>
            </div>
            {data.menu.length === 0 ? (
              <p className="muted small">ไม่มีข้อมูล</p>
            ) : (
              <TableBox head={[{ text: 'เมนู' }, { text: 'จาน', num: true }, { text: 'ยอด ฿', num: true }]}>
                {data.menu.map((r) => (
                  <Row
                    key={r.menu_item_id}
                    cells={[
                      { text: r.name },
                      { text: String(r.qty), num: true },
                      { text: fmtBaht(r.amount), num: true },
                    ]}
                  />
                ))}
              </TableBox>
            )}
          </section>

          <section className="card dash-card">
            <div className="dash-head">
              <h2>ตัวเลือกที่ถูกเลือก</h2>
              <p className="muted small">{data.choices.length} รายการ</p>
            </div>
            {data.choices.length === 0 ? (
              <p className="muted small">ไม่มีข้อมูล</p>
            ) : (
              <TableBox head={[{ text: 'ตัวเลือก' }, { text: 'จำนวน', num: true }]}>
                {data.choices.map((r) => {
                  const type = itemName(r.menu_item_id)
                  return (
                    <Row
                      key={`${r.option_id}-${r.menu_item_id}`}
                      cells={[
                        { text: type === undefined ? r.name : `${r.name} · ${type}` },
                        { text: String(r.qty), num: true },
                      ]}
                    />
                  )
                })}
              </TableBox>
            )}
          </section>

          <section className="card dash-card">
            <div className="dash-head">
              <h2>วัตถุดิบที่ใช้</h2>
              <p className="muted small">{data.ingredients.length} รายการ</p>
            </div>
            {data.ingredients.length === 0 ? (
              <p className="muted small">ไม่มีข้อมูล</p>
            ) : (
              <TableBox head={[{ text: 'วัตถุดิบ' }, { text: 'ใช้ไป', num: true }, { text: 'สวัสดิการ', num: true }]}>
                {data.ingredients.map((r) => (
                  <Row
                    key={r.ingredient_id}
                    cells={[
                      { text: r.name },
                      { text: fmtUsed(r.used, r.unit), num: true },
                      { text: r.staff_used > 0 ? fmtUsed(r.staff_used, r.unit) : '—', num: true },
                    ]}
                  />
                ))}
              </TableBox>
            )}
          </section>

          <StockCheck rows={data.stock_check} />

          {/* ---------- bills ---------- */}
          <section className="card dash-card">
            <div className="dash-head">
              <h2>บิล ({data.bills.length})</h2>
              {data.bills.length >= data.bills_capped_at ? (
                <span className="badge pending">แสดง {data.bills_capped_at} บิลล่าสุด</span>
              ) : null}
            </div>
            <div className="dash-bills">
              <div className="dash-bill-head" aria-hidden="true">
                <span>เวลา</span>
                <span>คิว</span>
                <span>ช่องทาง</span>
                <span>รายการ</span>
                <span>ยอด</span>
                <span>สถานะ</span>
              </div>
              {data.bills.map((b) => {
                const tone = billStatusTone(b.status)
                return (
                  <div
                    className="dash-bill"
                    key={b.id}
                    aria-label={`บิล #${b.queue_number} ${fmtBillStamp(b.created_at)} ${
                      CHANNEL_LABELS[b.channel] ?? b.channel
                    } ${b.lines ?? ''} ฿${fmtBaht(b.net)} ${billStatusLabel(b.status)}`}
                  >
                    <span className="dash-bill-time">{fmtBillStamp(b.created_at)}</span>
                    <span className="dash-bill-q">#{b.queue_number}</span>
                    <span className="dash-bill-ch">{CHANNEL_LABELS[b.channel] ?? b.channel}</span>
                    <span className="dash-bill-lines">{b.lines ?? '—'}</span>
                    <span className="dash-bill-amt">฿{fmtBaht(b.net)}</span>
                    <span className={`dash-bill-status ${tone}`}>
                      <span className={`status-dot ${tone}`} aria-hidden="true" />
                      {billStatusLabel(b.status)}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        </>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// "ต้องดู": what the loaded report says the owner should look at — cancelled
// bills, refunds, bills still open, hours without a single sale and the
// ingredient the period consumed the most. Nothing here fetches anything.
// ---------------------------------------------------------------------------

interface AttentionRow {
  id: string
  icon: IconName
  tone: '' | 'accent' | 'ok' | 'warn' | 'bad'
  title: string
  sub: string
}

function attentionRows(d: ReportData): AttentionRow[] {
  const out: AttentionRow[] = []
  const s = d.summary

  if (s.cancelled > 0) {
    const closed = s.bills + s.cancelled
    out.push({
      id: 'cancelled',
      icon: 'x-circle',
      tone: 'bad',
      title: `ยกเลิกไป ${s.cancelled} บิล`,
      sub: closed > 0 ? `${Math.round((s.cancelled / closed) * 100)}% ของบิลที่ปิดแล้ว` : '',
    })
  }
  if (s.refunds > 0) {
    out.push({
      id: 'refunds',
      icon: 'refund',
      tone: 'warn',
      title: `คืนเงิน ฿${fmtBaht(s.refunds)}`,
      sub: 'หักออกจากยอดสุทธิแล้ว',
    })
  }
  if (s.open > 0) {
    out.push({
      id: 'open',
      icon: 'hourglass',
      tone: 'warn',
      title: `ยังไม่ปิด ${s.open} บิล`,
      sub: 'ยังไม่ได้เก็บเงิน',
    })
  }

  // hours with no bill at all inside the window the shop was selling in
  const hours = d.by_hour.filter((h) => h.bills > 0).map((h) => h.hour)
  if (hours.length >= 2) {
    const first = Math.min(...hours)
    const last = Math.max(...hours)
    const selling = new Set(hours)
    const gaps: number[] = []
    for (let h = first; h <= last; h++) if (!selling.has(h)) gaps.push(h)
    if (gaps.length > 0) {
      const shown = gaps.slice(0, 4).map((h) => `${p2(h)}:00`).join(' ')
      out.push({
        id: 'gaps',
        icon: 'alert',
        tone: 'warn',
        title: 'มีชั่วโมงที่ไม่มียอดขาย',
        sub: `${shown}${gaps.length > 4 ? ' ฯลฯ' : ''} · ช่วงขาย ${p2(first)}:00–${p2(last)}:00`,
      })
    }
  }

  if (d.ingredients.length > 0) {
    const top = d.ingredients.reduce((a, b) => (b.used > a.used ? b : a))
    out.push({
      id: 'ingredient',
      icon: 'box',
      tone: 'accent',
      title: top.name,
      sub: `ใช้ไป ${fmtUsed(top.used, top.unit)} · มากที่สุดในช่วงนี้`,
    })
  }

  if (out.length === 0) {
    out.push({ id: 'ok', icon: 'check', tone: 'ok', title: 'ไม่มีอะไรต้องตาม', sub: 'ยอดขายช่วงนี้ไม่มีจุดที่น่าสนใจ' })
  }
  return out
}

// ---------------------------------------------------------------------------
// One KPI card: icon chip + muted label, the big number, a divider + footnote
// ---------------------------------------------------------------------------

function Kpi({
  icon,
  label,
  value,
  note,
  tone = '',
}: {
  icon: IconName
  label: string
  value: string
  note: string
  tone?: '' | 'accent'
}) {
  return (
    <section className="card dash-card dash-kpi">
      <div className="dash-kpi-top">
        <span className={`dash-ic${tone === '' ? '' : ` ${tone}`}`}>
          <Icon name={icon} size={16} />
        </span>
        <span className="muted small dash-kpi-label">{label}</span>
      </div>
      <span className="dash-kpi-val">{value}</span>
      <p className="muted small dash-kpi-note">{note}</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Bar list: one row per day / hour, the fill relative to the biggest value
// ---------------------------------------------------------------------------

function BarList({ rows }: { rows: Array<{ key: string; label: string; bills: number; net: number }> }) {
  const max = Math.max(0, ...rows.map((r) => r.net))
  return (
    <div className="dash-hbars">
      {rows.map((r) => {
        const pct = max > 0 && r.net > 0 ? Math.max(1, Math.round((r.net / max) * 100)) : 0
        return (
          <div className="dash-hbar" key={r.key}>
            <span className="dash-hbar-label">{r.label}</span>
            <span className="dash-hbar-track" aria-hidden="true">
              <span className="dash-hbar-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="dash-hbar-val">
              ฿{fmtBaht(r.net)} ({r.bills} บิล)
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Compact tables (numbers right-aligned; the box scrolls, the page doesn't)
// ---------------------------------------------------------------------------

function TableBox({ head, children }: { head: Array<{ text: string; num?: boolean }>; children: ReactNode }) {
  return (
    <div className="dash-scroll">
      <table className="dash-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h.text} className={i === 0 || h.num !== true ? '' : 'num'}>
                {h.text}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Row({ cells }: { cells: Array<{ text: string; num?: boolean }> }) {
  return (
    <tr>
      {cells.map((c, i) => (
        <td key={i} className={c.num === true ? 'num' : ''}>
          {c.text}
        </td>
      ))}
    </tr>
  )
}
