// Plays the payment announcement from pre-recorded Thai word clips through Web Audio
// (announceNumber.ts builds the word list). Used by the browser AND the Android app:
// the WebView has Web Audio, and clips do not depend on a Thai TTS engine or on the
// internet. When anything is missing (clips not loaded, number out of range, audio
// suspended) it returns false and announce.ts falls back to the speech engine.
//
// Level: every clip is already normalized to -1 dBFS peak and compressed offline
// (tools/announce-clips/process.mjs), so playback gain stays at 1.0 — any more would clip.

import { CLIP_NAMES, announcementClips } from './announceNumber'
import type { ClipName } from './announceNumber'

const GAP_S = 0.03 // breathing room between words (clips carry ~12 ms padding already)
const START_DELAY_S = 0.05

const buffers = new Map<ClipName, AudioBuffer>()
let loading: Promise<boolean> | null = null
let playing: AudioBufferSourceNode[] = []

/** Fetch + decode every clip once (idempotent); resolves false if any failed (retried next call). */
export function preloadClips(ctx: AudioContext): Promise<boolean> {
  if (loading) return loading
  loading = (async () => {
    try {
      await Promise.all(
        CLIP_NAMES.map(async (name) => {
          if (buffers.has(name)) return
          const res = await fetch(`/announce/${name}.wav`)
          if (!res.ok) throw new Error(`clip ${name}: HTTP ${res.status}`)
          buffers.set(name, await ctx.decodeAudioData(await res.arrayBuffer()))
        }),
      )
      return true
    } catch {
      return false
    }
  })()
  void loading.then((ok) => {
    if (!ok) loading = null // allow a retry on the next unlock/announcement
  })
  return loading
}

function stopPlaying(): void {
  for (const s of playing) {
    try {
      s.stop()
    } catch {
      /* already stopped */
    }
  }
  playing = []
}

/**
 * Speak "ได้รับเงิน … บาท … คิว …" from clips. Returns true when playback started,
 * false when the caller must use the speech engine instead. The newest announcement
 * cuts off a still-playing older one (same rule as the speech paths).
 */
export async function playAnnouncement(ctx: AudioContext, amountSatang: number, queueNumber: number): Promise<boolean> {
  const names = announcementClips(amountSatang, queueNumber)
  if (!names || ctx.state !== 'running') return false
  if (!(await preloadClips(ctx))) return false
  const list = names.map((n) => buffers.get(n))
  if (list.some((b) => !b)) return false
  stopPlaying()
  let t = ctx.currentTime + START_DELAY_S
  for (const buf of list as AudioBuffer[]) {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(t)
    playing.push(src)
    t += buf.duration + GAP_S
  }
  return true
}
