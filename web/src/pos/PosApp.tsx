import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import PayAnnouncer from './PayAnnouncer'
import {
  api,
  clearDevice,
  clearSession,
  errorCode,
  errorExtra,
  friendlyError,
  getDevice,
  getSession,
  saveDevice,
  setSession,
  wipeAllStorage,
} from '../api'
import type { DeviceCreds, DeviceStatus, PinResponse, RegisterResponse, Staff } from '../api'
import Counter from './Counter'
import TopBarMenu, { applyStatusBarStyle } from './TopBarMenu'
import type { ThemeChoice } from './TopBarMenu'

// 3.54: auto-lock after 5 minutes without any pointer/key/touch activity.
const AUTOLOCK_MS = 5 * 60 * 1000
const AUTOLOCK_CHECK_MS = 5000
const STATUS_POLL_MS = 5000
// 3.56: an approved device re-checks its status so a remote revoke locks and
// wipes it soon after it is online, even if nothing else calls the API.
const APPROVED_RECHECK_MS = 60 * 1000

type Screen = 'register' | 'pending' | 'revoked' | 'staff' | 'pin' | 'home'

// UI-4: the staff app carries its own theme (the `.pos` token scope in
// styles.css), remembered in localStorage 'pos.theme' and following the OS
// by default. The header menu item cycles สว่าง -> มืด -> ตามระบบ.
const THEME_KEY = 'pos.theme'

function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

function usePosTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark'; cycle: () => void } {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme)
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  // "ตามระบบ" follows the OS live, including while the tab is open
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  function cycle() {
    setChoice((c) => {
      const next: ThemeChoice = c === 'light' ? 'dark' : c === 'dark' ? 'system' : 'light'
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        /* private mode: keep the choice for this session only */
      }
      return next
    })
  }

  return {
    choice,
    resolved: choice === 'system' ? (systemDark ? 'dark' : 'light') : choice,
    cycle,
  }
}


function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8).toUpperCase() : '-'
}

function fmtClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PosApp() {
  const [screen, setScreen] = useState<Screen>(() => (getDevice() ? 'pending' : 'register'))
  const [device, setDevice] = useState<DeviceCreds | null>(() => getDevice())
  const [shopName, setShopName] = useState('')
  const [staff, setStaff] = useState<Staff[]>([])
  const [user, setUser] = useState<Staff | null>(null)
  const [me, setMe] = useState<{ id: string; name: string } | null>(null)
  const [devName, setDevName] = useState('')
  const [msg, setMsg] = useState('')
  const [pin, setPin] = useState('')
  const [pinMsg, setPinMsg] = useState('')
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [tick, setTick] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const theme = usePosTheme()

  // Native Android app only — keep the status-bar icon colour in step
  // with the theme (light icons on the dark theme, dark icons on the light
  // one) on initial load and on every toggle/system change. No-op in a browser.
  useEffect(() => {
    void applyStatusBarStyle(theme.resolved)
  }, [theme.resolved])

  /** 3.56: device revoked — wipe everything stored on this device. */
  const handleRevoked = useCallback(async () => {
    await wipeAllStorage()
    setDevice(null)
    setUser(null)
    setMe(null)
    setStaff([])
    setShopName('')
    setScreen('revoked')
  }, [])

  const checkStatus = useCallback(async () => {
    if (!getDevice()) return
    try {
      const st = await api<DeviceStatus>('GET', '/api/device/status', undefined, 'device')
      setShopName(st.shop_name ?? '')
      if (st.status === 'revoked') return handleRevoked()
      if (st.status === 'pending') {
        setScreen('pending')
        return
      }
      // approved — resume an existing session (sessionStorage only), else staff picker
      if (getSession()) {
        try {
          const mine = await api<{ user_id: string; name: string }>('GET', '/api/staff/me', undefined, 'both')
          setMe({ id: mine.user_id, name: mine.name })
          setScreen('home')
          return
        } catch (e) {
          if (errorCode(e) === 'session_invalid') clearSession()
          else if (errorCode(e) === 'device_revoked') return handleRevoked()
          else setMsg(friendlyError(e)) // 503/network → retry, never treat as logged out
        }
      }
      setScreen('staff')
    } catch (e) {
      if (errorCode(e) === 'invalid_device') {
        clearDevice()
        setDevice(null)
        setScreen('register')
        return
      }
      if (errorCode(e) === 'device_revoked') return handleRevoked()
      setMsg(friendlyError(e))
    }
  }, [handleRevoked])

  // boot: check the device status once
  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  // while pending, poll for owner approval every 5s
  useEffect(() => {
    if (screen !== 'pending') return
    const t = window.setInterval(() => void checkStatus(), STATUS_POLL_MS)
    return () => window.clearInterval(t)
  }, [screen, checkStatus])

  // once approved: periodic + on-foreground revoke check (status only, no screen change)
  useEffect(() => {
    if (screen !== 'staff' && screen !== 'pin' && screen !== 'home') return
    const recheck = async () => {
      try {
        const st = await api<DeviceStatus>('GET', '/api/device/status', undefined, 'device')
        if (st.status === 'revoked') void handleRevoked()
      } catch (e) {
        if (errorCode(e) === 'device_revoked') void handleRevoked()
        // network/503: stay as-is, try again next tick
      }
    }
    const t = window.setInterval(() => void recheck(), APPROVED_RECHECK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [screen, handleRevoked])

  const loadStaff = useCallback(async () => {
    try {
      setStaff(await api<Staff[]>('GET', '/api/device/staff', undefined, 'device'))
      setMsg('')
    } catch (e) {
      if (errorCode(e) === 'device_pending') {
        setScreen('pending')
        return
      }
      if (errorCode(e) === 'device_revoked') return handleRevoked()
      setMsg(friendlyError(e))
    }
  }, [handleRevoked])

  useEffect(() => {
    if (screen === 'staff') void loadStaff()
  }, [screen, loadStaff])

  // safety net: home without a logged-in user / pin screen without a picked user
  useEffect(() => {
    if ((screen === 'home' && !me) || (screen === 'pin' && !user)) setScreen('staff')
  }, [screen, me, user])

  async function registerDevice(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      const res = await api<RegisterResponse>('POST', '/api/device/register', {
        id: crypto.randomUUID(),
        name: devName.trim() || 'เครื่อง POS',
        model: navigator.userAgent.slice(0, 200),
      })
      saveDevice({ device_id: res.device_id, device_token: res.device_token })
      setDevice({ device_id: res.device_id, device_token: res.device_token })
      setScreen('pending')
    } catch (err) {
      setMsg(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  function pickStaff(s: Staff) {
    setUser(s)
    setPin('')
    setPinMsg('')
    setLockedUntil(null)
    setMsg('')
    setScreen('pin')
  }

  async function submitPin() {
    if (!user) return
    setBusy(true)
    try {
      const res = await api<PinResponse>('POST', '/api/auth/pin', { user_id: user.id, pin }, 'device')
      setSession(res.session_token) // sessionStorage only — dies with the tab
      setMe(res.user)
      setPin('')
      setPinMsg('')
      setLockedUntil(null)
      setScreen('home')
    } catch (e) {
      setPin('')
      if (errorCode(e) === 'pin_locked') {
        const lu = errorExtra(e)['locked_until']
        setPinMsg('')
        setLockedUntil(typeof lu === 'number' ? lu : Date.now() + 60_000)
      } else if (errorCode(e) === 'device_revoked') {
        await handleRevoked()
      } else {
        setPinMsg(friendlyError(e)) // invalid_pin -> Thai text with attempts_left
      }
    } finally {
      setBusy(false)
    }
  }

  /** Lock = back to the PIN screen for the same user. Logout = back to the staff picker. */
  const endSession = useCallback(async (toStaffPicker: boolean) => {
    try {
      await api('POST', '/api/auth/logout', undefined, 'both')
    } catch {
      // ignore network/upstream errors; the session is dropped locally regardless
    }
    clearSession()
    setPin('')
    setPinMsg('')
    setLockedUntil(null)
    if (toStaffPicker) {
      setUser(null)
      setMe(null)
      setScreen('staff')
    } else {
      setScreen('pin')
    }
  }, [])

  // 3.54 auto-lock when idle
  useEffect(() => {
    if (screen !== 'home') return
    let lastActivity = Date.now()
    const bump = () => {
      lastActivity = Date.now()
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'pointermove', 'keydown', 'touchstart']
    for (const ev of events) window.addEventListener(ev, bump, { passive: true })
    let locking = false
    const timer = window.setInterval(() => {
      if (locking) return
      if (Date.now() - lastActivity >= AUTOLOCK_MS) {
        locking = true
        void endSession(false)
      }
    }, AUTOLOCK_CHECK_MS)
    return () => {
      window.clearInterval(timer)
      for (const ev of events) window.removeEventListener(ev, bump)
    }
  }, [screen, endSession])

  // live countdown while the PIN is locked
  useEffect(() => {
    if (lockedUntil === null) return
    setTick(Date.now())
    const t = window.setInterval(() => {
      const now = Date.now()
      setTick(now)
      if (now >= lockedUntil) {
        window.clearInterval(t)
        setLockedUntil(null)
      }
    }, 250)
    return () => window.clearInterval(t)
  }, [lockedUntil])

  if (screen === 'revoked') {
    return (
      <div className="screen pos pos-auth" data-theme={theme.resolved}>
        <main className="pos-auth-main">
          <div className="pos-auth-card">
            <div className="pos-auth-brand">
              <span className="pos-auth-mark" aria-hidden="true">
                <img src="/logo.png" alt="" width={40} height={40} />
              </span>
              <h1 className="pos-auth-title">WyV POS</h1>
              {shopName ? <p className="pos-auth-shop muted">ร้าน {shopName}</p> : null}
            </div>
            <div className="pos-auth-fields center">
              <h2 className="pos-auth-heading">เครื่องนี้ถูกเพิกถอนแล้ว</h2>
              <p className="muted">
                ข้อมูลทั้งหมดในเครื่องนี้ถูกลบแล้ว หากต้องการใช้งานอีกครั้ง กรุณาลงทะเบียนใหม่
              </p>
              <button className="btn primary pos-auth-submit" onClick={() => setScreen('register')}>
                ลงทะเบียนใหม่
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  if (screen === 'register') {
    return (
      <div className="screen pos pos-auth" data-theme={theme.resolved}>
        <main className="pos-auth-main">
          <form className="pos-auth-card" onSubmit={registerDevice}>
            <div className="pos-auth-brand">
              <span className="pos-auth-mark" aria-hidden="true">
                <img src="/logo.png" alt="" width={40} height={40} />
              </span>
              <h1 className="pos-auth-title">WyV POS</h1>
              {shopName ? <p className="pos-auth-shop muted">ร้าน {shopName}</p> : null}
            </div>
            <div className="pos-auth-fields">
              <h2 className="pos-auth-heading">ลงทะเบียนเครื่องนี้</h2>
              <p className="muted">กรอกชื่อเครื่องเพื่อให้เจ้าของร้านรู้จักเครื่องนี้ตอนอนุมัติ</p>
              <label>
                ชื่อเครื่อง
                <input
                  className="pos-auth-input"
                  value={devName}
                  onChange={(e) => setDevName(e.target.value)}
                  placeholder="เช่น โต๊ะขายหน้าร้าน"
                  autoFocus
                />
              </label>
              {msg ? (
                <p className="error" role="alert">
                  {msg}
                </p>
              ) : null}
              <button className="btn primary pos-auth-submit" type="submit" disabled={busy}>
                {busy ? 'กำลังลงทะเบียน…' : 'ลงทะเบียนเครื่อง'}
              </button>
            </div>
          </form>
        </main>
      </div>
    )
  }

  if (screen === 'pending') {
    return (
      <div className="screen pos pos-auth" data-theme={theme.resolved}>
        <main className="pos-auth-main">
          <div className="pos-auth-card">
            <div className="pos-auth-brand">
              <span className="pos-auth-mark" aria-hidden="true">
                <img src="/logo.png" alt="" width={40} height={40} />
              </span>
              <h1 className="pos-auth-title">WyV POS</h1>
              {shopName ? <p className="pos-auth-shop muted">ร้าน {shopName}</p> : null}
            </div>
            <div className="pos-auth-fields center">
              <div className="spinner pos-auth-spinner" aria-hidden="true" />
              <h2 className="pos-auth-heading">รอเจ้าของอนุมัติเครื่องนี้</h2>
              <p className="pos-auth-code-row">
                รหัสเครื่อง: <span className="pos-auth-code">{shortId(device?.device_id)}</span>
              </p>
              <p className="muted small">ตรวจสอบสถานะอัตโนมัติทุก 5 วินาที</p>
              {msg ? (
                <p className="error" role="alert">
                  {msg}
                </p>
              ) : null}
            </div>
          </div>
        </main>
      </div>
    )
  }

  if (screen === 'staff') {
    return (
      <div className="screen pos pos-auth" data-theme={theme.resolved}>
        <main className="pos-auth-main">
          <div className="pos-auth-card wide">
            <div className="pos-auth-brand">
              <span className="pos-auth-mark" aria-hidden="true">
                <img src="/logo.png" alt="" width={40} height={40} />
              </span>
              <h1 className="pos-auth-title">WyV POS</h1>
              {shopName ? <p className="pos-auth-shop muted">ร้าน {shopName}</p> : null}
            </div>
            <div className="pos-auth-fields">
              <h2 className="pos-auth-heading">เลือกผู้ใช้งาน</h2>
              {staff.length === 0 ? (
                <p className="muted">ยังไม่มีพนักงาน — รอเจ้าของร้านเพิ่มพนักงาน</p>
              ) : null}
              <div className="pos-people">
                {staff.map((s) => (
                  <button key={s.id} className="pos-person" onClick={() => pickStaff(s)}>
                    <span className="pos-person-avatar" aria-hidden="true">
                      {s.name.trim().slice(0, 1) || '?'}
                    </span>
                    <span className="pos-person-name">{s.name}</span>
                  </button>
                ))}
              </div>
              {msg ? (
                <p className="error" role="alert">
                  {msg}
                </p>
              ) : null}
              <button className="pos-auth-link" onClick={() => void loadStaff()}>
                รีเฟรช
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  if (screen === 'pin' && user) {
    const locked = lockedUntil !== null && tick < lockedUntil
    const remain = lockedUntil !== null ? Math.ceil((lockedUntil - tick) / 1000) : 0
    return (
      <div className="screen pos pos-auth" data-theme={theme.resolved}>
        <main className="pos-auth-main">
          <div className="pos-auth-card pin">
            <div className="pos-auth-user">
              <span className="pos-auth-avatar" aria-hidden="true">
                {user.name.trim().slice(0, 1) || '?'}
              </span>
              <h2>{user.name}</h2>
              {shopName ? <p className="pos-auth-shop muted">ร้าน {shopName}</p> : null}
            </div>
            <div className="dots" aria-label={`ใส่แล้ว ${pin.length} หลัก`}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={i < pin.length ? 'dot on' : 'dot'} />
              ))}
            </div>
            <p className={locked || pinMsg ? 'error center-text' : 'muted center-text'}>
              {locked ? `PIN ถูกล็อก ลองอีกครั้งใน ${fmtClock(remain)}` : pinMsg || 'กรุณาใส่ PIN 4-6 หลัก'}
            </p>
            <div className="pinpad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  className="key"
                  disabled={locked}
                  onClick={() => setPin((p) => (p.length < 6 ? p + d : p))}
                >
                  {d}
                </button>
              ))}
              <button
                className="key"
                disabled={locked || pin.length === 0}
                onClick={() => setPin((p) => p.slice(0, -1))}
                aria-label="ลบ"
              >
                ⌫
              </button>
              <button
                className="key"
                disabled={locked}
                onClick={() => setPin((p) => (p.length < 6 ? p + '0' : p))}
              >
                0
              </button>
              <button
                className="key ok"
                disabled={locked || pin.length < 4 || busy}
                onClick={() => void submitPin()}
              >
                ตกลง
              </button>
            </div>
            <button
              className="pos-auth-link"
              onClick={() => {
                setUser(null)
                setScreen('staff')
              }}
            >
              กลับ
            </button>
          </div>
        </main>
      </div>
    )
  }

  if (screen === 'home' && me) {
    /** 3.70/M1-3b: a staff API call answered session_invalid -> re-lock to PIN for the same user. */
    const sessionExpired = () => {
      void endSession(false)
    }
    return (
      <div className="screen pos pos-home" data-theme={theme.resolved}>
        <header className="bar">
          {/* title + shop/staff context on the left, sound toggle and
              one kebab menu on the right — the theme switch, ล็อกจอ and
              ออกจากระบบ moved into the menu (unchanged handlers). */}
          <span className="pos-bar-id">
            <span className="brand">
              <img className="brand-icon" src="/logo.png" alt="" width={24} height={24} />
              WyV POS
            </span>
            <span className="pos-bar-context">
              {shopName ? `ร้าน ${shopName} · ${me.name}` : me.name}
            </span>
          </span>
          <span className="bar-actions">
            <PayAnnouncer />
            <TopBarMenu
              themeChoice={theme.choice}
              themeResolved={theme.resolved}
              onCycleTheme={theme.cycle}
              onLock={() => void endSession(false)}
              onLogout={() => void endSession(true)}
            />
          </span>
        </header>
        <main className="content pos-content">
          <Counter shopName={shopName} onSessionExpired={sessionExpired} onRevoked={handleRevoked} />
          {msg ? (
            <p className="error" role="alert">
              {msg}
            </p>
          ) : null}
        </main>
      </div>
    )
  }

  return null
}
