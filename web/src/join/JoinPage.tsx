//! PUBLIC member join page — /join/{shop_id} (docs/members-spec.md).
//!
//! Rendered by main.tsx BEFORE the staff POS / owner branches on ANY host, so
//! a customer scanning the shop's QR opens it with no login, no service worker
//! (no PWA install prompt on a phone) and no POS chrome. Three steps:
//!   1. the PDPA notice (the shop is the data controller) + one big "ยอมรับ" button,
//!   2. the form (ชื่อ / นามสกุล / เบอร์โทร) validated with the server's rules,
//!   3. the thank-you screen.
//!
//! Both calls go through the shared api() helper in its default no-auth mode
//! (GET /api/public/join/{shop_id} → shop_name + consent_version; POST the
//! same path with consent:true and the consent_version the SERVER returned,
//! so the page never hardcodes the version). The response is {ok:true} either
//! way — a phone that already exists must look identical to a fresh signup.
//!
//! Styling: the `.join` scope appended to styles.css (own tokens, follows the
//! OS light/dark setting — a public page has no theme switch to remember).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { ApiError, api, friendlyError } from '../api'
import type { PublicShopInfo } from '../api'

type Step = 'notice' | 'form' | 'done'

/** "/join/<shop_id>/…" → the first path segment after /join (decoded). */
function shopIdFromPath(): string {
  const parts = window.location.pathname.split('/').filter(Boolean)
  const raw = parts.length >= 2 && parts[0] === 'join' ? parts[1] : ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// ---- client-side validation (mirrors the server rules of the spec) ----

const NAME_MAX = 60
const PHONE_RE = /^0[689]\d{8}$/

/** Names: trimmed, 1–60 chars, no control characters. */
function nameError(v: string): string | null {
  const n = v.trim()
  if (n === '') return 'ต้องกรอก'
  if (n.length > NAME_MAX) return `ต้องยาวไม่เกิน ${NAME_MAX} ตัวอักษร`
  if (/[\u0000-\u001f\u007f]/.test(n)) return 'มีตัวอักษรที่ใช้ไม่ได้'
  return null
}

/** Same normalisation as the server: strip spaces/dashes, +66/66 → 0. */
function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-().]/g, '')
  if (p.startsWith('+66')) p = `0${p.slice(3)}`
  else if (p.startsWith('66') && p.length === 11) p = `0${p.slice(2)}`
  return p
}

