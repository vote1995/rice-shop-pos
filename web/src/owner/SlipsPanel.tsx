// OWNER slips panel (slip reader phase 1) — photograph a purchase receipt,
// upload 1-4 JPEG pages, then watch the reader gateway work through it:
// the PC agent when it is online ("เครื่องร้าน"), else Workers AI while
// today's neuron budget lasts ("Cloudflare"), else the slip waits queued and
// the panel tells the owner to switch the PC on.
//
// Patterns copied from StockPanel/MenuEditor: the shared shop selection of
// shopContext, ONE busy flag, one friendly-error line, local state patched
// from each API response. Money here is plain baht (the reader's own units),
// NOT the satang the menu/order types use. Phase 2 will turn a "read" slip
// into a stock restock; this screen only shows the extracted table.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties } from 'react'
import {
  createSlip,
  deleteSlip,
  errorCode,
  friendlyError,
  getSlip,
  listSlips,
  slipPageUrl,
  submitSlip,
  uploadSlipPage,
} from '../api'
import type { Slip, SlipReaderState, SlipResult } from '../api'
import { prepareSlipPage } from '../imageResize'
import { useOwnerShop } from './shopContext'

/** Backend cap: pages are 1..4 per slip. */
const MAX_PAGES = 4

/** Refresh tick while anything is queued/reading (spec: every 5 s). */
const POLL_MS = 5000

/** baht as the reader reported it (2 decimals, thousands separators). */
function fmtBaht(v: number): string {
  return v.toLocaleString('th-TH', { maximumFractionDigits: 2 })
}

/** qty / neuron counters: integers without a trailing ".0". */
function fmtInt(v: number): string {
  return v.toLocaleString('th-TH', { maximumFractionDigits: 0 })
}

function fmtTime(ms: number | null): string {
  if (ms === null) return '-'
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('th-TH')
}

/** Status badge text (spec wording) — reading names the reader doing it. */
function statusText(s: Slip): string {
  switch (s.status) {
    case 'draft':
      return 'ยังไม่ส่ง'
    case 'queued':
      return 'รอคิว'
    case 'reading':
      return s.reader === 'local' ? 'เครื่องร้านกำลังอ่าน' : 'Cloudflare กำลังอ่าน'
    case 'read':
      return 'อ่านเสร็จ'
    default:
      return 'อ่านไม่สำเร็จ'
  }
}

/** .badge colour: green when read, red when failed, amber while working. */
function badgeClass(s: Slip): string {
  if (s.status === 'read') return 'approved'
  if (s.status === 'failed') return 'revoked'
  if (s.status === 'draft') return ''
  return 'pending'
}

/** "เปิดเครื่อง" banner text of the spec (N = slips waiting in the queue). */
function bannerText(waiting: number): string {
  return `เครื่องอ่านสลิปปิดอยู่ และโควต้า Cloudflare วันนี้เต็ม — กรุณาเปิดเครื่อง สลิปที่รออยู่ ${waiting} ใบจะถูกอ่านอัตโนมัติ`
}

/** Thai message for page upload failures (client resize + server quota). */
function pageErrorText(e: unknown): string {
  const code = errorCode(e)
  if (code === 'image_too_large') return 'รูปใหญ่เกินไป'
  if (code === 'media_quota') return 'เกินโควต้ารูปภาพของเดือนนี้'
  if (e instanceof Error && e.message === 'รูปใหญ่เกินไป') return e.message
  return friendlyError(e)
}

/** sum(line totals) − discount vs grand_total; null when there is nothing to check. */
function sumCheck(r: SlipResult): { ok: boolean; diff: number } | null {
  if (r.grand_total === null) return null
  const sum = r.lines.reduce((a, l) => a + (l.total ?? 0), 0)
  const diff = Math.round((sum - (r.discount ?? 0) - r.grand_total) * 100) / 100
  return { ok: Math.abs(diff) < 0.005, diff }
}

