// The POS top-bar kebab menu + the native status-bar style hook.
// The header used to cram the app title, shop name and four controls into
// one row on a phone; it is now title left + the sound toggle and ONE
// "เมนู" button right. The dropdown hosts รีเฟรชข้อมูล (manual data refresh,
// first item, with the last-update time under the label), the theme switch,
// ล็อกจอ and ออกจากระบบ (same handlers/behaviour as before — they only
// moved here). The header lives solely on the 'home' screen, so any
// screen/tab change unmounts this component and closes the dropdown with it.

import { useEffect, useRef, useState } from 'react'
import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { requestRefresh, useRefreshStatus } from './dataRefresh'

export type ThemeChoice = 'light' | 'dark' | 'system'

// Menu labels reuse the existing theme choices (สว่าง / มืด / ตามระบบ) with
// a "โหมด" prefix so the item reads as a switch: โหมดสว่าง / โหมดมืด.
const THEME_ITEM_LABEL: Record<ThemeChoice, string> = {
  light: 'โหมดสว่าง',
  dark: 'โหมดมืด',
  system: 'โหมดตามระบบ',
}

/**
 * Keep the Android status-bar icons readable against the app theme.
 * Capacitor 8 SystemBars naming (per the typings/doc comment in
 * @capacitor/core): `Dark` = LIGHT system-bar content on a dark background,
 * `Light` = dark content on a light background. So the dark theme takes
 * `Dark` (light icons) and the light theme takes `Light` (dark icons).
 * Native app only — a no-op in the browser; a rejected call keeps the
 * current style instead of breaking the UI.
 */
export async function applyStatusBarStyle(resolved: 'light' | 'dark'): Promise<void> {
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  if (cap?.isNativePlatform?.() !== true) return
  try {
    await SystemBars.setStyle({
      style: resolved === 'dark' ? SystemBarsStyle.Dark : SystemBarsStyle.Light,
    })
  } catch {
    /* plugin not available in this build: keep the current style */
  }
}

/** Sun / moon / monitor line icon of the theme choice (no icon library). */
function ThemeIcon({ choice, resolved }: { choice: ThemeChoice; resolved: 'light' | 'dark' }) {
  const glyph =
    choice === 'system' ? (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8.5 21h7" />
        <path d="M12 17v4" />
      </>
    ) : resolved === 'dark' ? (
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    ) : (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2" />
        <path d="M12 19.5v2" />
        <path d="M2.5 12h2" />
        <path d="M19.5 12h2" />
        <path d="M5.2 5.2l1.4 1.4" />
        <path d="M17.4 17.4l1.4 1.4" />
        <path d="M18.8 5.2l-1.4 1.4" />
        <path d="M6.6 17.4l-1.4 1.4" />
      </>
    )
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  )
}

/** Padlock line icon for ล็อกจอ. */
function LockIcon() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

/**
 * Circular-arrow line icon for รีเฟรชข้อมูล; spins (CSS, respects
 * prefers-reduced-motion) while a refresh is in flight.
 */
function RefreshIcon({ spin }: { spin: boolean }) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={spin ? 'pos-refresh-spin' : undefined}
    >
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

/** "14:05" — 24 h Bangkok clock of a unix-ms stamp (the device may sit in
 *  another timezone, so the label always matches the shop's day). */
function fmtHm(ms: number): string {
  try {
    return new Intl.DateTimeFormat('th-TH', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'Asia/Bangkok',
    }).format(new Date(ms))
  } catch {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

/** Door/arrow line icon for ออกจากระบบ. */
function LogoutIcon() {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  )
}

interface TopBarMenuProps {
  themeChoice: ThemeChoice
  themeResolved: 'light' | 'dark'
  /** Cycles สว่าง -> มืด -> ตามระบบ (the previous header button's logic). */
  onCycleTheme: () => void
  /** ล็อกจอ: back to the PIN screen for the same user. */
  onLock: () => void
  /** ออกจากระบบ: back to the staff picker. */
  onLogout: () => void
}

export default function TopBarMenu({
  themeChoice,
  themeResolved,
  onCycleTheme,
  onLock,
  onLogout,
}: TopBarMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  /** Shared menu-data freshness (set by Counter's refresh pipeline). */
  const refresh = useRefreshStatus()

  // close on outside tap/click and on Escape (document-level pointerdown:
  // fires on touch in the Android WebView too, before the click lands)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      btnRef.current?.focus() // hand focus back to the trigger button
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** Selecting an item always closes the menu first, then runs the action. */
  function select(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <div className="pos-topmenu" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="bar-btn pos-menu-btn"
        aria-label="เมนู"
        aria-haspopup="menu"
        aria-expanded={open}
        title="เมนู"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden="true" focusable="false">
          <circle cx="12" cy="5" r="2" fill="currentColor" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <circle cx="12" cy="19" r="2" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <div className="pos-topmenu-panel" role="menu">
          <button
            type="button"
            role="menuitem"
            className="pos-topmenu-item"
            disabled={refresh.busy}
            onClick={() => select(() => requestRefresh())}
          >
            <span className="pos-topmenu-ic" aria-hidden="true">
              <RefreshIcon spin={refresh.busy} />
            </span>
            <span className="pos-topmenu-text">
              รีเฟรชข้อมูล
              <span
                className={refresh.failed ? 'pos-topmenu-sub warn' : 'pos-topmenu-sub'}
              >
                {refresh.failed
                  ? 'ดึงข้อมูลไม่สำเร็จ'
                  : refresh.lastUpdated === null
                    ? 'ยังไม่ได้อัปเดต'
                    : `อัปเดตล่าสุด ${fmtHm(refresh.lastUpdated)}`}
              </span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pos-topmenu-item"
            aria-label="สลับธีม"
            title={THEME_ITEM_LABEL[themeChoice]}
            onClick={() => select(onCycleTheme)}
          >
            <span className="pos-topmenu-ic" aria-hidden="true">
              <ThemeIcon choice={themeChoice} resolved={themeResolved} />
            </span>
            {THEME_ITEM_LABEL[themeChoice]}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pos-topmenu-item"
            onClick={() => select(onLock)}
          >
            <span className="pos-topmenu-ic" aria-hidden="true">
              <LockIcon />
            </span>
            ล็อกจอ
          </button>
          <span className="pos-topmenu-sep" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="pos-topmenu-item danger"
            onClick={() => select(onLogout)}
          >
            <span className="pos-topmenu-ic" aria-hidden="true">
              <LogoutIcon />
            </span>
            ออกจากระบบ
          </button>
        </div>
      ) : null}
    </div>
  )
}
