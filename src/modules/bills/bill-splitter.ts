// src/modules/bills/bill-splitter.ts
//
// Pure bill-splitting helpers for Phase 16 utility bill distribution.
//
// Three split modes are supported (chosen per lease via
// `lease.utility_split_mode`):
//   1. EQUAL       — divide evenly. Largest-remainder handles indivisible
//                    totals (e.g., 1000¢ / 3 → [333, 333, 334]).
//   2. PROPORTIONAL — divide per lease_tenants.liability_share weight.
//                     Σ shares == totalAmountMinor exactly.
//   3. CUSTOM      — divide per lease.utility_split_custom_percents
//                    (percentages summing to 100.00). Σ shares ==
//                    totalAmountMinor exactly.
//
// The largest-remainder rounding method is shared by all three:
//   a. Compute raw share = total × weight_i / Σ weights (or / n for EQUAL).
//      The result is a fraction; we keep the integer floor + a residual.
//   b. Compute residual = total − Σ floors (the unallocated cents).
//   c. Distribute the residual cents one-by-one to the entries with the
//      LARGEST fractional remainder. Ties broken by tenantUserId
//      lexicographic order for deterministic replay.
//
// INVARIANT: Σ outputs === total exactly. This is the contract that
// allows downstream code to assert `bill_shares Σ share_minor ==
// utility_bills.total_amount_minor` across all rows.
//
// This file is dependency-free (no Prisma, no Decimal.js import needed —
// callers pass plain numbers/strings/bigints and we normalize). All
// errors surface as `SemanticError` so the controller layer can map them
// to HTTP 400 via the global error handler.

import { SemanticError } from '@/lib/errors';

// ──────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────

export interface WeightedShareInput {
  /** UUID of the tenant receiving the share. */
  tenantUserId: string;
  /**
   * For PROPORTIONAL: the tenant's liability_share weight (e.g. 0.40 for
   * 40%). Accepts number | string so callers can pass Decimal-derived
   * strings without converting twice.
   */
  weight: number | string;
}

export interface PercentShareInput {
  tenantUserId: string;
  /** Percent of the total (0–100). Accepts number | string. */
  percent: number | string;
}

export interface ProportionalShare {
  tenantUserId: string;
  shareMinor: bigint;
  /** The numeric weight used (echoed back for audit). */
  weightUsed: number;
}

export interface CustomShare {
  tenantUserId: string;
  shareMinor: bigint;
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Coerce a number-or-string weight/percent into a JS number for
 * arithmetic. Rejects NaN / Infinity / negative values up-front so the
 * downstream math never sees them.
 */
function toFiniteNumber(value: number | string, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new SemanticError(`${label} must be a finite number, got ${String(value)}`, [
      { field: label, code: 'INVALID_WEIGHT', message: `must be finite, got ${String(value)}` },
    ]);
  }
  if (n < 0) {
    throw new SemanticError(`${label} must be >= 0, got ${n}`, [
      { field: label, code: 'INVALID_WEIGHT', message: `must be >= 0, got ${n}` },
    ]);
  }
  return n;
}

/**
 * Largest-remainder rounding.
 *
 * Given a total (BigInt cents) and a list of weights (numbers), returns
 * a list of BigInt cents such that:
 *   • Each output_i >= floor(total × weight_i / Σ weights)
 *   • Σ outputs === total exactly
 *   • Ties broken by tenantUserId lex order (stable across runs)
 *
 * The function intentionally takes raw `number` weights rather than
 * BigInts: weights are decimals (liability_share, percentage), and the
 * caller is expected to have already validated they are non-negative
 * and finite. The multiplication `total * weight` happens in regular
 * JS double precision, which is safe for BigInt × number under
 * 2^53 — see the precondition check below.
 */
function largestRemainderRounding(
  totalMinor: bigint,
  weights: readonly number[],
  ids: readonly string[]
): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  if (n !== ids.length) {
    throw new SemanticError('largestRemainderRounding: ids length mismatch');
  }
  // Special case: total === 0n → every share is 0.
  if (totalMinor === 0n) {
    return Array.from({ length: n }, () => 0n);
  }

  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weightSum <= 0) {
    // The public wrappers validate this earlier, but defend in depth
    // (also catches NaN-from-zero when weights are all 0).
    throw new SemanticError('Sum of weights must be > 0', [
      { field: 'weights', code: 'ZERO_WEIGHT_TOTAL', message: 'sum of weights must be > 0' },
    ]);
  }

  // Bound check: each raw product must be representable in a double.
  // totalMinor is BigInt; we convert via toString to avoid 2^53 loss
  // for the multiplication itself, then check the resulting JS number
  // is safe. The product is at most |totalMinor|, but in JS
  // `BigInt * Number` would coerce — we instead compute as
  // `Number(totalMinor) * weight` and verify totalMinor fits.
  const totalAsNumber = Number(totalMinor);
  if (!Number.isSafeInteger(totalAsNumber)) {
    throw new SemanticError(
      `totalMinor ${totalMinor.toString()} exceeds Number.MAX_SAFE_INTEGER; use splitEqual / splitProportional with a smaller total`,
      [{ field: 'totalMinor', code: 'TOTAL_TOO_LARGE', message: 'exceeds Number.MAX_SAFE_INTEGER' }]
    );
  }

  // Compute raw shares + floors + fractional remainders.
  const raw = weights.map((w) => (totalAsNumber * w) / weightSum);
  const floors = raw.map((r) => Math.floor(r));
  const fractions = raw.map((r, i) => ({ i, frac: r - floors[i] }));

  const allocated = floors.reduce((acc, f) => acc + f, 0);
  let residual = Number(totalMinor) - allocated;
  if (residual < 0) {
    // Shouldn't happen — Math.floor never overshoots — but defend.
    throw new SemanticError('largestRemainderRounding: overshoot detected');
  }

  // Sort by largest fractional remainder; tie-break by tenantUserId lex
  // order (stable, deterministic). We mutate `floors` below.
  fractions.sort((a, b) => {
    if (b.frac !== a.frac) return b.frac - a.frac; // descending
    return ids[a.i].localeCompare(ids[b.i]); // ascending
  });

  const result = floors.slice();
  let cursor = 0;
  while (residual > 0 && cursor < fractions.length) {
    result[fractions[cursor].i] += 1;
    residual -= 1;
    cursor += 1;
  }

  // If residual is still > 0 here, the weights sum to 0, which we
  // already excluded. If residual < 0, we excluded overshoot. Both
  // should be impossible.
  if (residual !== 0) {
    throw new SemanticError(
      `largestRemainderRounding: residual=${residual} after distribution`
    );
  }

  return result.map((x) => BigInt(x));
}

