//! Run with `node src/pos/announceNumber.test.ts` (no test runner in this app; see points.test.ts).
import { CLIP_NAMES, announcementClips, numberClips } from './announceNumber.ts'

let n = 0
function eq(actual: unknown, expected: unknown, label: string): void {
  n += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
  }
}

eq(numberClips(0), ['d0'], '0')
eq(numberClips(1), ['d1'], '1 alone is หนึ่ง')
eq(numberClips(5), ['d5'], '5')
eq(numberClips(10), ['sip'], '10 = สิบ')
eq(numberClips(11), ['sip', 'et'], '11 = สิบเอ็ด')
eq(numberClips(12), ['sip', 'd2'], '12')
eq(numberClips(20), ['yi', 'sip'], '20 = ยี่สิบ')
eq(numberClips(21), ['yi', 'sip', 'et'], '21 = ยี่สิบเอ็ด')
eq(numberClips(30), ['d3', 'sip'], '30')
eq(numberClips(60), ['d6', 'sip'], '60')
eq(numberClips(99), ['d9', 'sip', 'd9'], '99')
eq(numberClips(100), ['d1', 'roi'], '100 = หนึ่งร้อย')
eq(numberClips(101), ['d1', 'roi', 'et'], '101 = หนึ่งร้อยเอ็ด')
eq(numberClips(110), ['d1', 'roi', 'sip'], '110')
eq(numberClips(120), ['d1', 'roi', 'yi', 'sip'], '120')
eq(numberClips(250), ['d2', 'roi', 'd5', 'sip'], '250')
eq(numberClips(1000), ['d1', 'phan'], '1000')
eq(numberClips(1001), ['d1', 'phan', 'et'], '1001')
eq(numberClips(12345), ['d1', 'muen', 'd2', 'phan', 'd3', 'roi', 'd4', 'sip', 'd5'], '12345')
eq(numberClips(100000), ['d1', 'saen'], '100000')
eq(numberClips(999999), ['d9', 'saen', 'd9', 'muen', 'd9', 'phan', 'd9', 'roi', 'd9', 'sip', 'd9'], '999999')
eq(numberClips(1_000_000), null, 'out of range')
eq(numberClips(-1), null, 'negative')
eq(numberClips(1.5), null, 'non-integer')

eq(announcementClips(6000, 1), ['received', 'd6', 'sip', 'baht', 'queue', 'd1'], '60 baht queue 1')
eq(announcementClips(6050, 12), ['received', 'd6', 'sip', 'baht', 'd5', 'sip', 'satang', 'queue', 'sip', 'd2'], '60.50 baht queue 12')
eq(announcementClips(50, 3), ['received', 'd0', 'baht', 'd5', 'sip', 'satang', 'queue', 'd3'], '0.50 baht')
eq(announcementClips(100_000_000, 1), null, 'amount too large -> fallback')
eq(announcementClips(6000, 1_000_000), null, 'queue too large -> fallback')

// every clip an announcement can name is a known, shipped clip
const known = new Set<string>(CLIP_NAMES)
for (const sample of [announcementClips(123456, 99), announcementClips(2010, 21), announcementClips(99999999, 5)]) {
  for (const c of sample ?? []) eq(known.has(c), true, `clip ${c} is known`)
}
console.log(`ok — ${n} checks passed`)
