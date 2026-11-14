// "ได้รับเงิน 60 บาท" out of the counter device's speaker when Beam confirms a
// PromptPay payment. Two speak paths:
//  - Browser: a short chime (Web Audio) + Thai speech (Web Speech API, th-TH
//    voice). Browsers only play sound after a user gesture on the page and
//    suspend JS when the screen locks, so the toggle also holds a screen
//    Wake Lock while it is on.
//  - Native app (Capacitor/Android): the WebView has NO Web Speech API
//    (window.speechSynthesis is undefined there), so the chime still plays
//    through Web Audio but the Thai words go through the
//    @capacitor-community/text-to-speech plugin (Android TTS engine).
//
// The on/off choice is a per-device convenience (localStorage): only the
// counter device should speak, not every phone that is logged in.

import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { chimePeakGain } from './announceVolume'

const KEY = 'pos.announce'

let ctx: AudioContext | null = null
let wakeLock: WakeLockSentinel | null = null
let speechUnlocked = false
const spoken = new Set<string>()

// --- native (Capacitor) detection -------------------------------------------

// The Capacitor runtime injects `window.Capacitor` before this bundle runs,
// so detection needs no @capacitor/core import (which keeps the browser
// bundle untouched). Checked once; the app cannot become native mid-session.
type NativeCapacitor = { isNativePlatform?: () => boolean }

function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: NativeCapacitor }).Capacitor
  return !!cap?.isNativePlatform?.()
}

const NATIVE = isNativeApp()

// `hasThaiVoice()` stays synchronous (a UI warning reads it on render), but
// the native check is async. Probe as early as possible and optimistically
// report "supported" until the answer arrives, so devices that can speak
// Thai never flash the warning.
let nativeThaiSupported = true

function probeNativeThai(): void {
  if (!NATIVE) return
  TextToSpeech.isLanguageSupported({ lang: 'th-TH' })
    .then((r) => {
      nativeThaiSupported = r.supported
    })
    .catch(() => {
      /* engine not initialised yet: keep the optimistic default */
    })
}

probeNativeThai()

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
  if (speechUnlocked) return
  if (NATIVE) {
    // Native TTS needs no user gesture and there is no Web Speech API to
    // unlock; just re-probe now that the user is interacting (the Android
    // TTS engine can report languages only after its first init).
    speechUnlocked = true
    probeNativeThai()
    return
  }
  try {
    // an empty utterance inside the gesture unlocks speechSynthesis on iOS
    const u = new SpeechSynthesisUtterance('')
    u.volume = 0
    window.speechSynthesis?.speak(u)
    speechUnlocked = true
  } catch {
    /* no speech synthesis */
  }
}

function chime(): Promise<void> {
  return new Promise((resolve) => {
    if (!ctx || ctx.state !== 'running') return resolve()
    const t = ctx.currentTime
    // 2.5x louder in the browser, 2x in the app (announceVolume.ts, which also proves
    // the two tones summed stay below full scale, so nothing clips)
    const peak = chimePeakGain(NATIVE)
    for (const [i, f] of [880, 1320].entries()) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + i * 0.16)
      g.gain.exponentialRampToValueAtTime(peak, t + i * 0.16 + 0.02)
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

/** True when this device can speak Thai (voices load lazily on Chrome). */
export function hasThaiVoice(): boolean {
  if (NATIVE) return nativeThaiSupported
  return thaiVoice() !== undefined
}

/** Native: Android TTS via the Capacitor plugin. Latest announcement wins. */
async function speakNative(text: string): Promise<void> {
  // stop a still-speaking previous utterance instead of queueing behind it
  await TextToSpeech.stop().catch(() => undefined)
  // `category` is iOS-only and already defaults to 'ambient', which is what
  // we want; Android ignores it.
  await TextToSpeech.speak({ text, lang: 'th-TH', rate: 0.95, volume: 1.0 })
}

function speak(text: string): void {
  if (NATIVE) {
    // never let TTS trouble throw into the payment flow
    speakNative(text).catch((e) => console.warn('announce: native speech failed', e))
    return
  }
  const synth = window.speechSynthesis
  if (!synth) return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'th-TH'
  const v = thaiVoice()
  if (v) u.voice = v
  u.rate = 0.95
  u.volume = 1
  u.onerror = (e) => console.warn('announce: speech failed', e.error)
  // Chrome/Android can leave the queue paused or stuck after idle: clear it
  // so this announcement is not stuck behind a dead utterance.
  if (synth.paused) synth.resume()
  if (synth.speaking || synth.pending) synth.cancel()
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
  const text = `ได้รับเงิน ${bahtWords(amountSatang)} คิว ${queueNumber}`
  // the context may have been suspended since the last tap (idle / screen
  // dim): wake it first, then chime, then speak. Speak even if the chime fails.
  const wake = ctx ? ctx.resume().catch(() => undefined) : Promise.resolve()
  void wake
    .then(chime)
    .catch(() => undefined)
    .then(() => speak(text))
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

/** Speaks arbitrary text through whichever path this device uses. */
export function speakTest(text: string): void {
  speak(text)
}

/** Test button: proves sound + Thai voice work on this device. */
export function testAnnounce(): void {
  unlockAudio()
  void chime().then(() => speak('เปิดเสียงประกาศเงินเข้าแล้ว'))
}
