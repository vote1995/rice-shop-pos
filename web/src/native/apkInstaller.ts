//! The client half of the force-update system (feat/app-update).
//
// Three things live here:
//   1. the `ApkInstaller` Capacitor plugin wrapper (the native side is
//      implemented separately in the Android project — code to the contract,
//      see ApkInstallerPlugin below),
//   2. the pure decision helpers (parseManifest / needsBlock / isNewer /
//      buildApkUrl / progressPercent / fmtBytes / installError*). They touch
//      no DOM and no Capacitor API, so apkInstaller.test.ts can run them under
//      plain Node (the app has no test runner — see pos/points.test.ts),
//   3. the one-shot versionCode read api.ts caches for the X-App-Version
//      header of every request the native app makes.
//
// Import direction matters: this file must NEVER import api.ts (api.ts imports
// this one). api.ts reads `import.meta.env` at module scope, which does not
// exist under Node, so the test module would not even load. The API origin
// therefore travels as an argument: buildApkUrl(API_BASE, manifest.apkUrl).

import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

// ---- plugin contract (implemented on the Android side) ---------------------

/** The build this device is running, as the native plugin reports it. */
export interface AppVersionInfo {
  versionCode: number
  versionName: string
}

/** downloadAndInstall() input: everything the plugin needs to fetch + verify. */
export interface ApkInstallRequest {
  url: string
  sha256: string
  size: number
}

/** Payload of the plugin's 'progress' listener event. */
export interface ApkProgress {
  received: number
  total: number
}

/** downloadAndInstall() rejects with error.code of one of these. */
export type ApkInstallErrorCode = 'need_permission' | 'sha_mismatch' | 'download_failed'

export interface ApkInstallerPlugin {
  getVersion(): Promise<AppVersionInfo>
  /**
   * Resolves once the SYSTEM INSTALLER was launched (not once the user has
   * installed anything). Rejects with error.code 'need_permission' (the plugin
   * already opened the "install unknown apps" settings page), 'sha_mismatch'
   * or 'download_failed'.
   */
  downloadAndInstall(options: ApkInstallRequest): Promise<void>
  addListener(
    eventName: 'progress',
    listenerFunc: (progress: ApkProgress) => void,
  ): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

/** Registered by name on the native side; a stub (rejecting) proxy on web. */
export const ApkInstaller = registerPlugin<ApkInstallerPlugin>('ApkInstaller')

// ---- GET /api/app/manifest -------------------------------------------------

export interface AppManifest {
  versionCode: number
  versionName: string
  sha256: string
  size: number
  /** oldest versionCode the server still allows (minSupported > ours = block) */
  minSupported: number
  /** server-relative path; the download URL is API_BASE + apkUrl */
  apkUrl: string
}

/** typeof guard helper: one property of an unknown object. */
function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Validate GET /api/app/manifest. versionCode / sha256 / apkUrl are required
 * (without them nothing can be downloaded); minSupported, versionName and size
 * fall back to neutral defaults so a slightly-short answer still works. Anything
 * malformed is null, which callers treat as "check failed → stay silent".
 */
export function parseManifest(data: unknown): AppManifest | null {
  const versionCode = count(prop(data, 'versionCode'))
  if (versionCode === null || !Number.isInteger(versionCode) || versionCode < 0) return null
  const sha256 = text(prop(data, 'sha256'))
  if (!sha256) return null
  const apkUrl = text(prop(data, 'apkUrl'))
  if (!apkUrl) return null
  const minSupported = count(prop(data, 'minSupported'))
  const size = count(prop(data, 'size'))
  return {
    versionCode,
    versionName: text(prop(data, 'versionName')),
    sha256,
    size: size !== null && size >= 0 ? size : 0,
    minSupported: minSupported !== null && minSupported >= 0 ? minSupported : 0,
    apkUrl,
  }
}

/**
 * True when the installed build is BELOW the server's minimum: the app must be
 * blocked until it is updated. Unknown inputs never block (a broken check must
 * not lock a shop out of its till).
 */
export function needsBlock(currentVersionCode: number | null, manifest: AppManifest | null): boolean {
  if (currentVersionCode === null || manifest === null) return false
  return manifest.minSupported > currentVersionCode
}

/** True when `latestVersionCode` is newer than what we run (banner, not block). */
export function isNewer(latestVersionCode: number, currentVersionCode: number | null): boolean {
  return currentVersionCode !== null && latestVersionCode > currentVersionCode
}

/** APK download URL: API_BASE + the manifest's server-relative apkUrl. */
export function buildApkUrl(apiBase: string, apkUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(apkUrl)) return apkUrl // already absolute
  const base = apiBase.replace(/\/+$/, '')
  return `${base}${apkUrl.startsWith('/') ? '' : '/'}${apkUrl}`
}

