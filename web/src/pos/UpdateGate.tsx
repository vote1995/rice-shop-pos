import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE, getAppManifest, getLatestVersionCode, getUpgradeRequired, subscribeAppVersion } from '../api'
import {
  buildApkUrl,
  downloadAndInstallApk,
  installErrorCode,
  installErrorMessage,
  isNativeApp,
  isNewer,
  needsBlock,
  nativeAppVersion,
  parseManifest,
  progressPercent,
  fmtBytes,
} from '../native/apkInstaller'
import type { AppManifest } from '../native/apkInstaller'

/**
 * Force-update gate of the Android app (native only; browsers/PWA render
 * nothing). Two faces:
 *  - blocking overlay: the server answered 426, or the manifest says our
 *    versionCode < minSupported. Not dismissible, nothing underneath clickable.
 *  - dismissible banner: a newer build exists but ours is still allowed.
 * A manifest check that fails (offline, 5xx, not logged in yet) is SILENT: only
 * a definite 426 / minSupported answer ever blocks.
 */
export default function UpdateGate() {
  if (!isNativeApp()) return null
  return <Gate />
}

function Gate() {
  const [current, setCurrent] = useState<{ versionCode: number; versionName: string } | null>(null)
  const [manifest, setManifest] = useState<AppManifest | null>(null)
  const [, bump] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [percent, setPercent] = useState(0)
  const [received, setReceived] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const checking = useRef(false)

  // 426 / X-App-Latest recorded by api.ts -> re-render
  useEffect(() => subscribeAppVersion(() => bump((n) => n + 1)), [])

  useEffect(() => {
    let alive = true
    void nativeAppVersion().then((v) => {
      if (alive) setCurrent(v)
    })
    return () => {
      alive = false
    }
  }, [])

  const check = useCallback(async (): Promise<AppManifest | null> => {
    if (checking.current) return null
    checking.current = true
    try {
      const m = parseManifest(await getAppManifest())
      if (m) setManifest(m)
      return m
    } catch {
      return null // silent: offline / 5xx / not signed in
    } finally {
      checking.current = false
    }
  }, [])

  // startup + whenever the app comes back to the foreground
  useEffect(() => {
    void check()
    const onVis = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [check])

  const upgrade = getUpgradeRequired()
  const latestHeader = getLatestVersionCode()
  const currentCode = current?.versionCode ?? null
  const blocked = upgrade !== null || needsBlock(currentCode, manifest)
  const newerKnown =
    (manifest !== null && isNewer(manifest.versionCode, currentCode)) ||
    (latestHeader !== null && isNewer(latestHeader, currentCode))

  // a 426 / newer header without a manifest yet: fetch it so the button can work
  useEffect(() => {
    if ((blocked || newerKnown) && manifest === null) void check()
  }, [blocked, newerKnown, manifest, check])

  const install = useCallback(async () => {
    setBusy(true)
    setError('')
    setPercent(0)
    setReceived(0)
    setTotal(0)
    try {
      // the apkUrl is signed for a few minutes: always take a fresh manifest
      const m = parseManifest(await getAppManifest())
      if (!m) throw new Error('manifest')
      setManifest(m)
      await downloadAndInstallApk(
        { url: buildApkUrl(API_BASE, m.apkUrl), sha256: m.sha256, size: m.size },
        (p) => {
          setReceived(p.received)
          setTotal(p.total)
          setPercent(progressPercent(p.received, p.total))
        },
      )
    } catch (e) {
      const code = installErrorCode(e)
      setError(
        code === '' && e instanceof Error && e.message === 'manifest'
          ? 'ไม่พบไฟล์อัปเดตบนเซิร์ฟเวอร์ ลองใหม่อีกครั้ง'
          : installErrorMessage(code),
      )
    } finally {
      setBusy(false)
    }
  }, [])

  if (!blocked && !(newerKnown && !dismissed)) return null

  const from = current ? current.versionName || String(current.versionCode) : ''
  const to = manifest ? manifest.versionName || String(manifest.versionCode) : ''

  if (!blocked) {
    return (
      <div className="pos-upbanner" role="status">
        <span className="pos-upbanner-text">
          มีเวอร์ชันใหม่{to ? ` ${to}` : ''}
          {busy ? <small>กำลังดาวน์โหลด {percent}%</small> : error ? <small>{error}</small> : null}
        </span>
        <button className="pos-upbanner-btn" disabled={busy} onClick={() => void install()}>
          อัปเดต
        </button>
        <button className="pos-upbanner-x" aria-label="ปิด" disabled={busy} onClick={() => setDismissed(true)}>
          ✕
        </button>
      </div>
    )
  }

  return (
    <div className="pos-upgate" role="alertdialog" aria-modal="true" aria-label="ต้องอัปเดตแอป">
      <div className="pos-upgate-card">
        <h2 className="pos-upgate-title">ต้องอัปเดตแอปก่อนใช้งาน</h2>
        {from || to ? (
          <p className="pos-upgate-versions">
            {from}
            {from && to ? ' → ' : ''}
            {to}
          </p>
        ) : null}
        <p className="pos-upgate-why">เวอร์ชันนี้เก่าเกินไปและใช้งานต่อไม่ได้ กดอัปเดต แล้วกด "ติดตั้ง" เมื่อระบบถาม</p>
        {busy ? (
          <div className="pos-upgate-progress">
            <span className="pos-upgate-bar">
              <span className="pos-upgate-fill" style={{ width: `${percent}%` }} />
            </span>
            <p className="pos-upgate-progress-text">
              {percent}%{total > 0 ? ` · ${fmtBytes(received)} / ${fmtBytes(total)}` : ''}
            </p>
          </div>
        ) : null}
        {error ? (
          <p className="pos-upgate-msg error" role="alert">
            {error}
          </p>
        ) : null}
        <button className="pos-upgate-btn" disabled={busy} onClick={() => void install()}>
          {busy ? 'กำลังดาวน์โหลด…' : error ? 'ลองอีกครั้ง' : 'อัปเดตเดี๋ยวนี้'}
        </button>
      </div>
    </div>
  )
}