export default function JoinPage() {
  const shopId = useMemo(shopIdFromPath, [])
  const [info, setInfo] = useState<PublicShopInfo | null>(null)
  const [notFound, setNotFound] = useState(shopId === '')
  const [failed, setFailed] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [step, setStep] = useState<Step>('notice')

  // ---- step 1 data: GET /api/public/join/{shop_id} ----
  const load = useCallback(async () => {
    if (shopId === '') return
    setFailed(false)
    try {
      setInfo(await api<PublicShopInfo>('GET', `/api/public/join/${encodeURIComponent(shopId)}`))
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true)
      else {
        setFailed(true)
        setLoadErr(friendlyError(e))
      }
    }
  }, [shopId])

  useEffect(() => {
    void load()
  }, [load])

  if (notFound) {
    return (
      <div className="join">
        <main className="join-main">
          <div className="join-card">
            <h1>ไม่พบร้านนี้</h1>
            <p className="muted">ลิงก์อาจพิมพ์ผิด หรือร้านปิดใช้งานแล้ว — ลองสแกน QR ที่หน้าร้านอีกครั้ง</p>
          </div>
        </main>
      </div>
    )
  }

  if (failed) {
    return (
      <div className="join">
        <main className="join-main">
          <div className="join-card">
            <p className="error" role="alert">
              {loadErr}
            </p>
            <button type="button" className="join-btn primary big" onClick={() => void load()}>
              ลองใหม่อีกครั้ง
            </button>
          </div>
        </main>
      </div>
    )
  }

  if (info === null) {
    return (
      <div className="join">
        <main className="join-main">
          <div className="join-card">
            <div className="spinner" aria-hidden="true" />
            <p className="muted center-text">กำลังโหลด…</p>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="join">
      <main className="join-main">
        {step === 'notice' ? <Notice shopName={info.shop_name} onAccept={() => setStep('form')} /> : null}
        {step === 'form' ? <JoinForm shopId={shopId} consentVersion={info.consent_version} onDone={() => setStep('done')} /> : null}
        {step === 'done' ? (
          <div className="join-card">
            <span className="join-check" aria-hidden="true">
              ✓
            </span>
            <h1>สมัครสมาชิกเรียบร้อยแล้ว</h1>
            <p className="join-lead">ครั้งต่อไปแจ้งเบอร์โทรกับพนักงานที่ร้านได้เลย</p>
            <p className="muted small center-text">
              สมาชิก {info.shop_name} · สะสมแต้มทุกครั้งที่ซื้อ 1 แต้มต่อ 100 บาท
            </p>
          </div>
        ) : null}
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1 — the PDPA notice (the shop is the data controller)
// ---------------------------------------------------------------------------

function Notice({ shopName, onAccept }: { shopName: string; onAccept: () => void }) {
  return (
    <div className="join-card">
      <p className="join-shop">สมัครสมาชิก</p>
      <h1>{shopName}</h1>
      <div className="join-notice">
        <h2>แจ้งการเก็บข้อมูลส่วนบุคคล (PDPA)</h2>
        <ul>
          <li>
            <strong>ผู้ควบคุมข้อมูล:</strong> ร้าน{shopName}
          </li>
          <li>
            <strong>ข้อมูลที่เก็บ:</strong> ชื่อ นามสกุล และเบอร์โทรศัพท์
          </li>
          <li>
            <strong>วัตถุประสงค์:</strong> เป็นสมาชิกของร้าน เพื่อสะสมแต้มและใช้แต้มแลกรับส่วนลด
          </li>
          <li>
            <strong>ระยะเวลาเก็บ:</strong> เก็บไว้ตราบที่คุณใช้บริการ — หากไม่มาใช้บริการ 6 เดือน
            แต้มสะสมจะถูกล้าง และหากไม่มาใช้บริการ 1 ปี ข้อมูลของคุณจะถูกลบ
          </li>
          <li>
            <strong>การเปิดเผย:</strong> ไม่นำข้อมูลไปขาย หรือส่งต่อให้บุคคลที่สาม
          </li>
          <li>
            <strong>สิทธิ์ของคุณ:</strong> ขอดูข้อมูล ขอแก้ไข ขอลบ หรือเพิกถอนความยินยอมได้
            โดยแจ้งพนักงานที่ร้าน
          </li>
        </ul>
      </div>
      <button type="button" className="join-btn primary big" onClick={onAccept}>
        ยอมรับและดำเนินการต่อ
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — the form
// ---------------------------------------------------------------------------

function JoinForm({
  shopId,
  consentVersion,
  onDone,
}: {
  shopId: string
  consentVersion: string
  onDone: () => void
}) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const first = firstName.trim()
    const last = lastName.trim()
    const p = normalizePhone(phone)
    const firstErr = nameError(firstName)
    if (firstErr !== null) {
      setErr(`ชื่อ: ${firstErr}`)
      return
    }
    const lastErr = nameError(lastName)
    if (lastErr !== null) {
      setErr(`นามสกุล: ${lastErr}`)
      return
    }
    if (!PHONE_RE.test(p)) {
      setErr('เบอร์โทรไม่ถูกต้อง — ใส่เบอร์ 10 หลักที่ขึ้นต้นด้วย 06 / 08 / 09')
      return
    }
    setErr('')
    setBusy(true)
    try {
      // consent_version is what the SERVER handed us in step 1, never a constant
      await api('POST', `/api/public/join/${encodeURIComponent(shopId)}`, {
        first_name: first,
        last_name: last,
        phone: p,
        consent: true,
        consent_version: consentVersion,
      })
      onDone()
    } catch (e2) {
      // 400 = the server rejected the input; anything else is a retryable hiccup
      setErr(e2 instanceof ApiError && e2.status === 400 ? 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบชื่อและเบอร์โทรอีกครั้ง' : friendlyError(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="join-card" onSubmit={submit} noValidate>
      <p className="join-shop">สมัครสมาชิก</p>
      <h1>กรอกข้อมูลของคุณ</h1>
      <label>
        ชื่อ
        <input
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
          autoComplete="given-name"
          maxLength={60}
          placeholder="เช่น สมชาย"
          disabled={busy}
          required
        />
      </label>
      <label>
        นามสกุล
        <input
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
          autoComplete="family-name"
          maxLength={80}
          placeholder="เช่น ใจดี"
          disabled={busy}
          required
        />
      </label>
      <label>
        เบอร์โทร
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          type="tel"
          autoComplete="tel"
          maxLength={16}
          placeholder="081 234 5678"
          disabled={busy}
          required
        />
        <span className="muted small">เบอร์ 10 หลัก ขึ้นต้น 06 / 08 / 09 — ใช้แต้มได้ที่ร้านด้วยเบอร์นี้</span>
      </label>
      {err ? (
        <p className="error" role="alert">
          {err}
        </p>
      ) : null}
      <button type="submit" className="join-btn primary big" disabled={busy}>
        {busy ? 'กำลังส่ง…' : 'สมัครสมาชิก'}
      </button>
      <p className="muted small center-text">
        กด "สมัครสมาชิก" ถือว่ายอมรับการเก็บข้อมูลตามประกาศข้างต้น
      </p>
    </form>
  )
}
