// src/modules/invoices/rent-calculator.ts
//
// Pure monetary helpers for rent invoice generation (13 §13.2.6,
// 05 §5.2). No I/O — exported individually so service / unit tests
// can exercise them in isolation.
//
// All values are BigInt in minor units (cents). All inputs are
// validated to be >= 0 where appropriate; the service layer is
// responsible for converting intermediate products back to bigint
// after ceiling/rounding operations.
//
// Banker's rounding (round-half-to-even) is used for prorated rent to
// avoid cumulative bias across many tenants / many months. Late-fee
// uses standard ceiling (tax/customs-style — we always round UP a late
// fee, never down, so the user is never under-charged).

export interface LateFeePolicy {
  graceDays: number;
  mode: 'PERCENT' | 'FIXED';
  /** % of outstanding if PERCENT (e.g. 5 means 5%); minor units if FIXED. */
  value: number;
}

/**
 * Sum three BigInt money columns. Result is always >= 0 (callers
 * should validate inputs; this helper is a pure addition).
 */
export function monthlyTotal(args: {
  rentMinor: bigint;
  utilityShareMinor: bigint;
  lateFeeMinor: bigint;
}): bigint {
  // BigInt arithmetic is straightforward; no overflow risk at minor-
  // unit scale (rent <= ~10^15 cents = $10 trillion per period).
  return args.rentMinor + args.utilityShareMinor + args.lateFeeMinor;
}

/**
 * Prorate rent for a mid-month start. Days in `startDate..endOfMonth`
 * inclusive of both endpoints (matches the spec example: lease starts
 * 2026-09-15 in a 30-day month → 16/30 of baseRent).
 *
 * Uses banker's rounding (round-half-to-even) to avoid systematic bias.
 * For a cents amount, the bias is at most ±0.5 cents which is below
 * rounding noise anyway; the policy matters when amounts grow large.
 */
export function proratedRent(args: {
  baseRentMinor: bigint;
  startDate: Date;
  endOfMonth: Date;
  daysInMonth: number;
}): bigint {
  if (args.daysInMonth <= 0) {
    throw new Error('proratedRent: daysInMonth must be > 0');
  }
  // Compute inclusive days: difference + 1.
  const msPerDay = 86_400_000;
  const dayDiff = Math.floor(
    (args.endOfMonth.getTime() - args.startDate.getTime()) / msPerDay
  ) + 1;
  if (dayDiff < 0 || dayDiff > args.daysInMonth) {
    throw new Error('proratedRent: invalid date range');
  }
  const numerator = args.baseRentMinor * BigInt(dayDiff);
  const denominator = BigInt(args.daysInMonth);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  // Round half to even: if remainder*2 == denominator → tie → round to
  // nearest even. Otherwise standard half-up.
  if (remainder * 2n === denominator) {
    return quotient % 2n === 0n ? quotient : quotient + 1n;
  }
  if (remainder * 2n > denominator) {
    return quotient + 1n;
  }
  return quotient;
}

/**
 * Apply a late-fee policy to an outstanding amount.
 *
 *   - today > dueDate + graceDays  → fee applied
 *   - today <= dueDate + graceDays → fee is 0 (grace window)
 *   - policy is null                → fee is 0 (no policy on this lease)
 *   - mode PERCENT                  → ceil(outstanding * value / 100)
 *   - mode FIXED                    → value (interpreted as minor units)
 */
export function calculateLateFee(args: {
  outstandingMinor: bigint;
  policy: LateFeePolicy | null;
  today: Date;
  dueDate: Date;
}): bigint {
  if (!args.policy) return 0n;
  const msPerDay = 86_400_000;
  const daysPast = Math.floor(
    (args.today.getTime() - args.dueDate.getTime()) / msPerDay
  );
  if (daysPast <= args.policy.graceDays) return 0n;
  if (args.policy.mode === 'FIXED') {
    const v = BigInt(Math.trunc(args.policy.value));
    return v < 0n ? 0n : v;
  }
  // PERCENT: ceil(outstanding * value / 100). Always round UP — never
  // under-charge the user.
  const factor = BigInt(Math.trunc(args.policy.value));
  const product = args.outstandingMinor * factor;
  const quotient = product / 100n;
  const remainder = product % 100n;
  return remainder === 0n ? quotient : quotient + 1n;
}
