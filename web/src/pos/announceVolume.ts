// Loudness of the payment chime (Web Audio). Pure constants + helpers so the
// no-clipping guarantee is checkable without a browser (announceVolume.test.ts).
//
// Only the chime can be amplified in code. The Thai speech goes through
// SpeechSynthesisUtterance.volume (web) / the TTS plugin `volume` (Android), and
// both APIs are capped at 1.0 — which announce.ts already uses.

/** The chime's original peak gain per tone before this change. */
export const BASE_CHIME_GAIN = 0.35
/** Requested boost: 2.5x in the browser, 2x in the Android app. */
export const WEB_CHIME_BOOST = 2.5
export const NATIVE_CHIME_BOOST = 2
/** A sine at gain g peaks at g; two tones may overlap, so keep their sum under this. */
export const MAX_SUMMED_PEAK = 0.95

/** Peak gain of ONE chime tone. */
export function chimePeakGain(native: boolean): number {
  return BASE_CHIME_GAIN * (native ? NATIVE_CHIME_BOOST : WEB_CHIME_BOOST)
}

/** Envelope of one tone: peak at +0.02 s, exponential decay to 0.0001 at +0.30 s (announce.ts). */
export function toneGainAt(peak: number, secondsSinceStart: number): number {
  if (secondsSinceStart <= 0) return 0.0001
  if (secondsSinceStart <= 0.02) return 0.0001 * Math.pow(peak / 0.0001, secondsSinceStart / 0.02)
  if (secondsSinceStart >= 0.3) return 0.0001
  return peak * Math.pow(0.0001 / peak, (secondsSinceStart - 0.02) / 0.28)
}

/** Second tone starts 0.16 s after the first (announce.ts). */
export const TONE_SPACING_S = 0.16

/**
 * Highest summed amplitude of the two tones, sampled finely over the whole chime.
 * The first tone has already decayed to almost nothing when the second one peaks,
 * so this is barely above a single tone — and it must stay under MAX_SUMMED_PEAK.
 */
export function maxSummedAmplitude(native: boolean): number {
  const peak = chimePeakGain(native)
  let max = 0
  for (let t = 0; t <= 0.5; t += 0.001) {
    const sum = toneGainAt(peak, t) + toneGainAt(peak, t - TONE_SPACING_S)
    if (sum > max) max = sum
  }
  return max
}