/** 0..100, clamped both ways; 0 when the total is unknown (no division by 0). */
export function progressPercent(received: number, total: number): number {
  if (!Number.isFinite(received) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)))
}

/** "12.3 MB" — one decimal at most, whole bytes stay whole. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = Math.round(value * 10) / 10
  const shown = unit === 0 || Number.isInteger(rounded) ? String(Math.round(value)) : rounded.toFixed(1)
  return `${shown} ${units[unit]}`
}

/** The error code a plugin rejection carries ('' when it cannot be told). */
export function installErrorCode(error: unknown): string {
  const code = prop(error, 'code')
  if (typeof code === 'string' && code !== '') return code
  const message = prop(error, 'message')
  if (typeof message === 'string') {
    for (const known of ['need_permission', 'sha_mismatch', 'download_failed'] as const) {
      if (message.includes(known)) return known
    }
  }
  return ''
}

/** Thai message for a download/install failure, keyed by installErrorCode(). */
export function installErrorMessage(code: string): string {
  switch (code) {
    case 'need_permission':
      return 'ต้องอนุญาต "ติดตั้งแอปที่ไม่รู้จัก" ให้แอปนี้ แล้วกดอัปเดตอีกครั้ง'
    case 'sha_mismatch':
      return 'ไฟล์ที่ดาวน์โหลดไม่ตรงกับฉบับบนเซิร์ฟเวอร์ (ตรวจสอบไม่ผ่าน) กรุณากดอัปเดตอีกครั้ง'
    case 'package_mismatch':
      return 'ไฟล์อัปเดตไม่ตรงกับแอปนี้ (แพ็กเกจหรือลายเซ็นไม่ตรง) ติดต่อผู้ดูแลระบบ'
    case 'download_failed':
      return 'ดาวน์โหลดไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วกดอัปเดตอีกครั้ง'
    default:
      return 'ติดตั้งไม่สำเร็จ กรุณาลองอัปเดตอีกครั้ง'
  }
}

// ---- runtime (native only) -------------------------------------------------

/** True only inside the bundled Capacitor app — browsers/PWA get no gate. */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

let versionPromise: Promise<AppVersionInfo | null> | null = null

/**
 * The installed build's version, read ONCE and cached: api.ts sends it as
 * X-App-Version on every request. null when this is not the native app, or the
 * plugin is missing/unavailable — in which case no header is sent at all (the
 * server then simply cannot force an update, which is the safe default).
 */
export function nativeAppVersion(): Promise<AppVersionInfo | null> {
  if (!isNativeApp()) return Promise.resolve(null)
  if (!versionPromise) {
    versionPromise = ApkInstaller.getVersion().then(
      (v) => {
        const code = count(prop(v, 'versionCode'))
        if (code === null || !Number.isInteger(code) || code < 0) return null
        const name = prop(v, 'versionName')
        return { versionCode: code, versionName: typeof name === 'string' ? name : String(code) }
      },
      () => null, // plugin missing/threw: send nothing, never break the app
    )
  }
  return versionPromise
}

/**
 * Download + verify + launch the installer for one manifest. `onProgress`
 * mirrors the plugin's 'progress' event; a listener that cannot be attached is
 * ignored (progress is cosmetic — the install must still run).
 */
export async function downloadAndInstallApk(
  request: ApkInstallRequest,
  onProgress?: (progress: ApkProgress) => void,
): Promise<void> {
  let handle: PluginListenerHandle | null = null
  if (onProgress) {
    try {
      handle = await ApkInstaller.addListener('progress', (p) => {
        const received = count(prop(p, 'received'))
        const total = count(prop(p, 'total'))
        onProgress({ received: received !== null && received >= 0 ? received : 0, total: total !== null && total >= 0 ? total : 0 })
      })
    } catch {
      /* no progress events: carry on */
    }
  }
  try {
    await ApkInstaller.downloadAndInstall(request)
  } finally {
    if (handle) {
      try {
        await handle.remove()
      } catch {
        /* ignore */
      }
    }
  }
}
