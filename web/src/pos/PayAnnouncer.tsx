// Header toggle "เสียงประกาศเงินเข้า" + the poll behind it. While on, this
// device asks the server every few seconds which PromptPay payments Beam has
// confirmed since the last ask and speaks each one (announce.ts). Off = no
// polling at all.

import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import {
  announceEnabled,
  announcePaid,
  holdWakeLock,
  setAnnounceEnabled,
  testAnnounce,
  unlockAudio,
} from './announce'

const POLL_MS = 4000

interface Recent {
  payments: Array<{ id: string; amount: number; queue_number: number; confirmed_at: number }>
  cursor: number
}

export default function PayAnnouncer() {
  const [on, setOn] = useState(announceEnabled)
  const cursor = useRef<number | null>(null)

  // browsers unlock sound only inside a gesture: any tap on the page will do
  // (the PIN pad tap that opened this screen usually already counted)
  useEffect(() => {
    if (!on) return
    const unlock = () => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [on])

  useEffect(() => {
    void holdWakeLock(on)
    if (!on) return
    const onVis = () => void holdWakeLock(true)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void holdWakeLock(false)
    }
  }, [on])

  useEffect(() => {
    if (!on) return
    let live = true
    cursor.current = null
    const tick = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const q = cursor.current === null ? '' : `?since=${cursor.current}`
        const r = await api<Recent>('GET', `/api/payments/recent${q}`, undefined, 'both')
        if (!live) return
        for (const p of r.payments) announcePaid(p.id, p.amount, p.queue_number)
        cursor.current = r.cursor
      } catch {
        /* offline / session: the next tick retries; Counter handles logouts */
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [on])

  return (
    <button
      type="button"
      className={`bar-btn pos-announce-btn${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'ปิดเสียงประกาศเงินเข้า' : 'เปิดเสียงประกาศเงินเข้า'}
      title={on ? 'เสียงประกาศเงินเข้า: เปิด' : 'เสียงประกาศเงินเข้า: ปิด'}
      onClick={() => {
        const next = !on
        setAnnounceEnabled(next)
        setOn(next)
        if (next) testAnnounce()
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" />
        {on ? (
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
        ) : (
          <path d="m16 9 5 6M21 9l-5 6" />
        )}
      </svg>
      <span className="pos-announce-label">{on ? 'เสียงเปิด' : 'เสียงปิด'}</span>
    </button>
  )
}
