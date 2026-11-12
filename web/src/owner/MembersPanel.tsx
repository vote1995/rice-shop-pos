//! OWNER "สมาชิก" panel (docs/members-spec.md) — the customer-members page.
//!
//! Two jobs:
//!  1. the JOIN QR: `${location.origin}/join/${shop_id}` rendered as an SVG
//!     (same qrcode-generator approach as the staff BeamQr; that component is
//!     not exported and belongs to the POS, so a small copy lives here) plus
//!     the copyable link — the owner prints it and puts it at the counter.
//!  2. the member list of the SELECTED shop (useOwnerShop): search box
//!     (name / phone, debounced), points, last-use date, and the per-row
//!     "ลบ" = PDPA erasure on request, with an inline confirm that spells out
//!     that it cannot be undone, then DELETE /api/owner/customers/{id} and a
//!     reload.
//!
//! Backend contract only — every timestamp is unix ms like the rest of the
//! owner API; the list is capped at 100 rows by the server.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { api, friendlyError } from '../api'
import type { OwnerCustomer } from '../api'
import { useOwnerShop } from './shopContext'

/** GET …/customers never returns more than this — hint it when we hit it. */
const LIST_CAP = 100

const THAI_DATE = new Intl.DateTimeFormat('th-TH', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

function fmtDate(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '-' : THAI_DATE.format(d)
}

/** "0812345678" → "081-234-5678" (stored normalised, shown readable). */
function fmtPhone(p: string): string {
  return /^\d{10}$/.test(p) ? `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}` : p
}

/** The join URL as an SVG QR — crisp at any size, no image request. */
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
      aria-label="QR สมัครสมาชิก"
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  )
}