// ──────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────

/**
 * Split `totalMinor` evenly across `n` parties.
 *
 * - `n === 0` → returns `[]` (the caller is expected to have validated
 *   that the lease has at least one tenant).
 * - Uses largest-remainder so the cents add up exactly.
 */
export function splitEqual(totalMinor: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new SemanticError(`n must be a non-negative integer, got ${n}`, [
      { field: 'n', code: 'INVALID_N', message: `must be non-negative integer, got ${n}` },
    ]);
  }
  if (n === 0) return [];
  const weights = Array.from({ length: n }, () => 1);
  const ids = Array.from({ length: n }, (_, i) => i.toString());
  return largestRemainderRounding(totalMinor, weights, ids);
}

/**
 * Split `totalMinor` proportionally to each party's weight.
 *
 * The sum of `weight`s need not equal 100 or 1 — only that it is > 0.
 * The output shares are proportional to the weights (i.e. share_i =
 * total × weight_i / Σ weights).
 */
export function splitProportional(
  totalMinor: bigint,
  inputs: readonly WeightedShareInput[]
): ProportionalShare[] {
  if (inputs.length === 0) return [];

  const ids: string[] = [];
  const weights: number[] = [];
  for (const input of inputs) {
    ids.push(input.tenantUserId);
    weights.push(toFiniteNumber(input.weight, `weight for ${input.tenantUserId}`));
  }
  const weightSum = weights.reduce((acc, w) => acc + w, 0);
  if (weightSum <= 0) {
    throw new SemanticError('Sum of weights must be > 0', [
      { field: 'weights', code: 'ZERO_WEIGHT_TOTAL', message: 'sum of weights must be > 0' },
    ]);
  }

  const shares = largestRemainderRounding(totalMinor, weights, ids);
  return inputs.map((input, i) => ({
    tenantUserId: input.tenantUserId,
    shareMinor: shares[i]!,
    weightUsed: weights[i]!,
  }));
}

/**
 * Split `totalMinor` per an explicit percentage list (0–100).
 *
 * Rejects inputs whose percentages do not sum to 100 within ±0.01 to
 * tolerate floating-point rounding (e.g., 33.33 + 33.33 + 33.34 = 100.00).
 */
export function splitCustom(
  totalMinor: bigint,
  inputs: readonly PercentShareInput[]
): CustomShare[] {
  if (inputs.length === 0) return [];

  const ids: string[] = [];
  const percents: number[] = [];
  let percentSum = 0;
  for (const input of inputs) {
    const p = toFiniteNumber(input.percent, `percent for ${input.tenantUserId}`);
    if (p > 100) {
      throw new SemanticError(
        `percent for ${input.tenantUserId} must be <= 100, got ${p}`,
        [
          {
            field: `percent.${input.tenantUserId}`,
            code: 'PERCENT_OUT_OF_RANGE',
            message: `must be <= 100, got ${p}`,
          },
        ]
      );
    }
    ids.push(input.tenantUserId);
    percents.push(p);
    percentSum += p;
  }
  // Tolerance of ±0.01 to accommodate e.g., 33.33 + 33.33 + 33.34 = 100.00
  // (which has FP rounding error in IEEE-754 double precision).
  if (Math.abs(percentSum - 100) > 0.01) {
    throw new SemanticError(
      `Sum of percentages must be 100, got ${percentSum.toFixed(4)}`,
      [
        {
          field: 'percents',
          code: 'PERCENT_MISMATCH',
          message: `sum must be 100, got ${percentSum.toFixed(4)}`,
        },
      ]
    );
  }

  // Percentages ARE the weights. Largest-remainder will produce shares
  // whose Σ == totalMinor exactly.
  const shares = largestRemainderRounding(totalMinor, percents, ids);
  return inputs.map((input, i) => ({
    tenantUserId: input.tenantUserId,
    shareMinor: shares[i]!,
  }));
}
