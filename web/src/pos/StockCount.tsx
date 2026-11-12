//! Staff stock counting screen — the third bottom-nav tab of the counter.
//!
//! The sheet is BLIND on purpose (FEATURES 3.37/3.40): the running `qty` in
//! the database is only an estimate that drifts all day (deducted per plate
//! sold — nobody weighs a spatula), so the server never sends it here. What
//! the staff gets is what is on the shelf: name, unit, when it was counted
//! last, and a number box. Filled boxes only — a half-counted sheet is a
//! valid sheet, and counting fixes the drift.
//!
//! Submission is idempotent exactly like the order/payment client ids in
//! Counter: every entry mints a `move_id` the first time its sheet is sent
//! and keeps it until the server answers "saved", so a retry after a network
//! error can never write the same count twice.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, errorCode, friendlyError } from '../api'
import { onRefreshRequest } from './dataRefresh'

// ---------------------------------------------------------------------------
// API shapes (GET /api/stock/count-sheet, POST /api/stock/count)
// ---------------------------------------------------------------------------

/** One sheet row: identification only — `qty` is deliberately absent (blind count). */
interface CountSheetRow {
  id: string
  name: string
  unit: string
  /** MAX(created_at) of this ingredient's count moves; null = never counted. */
  last_count_at: number | null
}

interface CountSheetData {
  ingredients: CountSheetRow[]
}

/** POST body entry: `move_id` is the client id that makes a retry idempotent. */
interface CountEntry {
  move_id: string
  ingredient_id: string
  qty: number
}

interface CountSaved {
  saved: number
}

type Note = { text: string; tone: 'ok' | 'err' } | null

/** Server bounds mirrored client-side (api/src/routes/stock_count.rs, stock.rs). */
const MAX_COUNTS = 100
const MAX_QTY = 10_000_000

/** How often the "นับล่าสุด: x นาทีที่แล้ว" labels catch up. */
const NOW_TICK_MS = 30_000

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const BANGKOK_TZ = 'Asia/Bangkok'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** "" -> null (not counted, never sent), unparsable/negative/too big -> 'bad'. */
function parseQty(text: string): number | 'bad' | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  if (!Number.isFinite(n)) return 'bad'
  if (n < 0 || n > MAX_QTY) return 'bad'
  return n
}

