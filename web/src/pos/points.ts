//! Loyalty-points helpers (members 0011, fractional points).
//!
//! Backend points are FRACTIONAL since the earn rule changed: 0.5 point per
//! full 50฿, i.e. earned = floor(total_satang / 5000) * 0.5. The JSON stays
//! numbers (points / points_earned / balance can be 1.5), so every DISPLAY
//! goes through fmtPoints() below. Redemption is unchanged: whole 10s only,
//! 10 points = ฿10 off.

/** 1 point = ฿1 = 100 satang; redemptions move in whole 10s only. */
export const POINT_STEP = 10

/**
 * Points a bill EARNS — the client-side preview of the server rule:
 * 0.5 point per full 50฿, i.e. floor(total_satang / 5000) * 0.5.
 * The server total stays authoritative; this is only a live estimate.
 */
export function pointsEarned(totalSatang: number): number {
  return Math.floor(totalSatang / 5000) * 0.5
}

/**
 * A points amount for display: at most 1 decimal, no trailing ".0".
 * 1.5 -> "1.5", 2 -> "2", 0.5 -> "0.5". Use for EVERY shown points balance /
 * earned amount (points_redeemed is always a whole multiple of 10, so passing
 * it through here is harmless too).
 */
export function fmtPoints(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/**
 * The loyalty cap on one bill: the largest multiple of 10 that is <= the
 * member's available points AND <= the subtotal in whole baht (the subtotal is
 * the bill BEFORE points, i.e. total_amount + points_redeemed*100). The
 * available balance may be FRACTIONAL (0.5 steps) — only whole 10s redeem, so
 * the fraction is floored away: floor(available / 10) * 10.
 */
export function maxRedeemable(availablePoints: number, subtotalSatang: number): number {
  const cap = Math.floor(Math.min(availablePoints, Math.floor(subtotalSatang / 100)) / POINT_STEP) * POINT_STEP
  return Math.max(0, cap)
}
