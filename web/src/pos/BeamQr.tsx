// Real PromptPay QR through Beam. The server creates the charge for the bill's
// own total (POST /api/orders/{id}/promptpay) and the bill closes only when
// Beam says the money arrived - by webhook, or by the status check this panel
// polls. There is no "customer paid" button on purpose.
//
// Idempotent like every other write here: one payment id per QR. A retry
// after a network error reuses it (Beam returns the same charge); only
// "สร้าง QR ใหม่" after an expiry/refusal mints a new one.

import { useEffect, useMemo, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { ApiError, api, errorCode, friendlyError } from '../api'
import type { Order } from '../api'

export interface QrPayment {
  id: string
  amount: number
  /** pending | succeeded | expired */
  status: string
  qr_raw: string | null
  qr_expiry: string | null
}

export interface QrResult {
  order: Order
  payment: QrPayment
}

const POLL_MS = 3000
/** Same prefix as MOCK_PREFIX in api/src/beam.rs: the dev-only fake Beam. */
const MOCK_PREFIX = 'MOCK-DEV'

function fmtBaht(satang: number): string {
  return `฿${(satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`
}

/** The EMV payload as an SVG path (crisp at any size, no image request). */
function QrSvg({ data }: { data: string }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(data, 'Byte')
    q.make()
    const n = q.getModuleCount()
    let d = ''
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`
    }
    return { n, d }
  }, [data])
  return (
    <svg
      viewBox={`-2 -2 ${n + 4} ${n + 4}`}
      width="220"
      height="220"
      role="img"
      aria-label="QR พร้อมเพย์"
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

function secondsLeft(expiry: string | null, now: number): number | null {
  if (!expiry) return null
  // Beam sends nanoseconds ("…:54.495036373+07:00"); Safari only parses ms
  const t = Date.parse(expiry.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(t) ? Math.max(0, Math.floor((t - now) / 1000)) : null
}

export default function BeamQr({
  order,
  onPaid,
  onSessionExpired,
  onRevoked,
}: {
  order: Order
  onPaid: (r: QrResult) => void
  onSessionExpired: () => void
  onRevoked: () => void
}) {
  const [paymentId, setPaymentId] = useState(() => crypto.randomUUID())
  const [qr, setQr] = useState<QrPayment | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  /** Bumped by "ลองอีกครั้ง": re-sends the SAME payment id. */
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const paidRef = useRef(false)
  const cb = useRef({ onPaid, onSessionExpired, onRevoked })
  useEffect(() => {
    cb.current = { onPaid, onSessionExpired, onRevoked }
  })

  /** true when the error logged the device out (caller stops). */
  function sessionGone(e: unknown): boolean {
    if (errorCode(e) === 'session_invalid') {
      cb.current.onSessionExpired()
      return true
    }
    if (errorCode(e) === 'device_revoked') {
      cb.current.onRevoked()
      return true
    }
    return false
  }

  function apply(r: QrResult) {
    setQr(r.payment)
    if (r.payment.status === 'succeeded' && !paidRef.current) {
      paidRef.current = true
      cb.current.onPaid(r)
    }
  }

  // create (or re-fetch, same id) the charge
  useEffect(() => {
    let live = true
    setCreating(true)
    setErr('')
    api<QrResult>(
      'POST',
      `/api/orders/${encodeURIComponent(order.id)}/promptpay`,
      { payment_id: paymentId },
      'both',
    )
      .then((r) => {
        if (live) apply(r)
      })
      .catch((e: unknown) => {
        if (!live || sessionGone(e)) return
        if (e instanceof ApiError && (e.status === 0 || e.status >= 500) && errorCode(e) !== 'beam_rejected') {
          setErr('เชื่อมต่อ Beam ไม่ได้ — กด "ลองอีกครั้ง" (ไม่มีการเก็บเงินซ้ำ)')
        } else {
          setErr(friendlyError(e))
        }
      })
      .finally(() => {
        if (live) setCreating(false)
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, paymentId, attempt])

  // poll while the QR is up
  const charged = qr !== null && qr.status === 'pending' && qr.qr_raw !== null
  useEffect(() => {
    if (!charged) return
    const qid = qr.id
    const t = window.setInterval(() => {
      api<QrResult>(
        'GET',
        `/api/orders/${encodeURIComponent(order.id)}/promptpay/${encodeURIComponent(qid)}`,
        undefined,
        'both',
      )
        .then(apply)
        .catch((e: unknown) => {
          sessionGone(e) // anything else: keep polling, the QR stays valid
        })
    }, POLL_MS)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charged, order.id, qr?.id])

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const left = secondsLeft(qr?.qr_expiry ?? null, now)
  const timedOut = left === 0
  const refused = qr?.status === 'expired'

  function retry() {
    // same payment id: Beam's idempotency returns the same charge
    setQr(null)
    setAttempt((a) => a + 1)
  }

  function newQr() {
    setQr(null)
    setErr('')
    setPaymentId(crypto.randomUUID())
  }

  if (err) {
    return (
      <div className="pos-qr">
        <p className="error" role="alert">
          {err}
        </p>
        <button type="button" className="pos-qr-btn" disabled={creating} onClick={retry}>
          {creating ? 'กำลังลอง…' : 'ลองอีกครั้ง'}
        </button>
        <span className="muted small">หรือรับเงินสดแทน</span>
      </div>
    )
  }

  if (!qr || !qr.qr_raw) {
    return (
      <div className="pos-qr">
        <div className="pos-qr-box pos-qr-wait">
          <div className="spinner" aria-hidden="true" />
        </div>
        <span className="muted small">กำลังสร้าง QR…</span>
      </div>
    )
  }

  return (
    <div className="pos-qr">
      {qr.qr_raw.startsWith(MOCK_PREFIX) && (
        <span className="error small" role="note">
          โหมดทดสอบ (mock) — ไม่ใช่ QR จริง ระบบจะ "จ่ายสำเร็จ" เองประมาณ 12 วินาที
        </span>
      )}
      <div className={`pos-qr-box${timedOut || refused ? ' dim' : ''}`}>
        <QrSvg data={qr.qr_raw} />
      </div>
      <span className="pos-qr-amount">{fmtBaht(qr.amount)}</span>
      {refused ? (
        <>
          <span className="error">QR นี้ใช้ไม่ได้แล้ว</span>
          <button type="button" className="pos-qr-btn" onClick={newQr}>
            สร้าง QR ใหม่
          </button>
        </>
      ) : timedOut ? (
        <>
          <span className="muted small">QR หมดอายุ — ถ้าลูกค้าโอนไปแล้ว ระบบยังรับยอดให้อัตโนมัติ</span>
          <button type="button" className="pos-qr-btn" onClick={newQr}>
            สร้าง QR ใหม่
          </button>
        </>
      ) : (
        <span className="pos-qr-wait-text" role="status">
          <span className="pos-qr-dot" aria-hidden="true" />
          รอลูกค้าสแกนจ่าย…
          {left !== null ? ` · หมดอายุใน ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ''}
        </span>
      )}
      <span className="muted small">บิลปิดเองเมื่อเงินเข้า Beam</span>
    </div>
  )
}
