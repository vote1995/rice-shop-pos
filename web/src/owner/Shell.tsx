//! OWNER app shell (UI-1) — the SaaS-dashboard chrome around the owner
//! panels: a fixed left sidebar on desktop (collapsible to a 72px icon rail,
//! remembered in localStorage), an off-canvas drawer + sticky top bar on
//! mobile, and a light/dark theme switch that follows the system by default.
//!
//! Everything here is styled by the `.owner` scope in styles.css, so the
//! staff POS keeps its own green tokens. No icon library and no emoji: the
//! nav icons are the inline SVG line paths in ICONS below.
//!
//! The sidebar also hosts the shop switcher (UI-2) and the device-approval
//! badge. The switcher card is the ONE shop picker of the app: it reads the
//! shared selection of shopContext (loaded once by OwnerApp), so no panel
//! renders a "ร้าน" select of its own anymore.

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useOwnerShop } from './shopContext'

export type OwnerPage = 'report' | 'orders' | 'menu' | 'stock' | 'slips' | 'staff' | 'devices' | 'shops'
export type ThemeChoice = 'light' | 'dark' | 'system'

/** localStorage keys of the shell preferences. */
const THEME_KEY = 'owner.theme'
const SIDEBAR_KEY = 'owner.sidebar'

export const PAGE_TITLES: Record<OwnerPage, string> = {
  report: 'สรุปยอด',
  orders: 'บิลรายวัน',
  menu: 'เมนู',
  stock: 'สต็อก',
  slips: 'สลิปซื้อของ',
  staff: 'พนักงาน',
  devices: 'เครื่อง',
  shops: 'ร้าน',
}

const NAV: Array<{ label: string; items: Array<{ id: OwnerPage; icon: IconName }> }> = [
  {
    label: 'การขาย',
    items: [
      { id: 'report', icon: 'chart' },
      { id: 'orders', icon: 'receipt' },
    ],
  },
  {
    label: 'เมนูและสต็อก',
    items: [
      { id: 'menu', icon: 'bowl' },
      { id: 'stock', icon: 'box' },
      { id: 'slips', icon: 'slip' },
    ],
  },
  {
    label: 'ร้านและทีม',
    items: [
      { id: 'staff', icon: 'users' },
      { id: 'devices', icon: 'device' },
      { id: 'shops', icon: 'store' },
    ],
  },
]

const THEMES: Array<{ id: ThemeChoice; label: string; icon: IconName }> = [
  { id: 'light', label: 'สว่าง', icon: 'sun' },
  { id: 'dark', label: 'มืด', icon: 'moon' },
  { id: 'system', label: 'ตามระบบ', icon: 'system' },
]

// ---------------------------------------------------------------------------
// Inline SVG line icons (24px grid, stroked with currentColor)
// ---------------------------------------------------------------------------

type IconName =
  | 'chart'
  | 'receipt'
  | 'bowl'
  | 'box'
  | 'slip'
  | 'users'
  | 'device'
  | 'store'
  | 'menu'
  | 'x'
  | 'collapse'
  | 'sun'
  | 'moon'
  | 'system'

const ICONS: Record<IconName, ReactNode> = {
  chart: (
    <>
      <path d="M3 21h18" />
      <path d="M6 21v-7" />
      <path d="M11 21V9" />
      <path d="M16 21v-4" />
      <path d="M21 21V4" />
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
  box: (
    <>
      <path d="M3.5 8 12 4l8.5 4v8L12 20l-8.5-4z" />
      <path d="M3.5 8 12 12l8.5-4" />
      <path d="M12 12v8" />
    </>
  ),
  slip: (
    <>
      <path d="M6.5 3h11v18h-11z" />
      <path d="M9.5 8h5" />
      <path d="M9.5 12h5" />
      <path d="M9.5 16h3" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6" />
      <path d="M18 20c0-2-.4-3.4-1.2-4.4" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8.5 21h7" />
      <path d="M12 17v4" />
    </>
  ),
  store: (
    <>
      <path d="M4.5 10.5V20h15v-9.5" />
      <path d="M3 10.5 5.2 4h13.6L21 10.5z" />
      <path d="M3 10.5h18" />
      <path d="M9.5 20v-5.5h5V20" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  collapse: (
    <>
      <path d="M11.5 7.5 7 12l4.5 4.5" />
      <path d="M18 7.5 13.5 12 18 16.5" />
    </>
  ),
  sun: (
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
  ),
  moon: (
    <>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </>
  ),
  system: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8.5 21h7" />
      <path d="M12 17v4" />
    </>
  ),
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
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
// Theme: light / dark / follow-the-system (default), kept in localStorage
// ---------------------------------------------------------------------------

function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** The theme choice + the resolved value the root element is rendered with. */
export function useOwnerTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark'; set: (c: ThemeChoice) => void } {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme)
  const [systemDark, setSystemDark] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  // "ตามระบบ" follows the OS live, including while the tab is open.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  function set(c: ThemeChoice) {
    try {
      localStorage.setItem(THEME_KEY, c)
    } catch {
      /* private mode: keep the choice for this session only */
    }
    setChoice(c)
  }

  return { choice, resolved: choice === 'system' ? (systemDark ? 'dark' : 'light') : choice, set }
}

