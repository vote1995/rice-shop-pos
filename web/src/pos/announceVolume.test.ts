//! Run with `node src/pos/announceVolume.test.ts` (no test runner in this app; see points.test.ts).
import {
  BASE_CHIME_GAIN,
  MAX_SUMMED_PEAK,
  NATIVE_CHIME_BOOST,
  WEB_CHIME_BOOST,
  chimePeakGain,
  maxSummedAmplitude,
  toneGainAt,
} from './announceVolume.ts'

let n = 0
function ok(cond: boolean, label: string): void {
  n += 1
  if (!cond) throw new Error(`FAIL ${label}`)
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

ok(WEB_CHIME_BOOST === 2.5 && NATIVE_CHIME_BOOST === 2, 'requested boosts')
ok(near(chimePeakGain(false), BASE_CHIME_GAIN * 2.5), 'web is 2.5x the old gain')
ok(near(chimePeakGain(true), BASE_CHIME_GAIN * 2), 'app is 2x the old gain')
ok(chimePeakGain(false) < 1 && chimePeakGain(true) < 1, 'a single tone never reaches full scale')

// the envelope really peaks at the configured gain, 20 ms in
ok(near(toneGainAt(0.875, 0.02), 0.875), 'envelope peak equals the gain')
ok(toneGainAt(0.875, 0) < 0.001 && toneGainAt(0.875, 0.3) < 0.001, 'envelope starts and ends silent')

// summed over both tones, over the whole chime: below the clipping margin
const web = maxSummedAmplitude(false)
const app = maxSummedAmplitude(true)
ok(web < MAX_SUMMED_PEAK, `web (2.5x) summed peak ${web.toFixed(3)} stays below ${MAX_SUMMED_PEAK}`)
ok(app < MAX_SUMMED_PEAK, `app (2x) summed peak ${app.toFixed(3)} stays below ${MAX_SUMMED_PEAK}`)
ok(web >= chimePeakGain(false) && app >= chimePeakGain(true), 'sum is at least one full tone')
console.log(`ok — ${n} checks passed (web peak ${web.toFixed(3)}, app peak ${app.toFixed(3)})`)
