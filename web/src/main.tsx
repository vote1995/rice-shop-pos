import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { API_BASE } from './api'
import PosApp from './pos/PosApp'
import OwnerApp from './owner/OwnerApp'

// The Capacitor Android build (staff POS only). The app is bundled and served
// from https://localhost, so the API lives on another origin (API_BASE from
// .env.android) — detected either by that env var (build-time) or by the
// Capacitor bridge object the native WebView injects (runtime, no npm dep).
// NOTE: no `import ... from '@capacitor/core'` anywhere — a window check is
// enough and keeps the web bundle dependency-free.
const capBridge = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
const isNativeApp = API_BASE !== '' || capBridge?.isNativePlatform?.() === true

// Service worker policy (see vite.config.ts injectRegister:false).
// - owner.* is behind Cloudflare Access: once the session cookie expires every
//   navigation 302s to the login host, so a cached SW can never fetch an update
//   and the owner is pinned to a stale build. We therefore keep the owner app
//   SW-free: unregister any SW a previous build left behind and drop its caches
//   so already-affected devices self-heal on the next load.
// - Every other host (pos.*, LAN, localhost) keeps the offline PWA shell.
// - The native app build registers no SW either: the bundle is on-device (no
//   updates to fetch through it) and its API is cross-origin, which a
//   same-origin navigateFallback SW must never touch.
const isOwnerHost =
  window.location.hostname.startsWith('owner.') ||
  (!window.location.hostname.startsWith('pos.') &&
    window.location.pathname.startsWith('/owner'))

if ('serviceWorker' in navigator && !isNativeApp) {
  if (isOwnerHost) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) void reg.unregister()
    })
    if (typeof caches !== 'undefined') {
      caches.keys().then((keys) => {
        for (const key of keys) void caches.delete(key)
      })
    }
  } else {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/sw.js')
    })
  }
}

// Runs before React mounts. pos.* is NOT behind Cloudflare Access, so /owner served
// there has no Access JWT and every owner API call 401s — bounce such requests to the
// owner.* host (Access-protected), keeping protocol, port, path, search and hash.
// Only hostnames starting with "pos." redirect; localhost / 127.0.0.1 / LAN IPs /
// anything else serve /owner directly so local development keeps working.
if (
  window.location.hostname.startsWith('pos.') &&
  (window.location.pathname === '/owner' || window.location.pathname.startsWith('/owner/'))
) {
  const ownerHost = window.location.hostname.replace(/^pos\./, 'owner.')
  const { protocol, port, pathname, search, hash } = window.location
  window.location.replace(
    `${protocol}//${ownerHost}${port ? `:${port}` : ''}${pathname}${search}${hash}`,
  )
} else {
  function pickApp() {
    // Native app build: staff POS only — owner mode is compiled out of reach
    // (the /owner path and owner.* host checks below never apply to it).
    if (isNativeApp) return <PosApp />
    // Owner mode: owner.* subdomain (production, behind Cloudflare Access) or /owner path (dev).
    if (window.location.hostname.startsWith('owner.')) return <OwnerApp />
    if (window.location.pathname.startsWith('/owner')) return <OwnerApp />
    return <PosApp />
  }

  createRoot(document.getElementById('root')!).render(<StrictMode>{pickApp()}</StrictMode>)
}