export function MembersPanel() {
  const { shopId, error: shopError } = useOwnerShop()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<OwnerCustomer[] | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  /** the row whose inline erase-confirm is open (one at a time) */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** search responses may land out of order — only the newest is applied */
  const seq = useRef(0)

  // Customers scan this QR on their own phones: it must point at the public POS host,
  // never at the Access-protected owner.* host (owner.x -> pos.x; dev/localhost unchanged).
  const joinOrigin = `${window.location.protocol}//${window.location.host.replace(/^owner[.]/, 'pos.')}`
  const joinUrl = shopId !== '' ? `${joinOrigin}/join/${encodeURIComponent(shopId)}` : ''

  const load = useCallback(
    async (query: string) => {
      if (shopId === '') {
        setRows(null)
        return
      }
      const id = ++seq.current
      setBusy(true)
      try {
        const qs = query === '' ? '' : `?q=${encodeURIComponent(query)}`
        const d = await api<{ customers: OwnerCustomer[] }>(
          'GET',
          `/api/owner/shops/${encodeURIComponent(shopId)}/customers${qs}`,
        )
        if (id !== seq.current) return
        setRows(d.customers)
        setMsg('')
      } catch (e) {
        if (id !== seq.current) return
        setMsg(friendlyError(e))
      } finally {
        if (id === seq.current) setBusy(false)
      }
    },
    [shopId],
  )

  // the search box is debounced; an empty query loads immediately
  useEffect(() => {
    const t = window.setTimeout(() => void load(q.trim()), q.trim() === '' ? 0 : 250)
    return () => window.clearTimeout(t)
  }, [load, q])

  // another shop means another member list: close any open confirm
  useEffect(() => {
    setConfirmId(null)
  }, [shopId])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(joinUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setMsg('คัดลอกลิงก์ไม่สำเร็จ — ลองอีกครั้ง หรือคัดลอกจากข้อความด้านบน')
    }
  }

  /** PDPA erasure on request (DELETE /api/owner/customers/{id}) + reload. */
  async function erase(c: OwnerCustomer) {
    setBusy(true)
    try {
      await api('DELETE', `/api/owner/customers/${encodeURIComponent(c.id)}`)
      setConfirmId(null)
      await load(q.trim())
    } catch (e) {
      setMsg(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  if (shopId === '') {
    return (
      <section>
        {shopError ? (
          <p className="error" role="alert">
            {shopError}
          </p>
        ) : null}
        <p className="muted">ยังไม่มีร้าน — สร้างร้านในหน้า "ร้าน" ก่อน</p>
      </section>
    )
  }

  return (
    <section>
      {shopError ? (
        <p className="error" role="alert">
          {shopError}
        </p>
      ) : null}
      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}

      <div className="mem-cols">
        {/* ---- the join QR: print it and put it at the counter ---- */}
        <div className="card mem-join">
          <h2>ให้ลูกค้าสแกนสมัครเอง</h2>
          <div className="mem-qr">
            <QrSvg data={joinUrl} />
          </div>
          <p className="mem-link">{joinUrl}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void copyLink()}>
            {copied ? 'คัดลอกแล้ว ✓' : 'คัดลอกลิงก์'}
          </button>
          <p className="muted small">พิมพ์ QR นี้ไปตั้งหน้าร้าน</p>
        </div>

        {/* ---- the member list of the selected shop ---- */}
        <div className="mem-list-col">
          <div className="mem-tools">
            <label className="grow">
              ค้นหาสมาชิก
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="ชื่อ หรือเบอร์โทร"
                type="search"
                disabled={busy && rows === null}
              />
            </label>
            <button className="btn ghost" disabled={busy} onClick={() => void load(q.trim())}>
              รีเฟรช
            </button>
          </div>

          <h2>สมาชิก ({rows?.length ?? 0})</h2>

          {rows === null ? (
            <p className="muted">กำลังโหลด…</p>
          ) : rows.length === 0 ? (
            <p className="muted">
              {q.trim() === ''
                ? 'ยังไม่มีสมาชิก — ลูกค้าสแกน QR ด้านซ้ายเพื่อสมัครเอง'
                : 'ไม่พบสมาชิกที่ตรงกับการค้นหา'}
            </p>
          ) : (
            <div className="list">
              {rows.map((c) => (
                <div className="item mem-item" key={c.id}>
                  <div className="row">
                    <strong className="grow">
                      {c.first_name} {c.last_name}
                    </strong>
                    <span className={`badge${c.points > 0 ? ' approved' : ''}`}>{c.points} แต้ม</span>
                  </div>
                  <p className="muted small">
                    {fmtPhone(c.phone)} · ใช้ล่าสุด {fmtDate(c.updated_at)} · ยินยอมข้อมูล{' '}
                    {fmtDate(c.consent_at)}
                  </p>
                  {confirmId === c.id ? (
                    <div className="mem-confirm">
                      <p className="small">
                        ลบข้อมูลของ "{c.first_name}" ตามสิทธิ์ขอเพิกถอน/ลบข้อมูลส่วนบุคคล (PDPA)?
                        ระบบจะลบชื่อ-เบอร์โทร ประวัติแต้มทั้งหมด และแยกชื่อสมาชิกออกจากบิลเก่า —
                        <strong> ทำแล้วย้อนกลับไม่ได้</strong>
                      </p>
                      <div className="row">
                        <button
                          className="btn danger"
                          disabled={busy}
                          onClick={() => void erase(c)}
                        >
                          ยืนยันลบข้อมูล
                        </button>
                        <button className="btn ghost" disabled={busy} onClick={() => setConfirmId(null)}>
                          ยกเลิก
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="row">
                      <button
                        className="btn danger"
                        disabled={busy}
                        onClick={() => setConfirmId(c.id)}
                      >
                        ลบ
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {rows !== null && rows.length >= LIST_CAP ? (
            <p className="muted small">แสดง {LIST_CAP} คนล่าสุด — พิมพ์ชื่อหรือเบอร์โทรเพื่อหาคนอื่น</p>
          ) : null}
          <p className="muted small">
            แต้มหมดอายุเมื่อไม่มาใช้บริการ 6 เดือน · ระบบลบข้อมูลสมาชิกที่ไม่มาใช้บริการ 1 ปี
            (ใช้ล่าสุด = บิลล่าสุดที่จ่ายแล้ว)
          </p>
        </div>
      </div>
    </section>
  )
}

export default MembersPanel
