//! Tiny dependency-free refresh bus + status store for the POS data.
//!
//! The counter keeps its data fresh with focus/online/timer triggers instead
//! of heavy polling (the server sends ETag + `Cache-Control: private,
//! no-cache` on GET /api/menu, so the browser/WebView HTTP cache revalidates
//! by itself — no If-None-Match handling here). This module is the glue:
//!
//! - requestRefresh()/onRefreshRequest(): the ⋮ menu item "รีเฟรชข้อมูล"
//!   broadcasts one window event; every mounted data holder (Counter,
//!   StockCount) refetches NOW.
//! - markRefreshOk/markRefreshFailed/setRefreshBusy: one shared status that
//!   the menu item renders ("อัปเดตล่าสุด HH:mm", spinning icon while busy).
//!
//! No React dependency in the store itself; useRefreshStatus() is the only
//! React touch (useSyncExternalStore over the same module-level snapshot).

import { useSyncExternalStore } from 'react'

/** window event name of the manual refresh request. */
export const REFRESH_EVENT = 'pos:refresh'

export interface RefreshStatus {
  /** unix ms of the last successful refresh; null = none yet this session */
  lastUpdated: number | null
  /** the last refresh attempt failed (the previous data stays on screen) */
  failed: boolean
  /** a refresh is in flight (the ⋮ item spins and is disabled) */
  busy: boolean
}

let status: RefreshStatus = { lastUpdated: null, failed: false, busy: false }
const listeners = new Set<() => void>()

function publish(next: RefreshStatus): void {
  status = next
  for (const notify of listeners) notify()
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

/** Manual refresh: the ⋮ menu item broadcasts; Counter/StockCount listen. */
export function requestRefresh(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT))
}

/** Subscribe to refresh requests. Returns the unsubscribe function. */
export function onRefreshRequest(cb: () => void): () => void {
  const handler = () => cb()
  window.addEventListener(REFRESH_EVENT, handler)
  return () => window.removeEventListener(REFRESH_EVENT, handler)
}

/** The last refresh landed: stamp it and clear the failure flag. */
export function markRefreshOk(): void {
  publish({ lastUpdated: Date.now(), failed: false, busy: status.busy })
}

/** The last refresh attempt failed; the stale data stays on screen. */
export function markRefreshFailed(): void {
  if (status.failed) return
  publish({ ...status, failed: true })
}

/** Tracks the in-flight refresh (the ⋮ item spins and is disabled). */
export function setRefreshBusy(busy: boolean): void {
  if (status.busy === busy) return
  publish({ ...status, busy })
}

/** The shared status for the ⋮ menu item (re-renders on every change). */
export function useRefreshStatus(): RefreshStatus {
  return useSyncExternalStore(subscribe, () => status)
}
