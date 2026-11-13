//! Unit tests for pos/points.ts. The web app has NO test runner (see
//! package.json — no vitest/jest), so this file is plain TypeScript that runs
//! its checks at module load and can be executed directly with Node's type
//! stripping:
//!
//!     node web/src/pos/points.test.ts
//!
//! Nothing in the app imports it, so the vite build never bundles it; tsc
//! still type-checks it like any other module in src/.

import { POINT_STEP, fmtPoints, maxRedeemable, pointsEarned } from './points.ts'

let ran = 0
let failed = 0

function eq(actual: unknown, expected: unknown, label: string): void {
  ran += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failed += 1
    console.error(`FAIL ${label}: expected ${e}, got ${a}`)
  }
}

// ---- fmtPoints: at most 1 decimal, never a trailing .0 ----
eq(fmtPoints(0), '0', 'fmtPoints(0)')
eq(fmtPoints(1), '1', 'fmtPoints(1)')
eq(fmtPoints(2.0), '2', 'fmtPoints(2.0) -> "2"')
eq(fmtPoints(0.5), '0.5', 'fmtPoints(0.5)')
eq(fmtPoints(1.5), '1.5', 'fmtPoints(1.5)')
eq(fmtPoints(10.5), '10.5', 'fmtPoints(10.5)')
eq(fmtPoints(123), '123', 'fmtPoints(123)')
eq(fmtPoints(123.5), '123.5', 'fmtPoints(123.5)')
// defensive: values the backend never sends still render sanely
eq(fmtPoints(1.25), '1.3', 'fmtPoints(1.25) rounds to 1 decimal')
eq(fmtPoints(2.49), '2.5', 'fmtPoints(2.49) rounds to 1 decimal')

// ---- pointsEarned: 0.5 per full 50฿ = floor(total_satang/5000)*0.5 ----
eq(pointsEarned(0), 0, 'no earn on a 0 bill')
eq(pointsEarned(4_999), 0, '49.99฿ earns nothing')
eq(pointsEarned(5_000), 0.5, '50฿ earns 0.5')
eq(pointsEarned(9_999), 0.5, '99.99฿ earns 0.5')
eq(pointsEarned(10_000), 1, '100฿ earns 1 (the OLD integer rule)')
eq(pointsEarned(14_999), 1, '149.99฿ earns 1')
eq(pointsEarned(15_000), 1.5, '150฿ earns 1.5')
eq(pointsEarned(100_000), 10, '1000฿ earns 10')
eq(pointsEarned(123_456), 12, '1234.56฿ earns 12 (floor, not round)')

// ---- maxRedeemable: whole 10s only, fractional balance floored ----
eq(POINT_STEP, 10, 'step of 10 points')
eq(maxRedeemable(15.5, 100_000), 10, '15.5 available -> 10 (fraction dropped)')
eq(maxRedeemable(9.5, 100_000), 0, '9.5 available -> 0 (below one step)')
eq(maxRedeemable(25.5, 100_000), 20, '25.5 available -> 20')
eq(maxRedeemable(100.5, 100_000), 100, '100.5 available -> 100')
eq(maxRedeemable(30, 100_000), 30, 'whole balance stays whole')
eq(maxRedeemable(100, 1_899), 10, 'capped by the 18฿ subtotal, not the balance')
eq(maxRedeemable(100, 500), 0, '5฿ subtotal redeems nothing')
eq(maxRedeemable(100, 2_500), 20, '25฿ subtotal -> 20')
eq(maxRedeemable(-3, 100_000), 0, 'never negative')

console.log(failed === 0 ? `ok — ${ran} checks passed` : `FAILED — ${failed} of ${ran} checks`)
if (failed !== 0) throw new Error(`${failed} points test(s) failed`)
