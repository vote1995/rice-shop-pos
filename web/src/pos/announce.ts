// "ได้รับเงิน 60 บาท" out of the counter device's speaker when Beam confirms a
// PromptPay payment. Pure browser: a short chime (Web Audio) + Thai speech
// (Web Speech API, th-TH voice). Browsers only play sound after a user
// gesture on the page and suspend JS when the screen locks, so the toggle
// also holds a screen Wake Lock while it is on.
//
// The on/off choice is a per-device convenience (localStorage): only the
// counter device should speak, not every phone that is logged in.

const KEY = 'pos.announce'

let ctx: AudioContext | null = null
let wakeLock: WakeLockSentinel | null = null
const spoken = new Set<string>()

export function announceEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setAnnounceEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private mode: stays on for this page only */
  }
}

/** Call from a click/tap: browsers unlock audio + speech only inside one. */
export function unlockAudio(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (AC && !ctx) ctx = new AC()
    void ctx?.resume()
  } catch {
    /* no Web Audio: speech alone */
  }
  try {
    // an empty utterance inside the gesture unlocks speechSynthesis on iOS
    const u = new SpeechSynthesisUtterance('')
    u.volume = 0
    window.speechSynthesis?.speak(u)
  } catch {
    /* no speech synthesis */
  }
}

function chime(): Promise<void> {
  return new Promise((resolve) => {
    if (!ctx || ctx.state !== 'running') return resolve()
    const t = ctx.currentTime
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + i * 0.16)
      g.gain.exponentialRampToValueAtTime(0.35, t + i * 0.16 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3)
      o.connect(g).connect(ctx.destination)
      o.start(t + i * 0.16)
      o.stop(t + i * 0.16 + 0.32)
    }
    window.setTimeout(resolve, 480)
  })
}

function thaiVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis?.getVoices() ?? []
  return voices.find((v) => v.lang === 'th-TH') ?? voices.find((v) => v.lang.toLowerCase().startsWith('th'))
}

/** True when this browser can speak Thai (voices load lazily on Chrome). */
export function hasThaiVoice(): boolean {
  return thaiVoice() !== undefined
}

function speak(text: string): void {
  const synth = window.speechSynthesis
  if (!synth) return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'th-TH'
  const v = thaiVoice()
  if (v) u.voice = v
  u.rate = 0.95
  u.volume = 1
  synth.speak(u)
}

/** "60 บาท" / "60 บาท 50 สตางค์" */
function bahtWords(satang: number): string {
  const b = Math.floor(satang / 100)
  const s = satang % 100
  return s > 0 ? `${b} บาท ${s} สตางค์` : `${b} บาท`
}

/** Speaks one confirmed payment once (deduped by payment id across callers). */
export function announcePaid(paymentId: string, amountSatang: number, queueNumber: number): void {
  if (!announceEnabled() || spoken.has(paymentId)) return
  spoken.add(paymentId)
  void chime().then(() => speak(`ได้รับเงิน ${bahtWords(amountSatang)} คิว ${queueNumber}`))
}

/** Marks payments as already spoken (e.g. ones confirmed before the page opened). */
export function markSpoken(paymentId: string): void {
  spoken.add(paymentId)
}

/** Keeps the screen on while announcing is on and the page is visible. */
export async function holdWakeLock(on: boolean): Promise<void> {
  try {
    if (on && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen')
    } else if (!on && wakeLock) {
      await wakeLock.release()
      wakeLock = null
    }
  } catch {
    /* denied / unsupported (needs HTTPS): the screen may sleep */
  }
}

/** Test button: proves sound + Thai voice work on this device. */
export function testAnnounce(): void {
  unlockAudio()
  void chime().then(() => speak('เปิดเสียงประกาศเงินเข้าแล้ว'))
}
