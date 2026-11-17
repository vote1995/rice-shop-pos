// Builds the payment announcement out of pre-recorded Thai word clips
// (web/public/announce/<name>.wav, made by tools/announce-clips). Pure, so
// announceNumber.test.ts can check the Thai number grammar without a browser.
//
// Why clips: speechSynthesis / the Android TTS plugin cap `volume` at 1.0, so the
// spoken words cannot be made louder in code. Pre-rendered audio played through Web
// Audio can be level-matched and kept loud (see tools/announce-clips/process.mjs).

/** Every clip the announcement can use — must match tools/announce-clips/synthesize.ps1. */
export const CLIP_NAMES = [
  'received', 'baht', 'satang', 'queue',
  'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
  'sip', 'yi', 'et', 'roi', 'phan', 'muen', 'saen',
] as const

export type ClipName = (typeof CLIP_NAMES)[number]

/** The largest number the clips can say (hundred-thousands place is the last unit). */
export const MAX_SPOKEN = 999_999

const DIGIT: readonly ClipName[] = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9']

/**
 * Thai reading of a whole number 0..999,999 as clip names, or null when out of range.
 * Rules: tens digit 1 is just "สิบ"; tens digit 2 is "ยี่สิบ"; a units digit 1 is "เอ็ด"
 * whenever something precedes it (11, 21, 101 ...) but "หนึ่ง" on its own (1); "หนึ่ง" is
 * kept before ร้อย/พัน/หมื่น/แสน (หนึ่งร้อย).
 */
export function numberClips(n: number): ClipName[] | null {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SPOKEN) return null
  if (n === 0) return ['d0']
  const out: ClipName[] = []
  const places: [number, ClipName][] = [
    [100_000, 'saen'],
    [10_000, 'muen'],
    [1_000, 'phan'],
    [100, 'roi'],
  ]
  let rest = n
  for (const [value, unit] of places) {
    const d = Math.floor(rest / value)
    rest %= value
    if (d > 0) out.push(DIGIT[d], unit)
  }
  const tens = Math.floor(rest / 10)
  const units = rest % 10
  if (tens === 1) out.push('sip')
  else if (tens === 2) out.push('yi', 'sip')
  else if (tens >= 3) out.push(DIGIT[tens], 'sip')
  if (units === 1) out.push(n > 1 ? 'et' : 'd1')
  else if (units > 1) out.push(DIGIT[units])
  return out
}

/**
 * "ได้รับเงิน <baht> บาท [<satang> สตางค์] คิว <queue>" as clip names; null when any
 * number is out of range (the caller then falls back to the speech engine).
 */
export function announcementClips(amountSatang: number, queueNumber: number): ClipName[] | null {
  if (!Number.isInteger(amountSatang) || amountSatang < 0) return null
  const baht = numberClips(Math.floor(amountSatang / 100))
  const satang = amountSatang % 100
  const queue = numberClips(queueNumber)
  if (!baht || !queue) return null
  const out: ClipName[] = ['received', ...baht, 'baht']
  if (satang > 0) {
    const s = numberClips(satang)
    if (!s) return null
    out.push(...s, 'satang')
  }
  out.push('queue', ...queue)
  return out
}