/** Collapsed sidebar (desktop only), remembered across sessions. */
function useSidebarRail(): [boolean, () => void] {
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === 'rail'
    } catch {
      return false
    }
  })
  function toggle() {
    setRail((v) => {
      const next = !v
      try {
        localStorage.setItem(SIDEBAR_KEY, next ? 'rail' : 'full')
      } catch {
        /* ignore */
      }
      return next
    })
  }
  return [rail, toggle]
}

/** Today's Bangkok date as the page subtitle, e.g. "วันศุกร์ 16 มกราคม 2569". */
function bangkokTodayLabel(): string {
  try {
    return new Intl.DateTimeFormat('th-TH', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Asia/Bangkok',
    }).format(new Date())
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Shop switcher (UI-2): the sidebar card IS the picker
// ---------------------------------------------------------------------------

/**
 * The current shop + "ร้าน x จาก n"; tapping it opens the list of shops right
 * below the card (inside the drawer on mobile). With a single shop it is a
 * plain card — nothing to switch. The card is a <div> either way, so the rail
 * stays a 44px icon column.
 */
function ShopSwitcher() {
  const { shops, shopId, setShopId } = useOwnerShop()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  const idx = shops.findIndex((s) => s.id === shopId) + 1
  const current = shops.find((s) => s.id === shopId) ?? null
  const pickable = shops.length > 1

  // the list closes on Escape and on any tap outside of it (the drawer and
  // the popover are both inside `wrap`, so tapping the nav closes it too)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: PointerEvent) => {
      if (wrap.current !== null && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  function pick(id: string) {
    setOpen(false)
    if (id !== shopId) setShopId(id)
  }

  return (
    <div className="shop-switch" ref={wrap}>
      {pickable ? (
        <button
          type="button"
          className="shop-card"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="เปลี่ยนร้าน"
          title={current?.name ?? undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="shop-ic">
            <Icon name="store" size={18} />
          </span>
          <span className="shop-text">
            <span className="shop-name">{current?.name ?? 'ยังไม่มีร้าน'}</span>
            <span className="muted small shop-sub">
              ร้าน {idx} จาก {shops.length}
            </span>
          </span>
          <span className={`shop-caret ${open ? 'on' : ''}`} aria-hidden="true">
            <Icon name="collapse" size={16} />
          </span>
        </button>
      ) : (
        <div className="shop-card" title={current?.name ?? undefined}>
          <span className="shop-ic">
            <Icon name="store" size={18} />
          </span>
          <span className="shop-text">
            <span className="shop-name">{current?.name ?? 'ยังไม่มีร้าน'}</span>
            {shops.length === 0 ? <span className="muted small shop-sub">สร้างร้านในหน้า "ร้าน"</span> : null}
          </span>
        </div>
      )}

      {open && pickable ? (
        <div className="shop-menu" role="listbox" aria-label="เลือกร้าน">
          {shops.map((s) => (
            <button
              type="button"
              key={s.id}
              role="option"
              aria-selected={s.id === shopId}
              className={`shop-opt${s.id === shopId ? ' on' : ''}`}
              onClick={() => pick(s.id)}
            >
              <span className="nav-ic">
                <Icon name="store" size={16} />
              </span>
              <span className="shop-name">{s.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function Shell({
  page,
  onNav,
  theme,
  email,
  pendingDevices,
  children,
}: {
  page: OwnerPage
  onNav: (p: OwnerPage) => void
  theme: { choice: ThemeChoice; resolved: 'light' | 'dark'; set: (c: ThemeChoice) => void }
  /** owner email, shown small and muted in the sidebar footer */
  email: string
  /** devices waiting for approval (nav badge); 0/undefined = no badge */
  pendingDevices: number
  children: ReactNode
}) {
  const [rail, toggleRail] = useSidebarRail()
  const [drawer, setDrawer] = useState(false)
  const subtitle = useState(bangkokTodayLabel)[0]

  // the mobile drawer closes on Escape
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer])

  function go(p: OwnerPage) {
    setDrawer(false)
    onNav(p)
  }

  return (
    <div className="owner owner-shell" data-theme={theme.resolved} data-rail={rail ? 'on' : 'off'} data-drawer={drawer ? 'open' : 'closed'}>
      {/* ---- mobile top app bar ---- */}
      <header className="shell-top">
        <button type="button" className="icon-btn" aria-label="เมนู" onClick={() => setDrawer(true)}>
          <Icon name="menu" />
        </button>
        <span className="shell-top-title">{PAGE_TITLES[page]}</span>
        <button
          type="button"
          className="icon-btn"
          aria-label={theme.resolved === 'dark' ? 'เปลี่ยนเป็นธีมสว่าง' : 'เปลี่ยนเป็นธีมมืด'}
          onClick={() => theme.set(theme.resolved === 'dark' ? 'light' : 'dark')}
        >
          <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} />
        </button>
      </header>

      {/* ---- mobile drawer backdrop ---- */}
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="ปิดเมนู"
        tabIndex={-1}
        onClick={() => setDrawer(false)}
      />

      {/* ---- sidebar (fixed column on desktop, off-canvas on mobile) ---- */}
      <aside className="sidebar" aria-label="เมนูเจ้าของร้าน">
        <div className="side-brand">
          <span className="brand-row">
            <span className="brand-logo" aria-hidden="true">
              ร
            </span>
            <span className="brand-name">
              POS ร้านข้าว
              <small>แดชบอร์ดเจ้าของร้าน</small>
            </span>
          </span>
          <button type="button" className="icon-btn collapse-btn" aria-label="ย่อแถบเมนู" onClick={toggleRail}>
            <Icon name="collapse" size={18} />
          </button>
          <button type="button" className="icon-btn close-btn" aria-label="ปิดเมนู" onClick={() => setDrawer(false)}>
            <Icon name="x" size={20} />
          </button>
        </div>

        <div className="side-scroll">
          <ShopSwitcher />

          <nav className="side-nav">
            {NAV.map((g) => (
              <div className="nav-group" key={g.label}>
                <p className="nav-group-label">{g.label}</p>
                {g.items.map((it) => {
                  const on = page === it.id
                  const badge = it.id === 'devices' && pendingDevices > 0 ? pendingDevices : null
                  return (
                    <button
                      type="button"
                      key={it.id}
                      className={`nav-item${on ? ' on' : ''}`}
                      aria-current={on ? 'page' : undefined}
                      title={PAGE_TITLES[it.id]}
                      onClick={() => go(it.id)}
                    >
                      <span className="nav-ic">
                        <Icon name={it.icon} />
                      </span>
                      <span className="nav-label">{PAGE_TITLES[it.id]}</span>
                      {badge !== null ? <span className="nav-badge">{badge}</span> : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        </div>

        <div className="side-foot">
          <div className="theme-seg" role="group" aria-label="ธีมสี">
            {THEMES.map((t) => (
              <button
                type="button"
                key={t.id}
                className={theme.choice === t.id ? 'on' : ''}
                aria-pressed={theme.choice === t.id}
                title={t.label}
                onClick={() => theme.set(t.id)}
              >
                <Icon name={t.icon} size={16} />
                <span className="theme-label">{t.label}</span>
              </button>
            ))}
          </div>
          <p className="muted small side-email">{email || '…'}</p>
        </div>
      </aside>

      {/* ---- content ---- */}
      <main className="shell-main">
        <div className="shell-content">
          <header className="page-head">
            <h1>{PAGE_TITLES[page]}</h1>
            <p className="muted small page-sub">{subtitle}</p>
          </header>
          {children}
        </div>
      </main>
    </div>
  )
}