/** A page photo kept in the browser before it is uploaded. */
interface PageDraft {
  blob: Blob
  url: string
}

// ---- inline styles (kept local like MenuEditor: this screen shares the app CSS untouched) ----

const THUMB_W = 56
const THUMB_H = 72
const THUMB: CSSProperties = {
  width: THUMB_W,
  height: THUMB_H,
  objectFit: 'cover',
  borderRadius: 8,
  flex: 'none',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
}
const PLACEHOLDER: CSSProperties = { ...THUMB, borderStyle: 'dashed' }
/** the red "เปิดเครื่อง" banner: danger border on the soft danger fill. */
const BANNER: CSSProperties = {
  borderColor: 'var(--danger)',
  background: 'var(--danger-soft)',
  color: 'var(--danger)',
  fontWeight: 700,
}
const X_BTN: CSSProperties = { flex: 'none', minWidth: 44, minHeight: 44, padding: '4px 10px' }
const SPINNER_SM: CSSProperties = { width: 24, height: 24, borderWidth: 3, flex: 'none' }

export default function SlipsPanel() {
  const { shopId, error } = useOwnerShop()
  const [data, setData] = useState<{ reader: SlipReaderState; slips: Slip[] } | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [pages, setPages] = useState<PageDraft[]>([])
  const [sending, setSending] = useState(false)
  /** the last submit ended 'queued' while the PC was offline -> keep the banner up */
  const [queuedOffline, setQueuedOffline] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(
    async (silent = false) => {
      if (!shopId) {
        setData(null)
        return
      }
      if (!silent) setBusy(true)
      try {
        setData(await listSlips(shopId))
        setMsg('')
      } catch (e) {
        // a background poll failing says nothing new — keep the old list
        if (!silent) setMsg(friendlyError(e))
      } finally {
        if (!silent) setBusy(false)
      }
    },
    [shopId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // auto-refresh ONLY while some slip is queued/reading (spec: every 5 s)
  const pending = (data?.slips ?? []).some((s) => s.status === 'queued' || s.status === 'reading')
  useEffect(() => {
    if (!pending) return
    const t = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(t)
  }, [pending, load])

  // another shop = another slip list: drop the drafts, close the detail view
  useEffect(() => {
    setPages((prev) => {
      for (const p of prev) URL.revokeObjectURL(p.url)
      return []
    })
    setDetailId(null)
    setQueuedOffline(false)
  }, [shopId])

  // never leak the preview object URLs
  const pagesRef = useRef<PageDraft[]>([])
  useEffect(() => {
    pagesRef.current = pages
  }, [pages])
  useEffect(
    () => () => {
      for (const p of pagesRef.current) URL.revokeObjectURL(p.url)
    },
    [],
  )

  // ---- upload: pick/take photos -> resize -> create -> PUT pages -> submit ----

  async function pickPages(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // allow picking the same file again
    const room = MAX_PAGES - pages.length
    if (files.length === 0 || room <= 0) {
      if (room <= 0) setMsg(`ใส่ได้สูงสุด ${MAX_PAGES} หน้าต่อสลิป`)
      return
    }
    if (files.length > room) setMsg(`ใส่ได้สูงสุด ${MAX_PAGES} หน้าต่อสลิป — เอาแค่ ${room} หน้าแรก`)
    setBusy(true)
    try {
      const next: PageDraft[] = []
      for (const f of files.slice(0, room)) {
        const blob = await prepareSlipPage(f)
        next.push({ blob, url: URL.createObjectURL(blob) })
      }
      setPages([...pages, ...next])
      setMsg('')
    } catch (ex) {
      setMsg(pageErrorText(ex))
    } finally {
      setBusy(false)
    }
  }

  function removePage(i: number) {
    URL.revokeObjectURL(pages[i].url)
    setPages(pages.filter((_, j) => j !== i))
  }

  async function send() {
    if (!shopId || pages.length === 0 || sending) return
    const id = crypto.randomUUID() // one id per attempt: a retry can't double-create
    const drafts = pages
    setSending(true)
    setMsg('')
    try {
      await createSlip(id, shopId)
      for (let i = 0; i < drafts.length; i++) {
        await uploadSlipPage(id, i + 1, drafts[i].blob)
      }
      const slip = await submitSlip(id) // the cloud read may run IN this request
      for (const p of drafts) URL.revokeObjectURL(p.url)
      setPages([])
      await load(true)
      // queued + PC offline = nothing will read it until the machine is on
      setQueuedOffline(slip.status === 'queued' && !(data?.reader.local_online ?? false))
    } catch (e) {
      setMsg(pageErrorText(e)) // a half-uploaded slip stays 'draft' in the list below
    } finally {
      setSending(false)
    }
  }

  // ---- list actions ----

  /** a draft that never reached submit (e.g. a failed upload) can go now */
  async function submitDraft(s: Slip) {
    setBusy(true)
    try {
      const r = await submitSlip(s.id)
      setQueuedOffline(r.status === 'queued' && !(data?.reader.local_online ?? false))
      await load(true)
    } catch (e) {
      setMsg(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  async function removeSlip(s: Slip) {
    if (!window.confirm('ลบสลิปนี้? รูปและผลอ่านจะถูกลบทั้งหมด')) return
    try {
      await deleteSlip(s.id)
      setDetailId(null)
      await load(true)
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }

  const reader = data?.reader ?? null
  const cloudLeft = reader ? Math.max(0, reader.cloud_cap - reader.cloud_neurons_today) : 0
  // red banner rule: nothing can read the queue — or a submit just landed there
  const showBanner =
    reader !== null &&
    !reader.local_online &&
    reader.waiting_count > 0 &&
    (!reader.cloud_available || queuedOffline)

  return (
    <section>
      {error ? <p className="error">{error}</p> : null}
      {msg ? (
        <p className="error" role="alert">
          {msg}
        </p>
      ) : null}

      {/* ---- reader gateway state ---- */}
      <div className="card">
        <div className="row">
          <span className={`status-dot ${reader?.local_online ? 'ok' : 'bad'}`} aria-hidden="true" />
          <span className="grow">เครื่องร้าน: {reader ? (reader.local_online ? 'ออนไลน์' : 'ออฟไลน์') : '…'}</span>
          <span className={`status-dot ${reader?.cloud_available ? 'ok' : 'warn'}`} aria-hidden="true" />
          <span>Cloudflare: เหลือ {fmtInt(cloudLeft)}/{reader ? fmtInt(reader.cloud_cap) : '-'} วันนี้</span>
        </div>
        <p className="muted small">
          อ่านด้วยเครื่องร้านก่อนเสมอ · ถ้าเครื่องปิดอยู่จะใช้ Cloudflare (โควต้าฟรีต่อวัน)
        </p>
      </div>

      {showBanner && reader !== null ? (
        <div className="card" role="alert" style={BANNER}>
          {bannerText(reader.waiting_count)}
        </div>
      ) : null}

      {/* ---- upload ---- */}
      <div className="card">
        <h2>ถ่ายใบเสร็จซื้อของ</h2>
        <p className="muted small">
          ถ่ายหรือเลือกรูปใบเสร็จ (มาโคร, ตลาด, ลายมือ) — ระบบจะอ่านรายการเป็นตารางให้อัตโนมัติ · สลิปยาวได้ถึง {MAX_PAGES} หน้า
        </p>
        {pages.length > 0 ? (
          <div className="row">
            {pages.map((p, i) => (
              <div key={p.url} style={{ position: 'relative', flex: 'none' }}>
                <img src={p.url} alt={`หน้าที่ ${i + 1}`} width={THUMB_W} height={THUMB_H} style={THUMB} />
                <button
                  type="button"
                  className="btn ghost"
                  style={{ ...X_BTN, position: 'absolute', right: -4, top: -4, background: 'var(--surface)' }}
                  aria-label={`ลบหน้าที่ ${i + 1}`}
                  disabled={busy || sending}
                  onClick={() => removePage(i)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <label className="grow">
          เพิ่มรูปหน้าสลิป{pages.length > 0 ? ` (ได้อีก ${MAX_PAGES - pages.length} หน้า)` : ''}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            disabled={busy || sending || pages.length >= MAX_PAGES}
            onChange={pickPages}
          />
        </label>
        <div className="row">
          <button
            className="btn primary grow"
            disabled={busy || sending || pages.length === 0 || !shopId}
            onClick={() => void send()}
          >
            ส่งอ่านสลิป{pages.length > 0 ? ` (${pages.length} หน้า)` : ''}
          </button>
        </div>
        {sending ? (
          <div className="row" role="status">
            <span className="spinner" style={SPINNER_SM} aria-hidden="true" />
            <span className="grow">กำลังส่ง/กำลังอ่าน... (อาจใช้เวลาถึง 1 นาที)</span>
          </div>
        ) : null}
      </div>

      {/* ---- detail or list ---- */}
      {detailId !== null ? (
        <SlipDetail
          slipId={detailId}
          onBack={() => setDetailId(null)}
          onChanged={() => void load(true)}
        />
      ) : (
        renderList()
      )}
    </section>
  )

  function renderList() {
    const slips = data?.slips ?? []
    return (
      <>
        <div className="row">
          <h2 className="grow">สลิปล่าสุด ({slips.length})</h2>
          <button className="btn ghost" disabled={busy || !shopId} onClick={() => void load()}>
            รีเฟรช
          </button>
        </div>

        {shopId && !data && !msg ? <p className="muted">กำลังโหลดสลิป…</p> : null}

        <div className="list">
          {slips.map((s) => (
            <SlipRow
              key={s.id}
              slip={s}
              busy={busy || sending}
              onOpen={() => setDetailId(s.id)}
              onSubmitDraft={() => void submitDraft(s)}
              onDelete={() => void removeSlip(s)}
            />
          ))}
        </div>
        {data && slips.length === 0 ? <p className="muted">ยังไม่มีสลิป — ถ่ายใบเสร็จแรกด้านบน</p> : null}
        {pending ? <p className="muted small">มีสลิปกำลังรอ/กำลังอ่าน — รีเฟรชอัตโนมัติทุก 5 วินาที</p> : null}
      </>
    )
  }
}

// ---------------------------------------------------------------------------
// One slip row of the list: thumbnail, status, quick actions
// ---------------------------------------------------------------------------

function SlipRow({
  slip,
  busy,
  onOpen,
  onSubmitDraft,
  onDelete,
}: {
  slip: Slip
  busy: boolean
  onOpen: () => void
  onSubmitDraft: () => void
  onDelete: () => void
}) {
  const reading = slip.status === 'reading'
  return (
    <div className={`item ${slip.status === 'read' ? 'ok-item' : slip.status === 'failed' ? 'pending-item' : ''}`}>
      <button
        type="button"
        style={{ display: 'flex', gap: 10, alignItems: 'center', textAlign: 'left', background: 'transparent', border: 0, padding: 0, minHeight: 72, fontWeight: 400 }}
        onClick={onOpen}
        aria-label={`ดูสลิป ${fmtTime(slip.created_at)}`}
      >
        <SlipPageImg slipId={slip.id} page={1} width={THUMB_W} height={THUMB_H} style={THUMB} placeholderStyle={PLACEHOLDER} alt="หน้าแรกของสลิป" />
        <span style={{ flex: '1 1 120px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="muted small">{fmtTime(slip.created_at)} · {slip.page_count} หน้า</span>
          {slip.status === 'read' && slip.result ? (
            <span className="small" style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
              {slip.result.store ?? 'ไม่ทราบร้าน'} · {fmtBaht(slip.result.grand_total ?? 0)} บาท
            </span>
          ) : null}
          {slip.status === 'read' && slip.result?.lines ? (
            <span className="muted small">{slip.result.lines.length} รายการ</span>
          ) : null}
          {slip.status === 'failed' && slip.error ? (
            <span className="error small" style={{ overflowWrap: 'anywhere' }}>{slip.error}</span>
          ) : null}
        </span>
        <span className={`badge ${badgeClass(slip)}`}>{statusText(slip)}</span>
      </button>
      <div className="row">
        <button type="button" className="btn ghost" style={X_BTN} onClick={onOpen}>
          ดูรายละเอียด
        </button>
        {slip.status === 'draft' && slip.page_count >= 1 ? (
          <button type="button" className="btn primary" style={X_BTN} disabled={busy} onClick={onSubmitDraft}>
            ส่งอ่าน
          </button>
        ) : null}
        {!reading ? (
          <button type="button" className="btn danger" style={X_BTN} disabled={busy} onClick={onDelete}>
            ลบ
          </button>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Private page image: fetch as a blob (Access cookie), render as an object URL
// ---------------------------------------------------------------------------

function SlipPageImg({
  slipId,
  page,
  width,
  height,
  style,
  placeholderStyle,
  alt,
}: {
  slipId: string
  page: number
  width: number
  height: number
  style?: CSSProperties
  /** style of the grey box shown while loading / when the fetch fails */
  placeholderStyle?: CSSProperties
  alt: string
}) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let on = true
    let objectUrl = ''
    void slipPageUrl(slipId, page)
      .then((u) => {
        if (on) {
          objectUrl = u
          setUrl(u)
        } else {
          URL.revokeObjectURL(u)
        }
      })
      .catch(() => {
        /* stay a grey box */
      })
    return () => {
      on = false
      if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
    }
  }, [slipId, page])
  if (url === '') {
    return <div aria-hidden="true" style={{ width, height, ...(placeholderStyle ?? style) }} />
  }
  return <img src={url} alt={alt} width={width} height={height} style={{ width, height, ...style }} />
}

// ---------------------------------------------------------------------------
// Detail: page images + the extracted table + the sum check
// ---------------------------------------------------------------------------

function SlipDetail({
  slipId,
  onBack,
  onChanged,
}: {
  slipId: string
  onBack: () => void
  /** the list reloads after a delete */
  onChanged: () => void
}) {
  const [slip, setSlip] = useState<Slip | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (silent = false) => {
      try {
        setSlip(await getSlip(slipId))
        setMsg('')
      } catch (e) {
        if (!silent) setMsg(friendlyError(e))
      }
    },
    [slipId],
  )

  useEffect(() => {
    void load()
  }, [load])

  // keep the open slip live while the readers work on it
  const pending = slip !== null && (slip.status === 'queued' || slip.status === 'reading')
  useEffect(() => {
    if (!pending) return
    const t = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(t)
  }, [pending, load])

  async function remove() {
    if (!slip || !window.confirm('ลบสลิปนี้? รูปและผลอ่านจะถูกลบทั้งหมด')) return
    setBusy(true)
    try {
      await deleteSlip(slip.id)
      onChanged()
      onBack()
    } catch (e) {
      setMsg(friendlyError(e)) // 'reading' slips refuse the delete: try again shortly
    } finally {
      setBusy(false)
    }
  }

  if (!slip) {
    return (
      <div className="card">
        {msg ? (
          <p className="error">
            {msg}{' '}
            <button type="button" className="btn ghost" style={X_BTN} onClick={() => void load()}>
              ลองใหม่
            </button>
          </p>
        ) : (
          <p className="muted">กำลังโหลดสลิป…</p>
        )}
        <button type="button" className="btn ghost" onClick={onBack}>
          ← กลับ
        </button>
      </div>
    )
  }

  const check = slip.result ? sumCheck(slip.result) : null

  return (
    <div className="card">
      <div className="row">
        <button type="button" className="btn ghost" style={X_BTN} onClick={onBack}>
          ← กลับ
        </button>
        <span className={`badge ${badgeClass(slip)}`}>{statusText(slip)}</span>
        <span className="grow" />
        {slip.status !== 'reading' ? (
          <button type="button" className="btn danger" style={X_BTN} disabled={busy} onClick={() => void remove()}>
            ลบสลิป
          </button>
        ) : null}
      </div>
      <p className="muted small">
        ถ่ายเมื่อ {fmtTime(slip.created_at)} · {slip.page_count} หน้า
        {slip.attempts > 0 ? ` · ลองอ่าน ${slip.attempts} ครั้ง` : ''}
        {slip.read_at !== null ? ` · อ่านเสร็จ ${fmtTime(slip.read_at)}` : ''}
      </p>
      {msg ? <p className="error small">{msg}</p> : null}
      {slip.status === 'failed' && slip.error ? (
        <p className="error small" style={{ overflowWrap: 'anywhere' }}>
          {slip.error}
        </p>
      ) : null}
      {pending ? (
        <div className="row" role="status">
          <span className="spinner" style={SPINNER_SM} aria-hidden="true" />
          <span className="grow small">กำลังอ่าน... (อาจใช้เวลาถึง 1 นาที)</span>
        </div>
      ) : null}

      <h3>รูปสลิป</h3>
      <div className="row">
        {Array.from({ length: slip.page_count }, (_, i) => (
          <SlipPageImg
            key={i + 1}
            slipId={slip.id}
            page={i + 1}
            width={140}
            height={186}
            alt={`หน้าที่ ${i + 1}`}
            style={{ objectFit: 'contain', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface-2)', flex: 'none' }}
          />
        ))}
      </div>

      <h3>ผลอ่าน</h3>
      {slip.result ? (
        <>
          <div className="row">
            <span className="grow small" style={{ overflowWrap: 'anywhere' }}>
              <strong>{slip.result.store ?? 'ไม่ทราบร้าน'}</strong>
              {slip.result.date !== null ? ` · ${slip.result.date}` : ''}
              {slip.result.receipt_no !== null ? ` · เลขที่ ${slip.result.receipt_no}` : ''}
            </span>
          </div>
          <div className="dash-scroll">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>รหัส</th>
                  <th>รายการ</th>
                  <th className="num">จำนวน</th>
                  <th>หน่วย</th>
                  <th className="num">ราคา/หน่วย</th>
                  <th className="num">รวม</th>
                </tr>
              </thead>
              <tbody>
                {slip.result.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.code ?? '-'}</td>
                    <td>{l.name}</td>
                    <td className="num">{l.qty !== null ? fmtBaht(l.qty) : '-'}</td>
                    <td>{l.unit ?? '-'}</td>
                    <td className="num">{l.unit_price !== null ? fmtBaht(l.unit_price) : '-'}</td>
                    <td className="num">{l.total !== null ? fmtBaht(l.total) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <span className="grow small">
              {slip.result.discount !== null ? `ส่วนลด ${fmtBaht(slip.result.discount)} บาท · ` : ''}
              <strong>รวมทั้งสิ้น {fmtBaht(slip.result.grand_total ?? 0)} บาท</strong>
            </span>
            {check ? (
              check.ok ? (
                <span className="sc-verdict ok">ยอดตรง</span>
              ) : (
                <span className="sc-verdict warn">ยอดไม่ตรง (ต่าง {fmtBaht(Math.abs(check.diff))} บาท)</span>
              )
            ) : null}
          </div>
        </>
      ) : (
        <p className="muted small">{slip.status === 'read' ? 'ยังไม่มีผลอ่าน' : 'จะแสดงผลอ่านเมื่ออ่านเสร็จ'}</p>
      )}
    </div>
  )
}