/** "เมื่อสักครู่" / "7 นาทีที่แล้ว" / "2 ชม.ที่แล้ว" / "3 วันที่แล้ว" / "12 ม.ค. 14:05". */
function lastCountLabel(at: number | null, now: number): string {
  if (at === null) return 'ยังไม่เคยนับ'
  const ago = now - at
  if (ago < MINUTE_MS) return 'เมื่อสักครู่'
  if (ago < HOUR_MS) return `${Math.floor(ago / MINUTE_MS)} นาทีที่แล้ว`
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} ชม.ที่แล้ว`
  if (ago < 7 * DAY_MS) return `${Math.floor(ago / DAY_MS)} วันที่แล้ว`
  try {
    // Bangkok clock: the device may sit in another timezone
    return new Intl.DateTimeFormat('th-TH', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: BANGKOK_TZ,
    }).format(new Date(at))
  } catch {
    return new Date(at).toLocaleString('th-TH')
  }
}

// ---------------------------------------------------------------------------
// StockCount
// ---------------------------------------------------------------------------

export default function StockCount({
  onSessionExpired,
  onRevoked,
}: {
  /** A staff call answered session_invalid -> re-lock to the PIN screen. */
  onSessionExpired: () => void
  /** This device was revoked remotely -> wipe and lock. */
  onRevoked: () => void
}) {
  const [rows, setRows] = useState<CountSheetRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [busy, setBusy] = useState(false)
  /** Raw input text per ingredient id ("" = not counted). Kept on failure. */
  const [values, setValues] = useState<Record<string, string>>({})
  /** move_id per ingredient id: minted on the first submit, reused on retry. */
  const [moveIds, setMoveIds] = useState<Record<string, string>>({})
  const [note, setNote] = useState<Note>(null)
  /** Clock behind the relative "นับล่าสุด" labels. */
  const [now, setNow] = useState(() => Date.now())

  // latest logout callbacks without re-creating the loader below
  const expiredRef = useRef(onSessionExpired)
  const revokedRef = useRef(onRevoked)
  useEffect(() => {
    expiredRef.current = onSessionExpired
    revokedRef.current = onRevoked
  })

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS)
    return () => window.clearInterval(t)
  }, [])

  /** Latest rows without re-creating the loader (a silent refresh keeps them). */
  const rowsRef = useRef<CountSheetRow[] | null>(null)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  /** Loads the sheet. `silent` refreshes the rows without blanking the list. */
  const loadSheet = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true)
    try {
      const d = await api<CountSheetData>('GET', '/api/stock/count-sheet', undefined, 'both')
      setRows(d.ingredients)
      setLoadErr('')
    } catch (e) {
      if (errorCode(e) === 'session_invalid') return expiredRef.current()
      if (errorCode(e) === 'device_revoked') return revokedRef.current()
      // a silent refresh keeps the stale rows (and the typed numbers) on
      // screen; the error only matters when there is no sheet to show yet
      if (rowsRef.current === null) setLoadErr(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSheet(false)
  }, [loadSheet])

  // The manual ⋮ "รีเฟรชข้อมูล" also refreshes these rows — NEVER the numbers
  // already typed into the boxes (only `rows` reloads; `values` stays). No
  // timed polling on this tab.
  useEffect(() => onRefreshRequest(() => void loadSheet(true)), [loadSheet])

  /** One draft per filled box; `bad` marks text that is not a usable number. */
  const drafts = useMemo(() => {
    const out: Array<{ row: CountSheetRow; qty: number; bad: boolean }> = []
    for (const row of rows ?? []) {
      const q = parseQty(values[row.id] ?? '')
      if (q === null) continue // not filled: never sent
      out.push(q === 'bad' ? { row, qty: 0, bad: true } : { row, qty: q, bad: false })
    }
    return out
  }, [rows, values])

  const ready = drafts.filter((d) => !d.bad)
  const badCount = drafts.length - ready.length

  async function submit() {
    if (busy || ready.length === 0) return
    if (badCount > 0) {
      setNote({ text: 'มีช่องที่ใส่ตัวเลขไม่ได้ — แก้หรือลบตัวเลขนั้นก่อนบันทึก', tone: 'err' })
      return
    }
    if (ready.length > MAX_COUNTS) {
      setNote({ text: `บันทึกได้ครั้งละ ${MAX_COUNTS} รายการ — บันทึกเป็นสองรอบ`, tone: 'err' })
      return
    }
    // Mint the missing move ids ONCE and remember them: a retry after a
    // network error reuses the same ids, so the same count is never written
    // twice (3.70). They are dropped only after the server said "saved".
    const ids = { ...moveIds }
    for (const d of ready) {
      if (!ids[d.row.id]) ids[d.row.id] = crypto.randomUUID()
    }
    setMoveIds(ids)
    const counts: CountEntry[] = ready.map((d) => ({
      move_id: ids[d.row.id],
      ingredient_id: d.row.id,
      qty: d.qty,
    }))

    setBusy(true)
    try {
      const r = await api<CountSaved>('POST', '/api/stock/count', { counts }, 'both')
      setNote({ text: `บันทึกแล้ว ${r.saved} รายการ`, tone: 'ok' })
      setValues({}) // fresh sheet; the counted numbers are now the journal's
      setMoveIds({})
      void loadSheet(true) // refresh "นับล่าสุด" without flashing the list away
    } catch (e) {
      if (errorCode(e) === 'session_invalid') return expiredRef.current()
      if (errorCode(e) === 'device_revoked') return revokedRef.current()
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        // inputs and move ids stay: pressing the button again is the retry
        setNote({ text: 'เน็ตหลุด ลองกดบันทึกอีกครั้ง', tone: 'err' })
      } else if (e instanceof ApiError) {
        setNote({ text: e.message, tone: 'err' }) // 4xx: the server says why
      } else {
        setNote({ text: friendlyError(e), tone: 'err' })
      }
    } finally {
      setBusy(false)
    }
  }

  const list = rows ?? []
  const empty = !loading && !loadErr && list.length === 0

  return (
    <div className="pos-count">
      <header className="pos-count-head">
        <h2 className="pos-count-title">นับสต็อก</h2>
        <p className="pos-count-hint">
          นับของจริงบนชั้น แล้วใส่ตัวเลข — ใส่เฉพาะที่นับ ไม่ต้องครบทุกอย่าง
        </p>
      </header>

      {loadErr ? (
        <div className="pos-count-state">
          <p className="error" role="alert">
            {loadErr}
          </p>
          <button type="button" className="pos-count-retry" onClick={() => void loadSheet(false)}>
            ลองใหม่
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="pos-count-state">
          <div className="spinner" aria-hidden="true" />
          <p className="muted">กำลังโหลดรายการวัตถุดิบ…</p>
        </div>
      ) : null}

      {empty ? (
        <div className="pos-count-state">
          <p className="muted">ยังไม่มีวัตถุดิบ — ให้เจ้าของเพิ่มในหน้า สต็อก</p>
        </div>
      ) : null}

      {!loadErr && !loading ? (
        <div className="pos-count-list">
          {list.map((row) => {
            const raw = values[row.id] ?? ''
            const q = parseQty(raw)
            const bad = q === 'bad'
            return (
              <div key={row.id} className={`pos-count-row${q !== null ? ' filled' : ''}`}>
                <div className="pos-count-info">
                  <span className="pos-count-name">
                    {row.name}
                    {row.unit ? <span className="pos-count-unit-tag">{row.unit}</span> : null}
                  </span>
                  <span className="pos-count-meta">
                    นับล่าสุด: {lastCountLabel(row.last_count_at, now)}
                  </span>
                </div>
                <label className={`pos-count-field${bad ? ' bad' : ''}`}>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={raw}
                    placeholder="—"
                    aria-label={`จำนวน ${row.name} ที่นับได้ (${row.unit})`}
                    onChange={(e) => {
                      const text = e.target.value
                      setValues((v) => ({ ...v, [row.id]: text }))
                      // a NEW number is a new count: never replay it under the
                      // id of the earlier (maybe already saved) value
                      setMoveIds((m) => {
                        if (!(row.id in m)) return m
                        const { [row.id]: _dropped, ...rest } = m
                        return rest
                      })
                      setNote(null)
                    }}
                  />
                  <span className="pos-count-unit">{row.unit}</span>
                </label>
              </div>
            )
          })}
        </div>
      ) : null}

      {!loadErr && !loading && !empty ? (
        <div className="pos-count-save">
          {note ? (
            <p
              className={`pos-count-note ${note.tone === 'ok' ? 'ok' : 'err'}`}
              role={note.tone === 'ok' ? 'status' : 'alert'}
            >
              {note.text}
            </p>
          ) : (
            <p className="pos-count-note">ใส่เฉพาะช่องที่นับแล้ว แล้วกดบันทึกได้เลย</p>
          )}
          <button
            type="button"
            className="pos-count-submit"
            disabled={ready.length === 0 || busy}
            onClick={() => void submit()}
          >
            {busy ? 'กำลังบันทึก…' : `บันทึกการนับ (${ready.length} รายการ)`}
          </button>
        </div>
      ) : null}
    </div>
  )
}
