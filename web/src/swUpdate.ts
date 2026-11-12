// Service worker lifecycle for the offline PWA shell (pos.* only; see main.tsx).
//
// Why this exists: a PWA that sits in the background for days keeps running the
// JS it loaded, and the browser only re-checks /sw.js on a navigation. Even
// when a new worker installs (autoUpdate = skipWaiting + clientsClaim), the
// page that is already open keeps the OLD code, and the first reload is still
// answered by the OLD precache while the new worker installs. Reloading "does
// nothing" until a second reload. So we (1) ask for an update whenever the app
// comes back to the foreground and every 15 minutes, (2) reload once the new
// worker has taken control — immediately when the page is hidden or was just
// opened, otherwise the next time it goes to the background (never in the
// middle of a sale), and (3) offer a manual "clear cache + reload" escape hatch.

const CHECK_EVERY_MS = 15 * 60 * 1000
/** A page younger than this reloads at once on an update (nothing to lose yet). */
const FRESH_PAGE_MS = 8_000
const RELOAD_GUARD_KEY = 'pos.swReloadAt'
const RELOAD_GUARD_MS = 30_000

function reloadOnce(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0')
    if (Date.now() - last < RELOAD_GUARD_MS) return // never loop
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
  } catch {
    /* storage blocked: reload anyway, controllerchange fires once per update */
  }
  window.location.reload()
}

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  const loadedAt = Date.now()
  // A first-ever install also fires controllerchange (clientsClaim): only an
  // UPDATE (the page already had a controller) needs a reload.
  const hadController = navigator.serviceWorker.controller !== null
  let pendingReload = false

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return
    if (document.visibilityState === 'hidden' || Date.now() - loadedAt < FRESH_PAGE_MS) {
      reloadOnce()
    } else {
      pendingReload = true
    }
  })

  void navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      const check = () => {
        reg.update().catch(() => {
          /* offline / transient: try again on the next tick */
        })
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
        else if (pendingReload) reloadOnce() // went to the background: safe to swap
      })
      window.addEventListener('online', check)
      window.setInterval(check, CHECK_EVERY_MS)
      check()
    })
    .catch(() => {
      /* no SW (private mode, blocked): the app still works online */
    })
}

/** Manual escape hatch: drop every worker + cache, then load fresh from the network. */
export async function clearCacheAndReload(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } finally {
    // a cache-busting query: nothing in between can answer it from an old copy
    window.location.replace(`${window.location.pathname}?fresh=${Date.now()}`)
  }
}
