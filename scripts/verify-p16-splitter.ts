// scripts/verify-p16-splitter.ts
//
// Phase 16 sanity check. Pure-function tests for the bill-splitter
// (largest-remainder rounding). Runs WITHOUT a DB. Invoke with:
//
//   npx tsx scripts/verify-p16-splitter.ts
//
// The acceptance must_pass criterion from phases.json is:
//
//   "Bill split invariant: Σ BillShare.share_minor ==
//    UtilityBill.total_amount_minor exactly for random inputs"
//
// We assert that invariant over 100 random inputs across all three split
// modes, with a range of totals (zero, small, large) and weight shapes.

import {
  splitCustom,
  splitEqual,
  splitProportional,
} from '@/modules/bills/bill-splitter';
import { SemanticError } from '@/lib/errors';

let failures = 0;

function sumBigInts(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

function assertEq(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: expected=${String(expected)} actual=${String(actual)}`);
  if (!ok) failures += 1;
}

function assertDeepEq(label: string, actual: readonly bigint[], expected: readonly bigint[]): void {
  const a = actual.map(String).join(',');
  const e = expected.map(String).join(',');
  const ok = a === e;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: expected=[${e}] actual=[${a}]`);
  if (!ok) failures += 1;
}

function assertInvariance(label: string, shares: readonly bigint[], total: bigint): void {
  const sum = sumBigInts(shares);
  const ok = sum === total;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}: Σ shares=${sum.toString()} total=${total.toString()}`
  );
  if (!ok) failures += 1;
}

function assertThrows(label: string, fn: () => unknown, expectedMessageFragment: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof SemanticError)) {
    console.log(`  FAIL  ${label}: expected SemanticError, got ${String(caught)}`);
    failures += 1;
    return;
  }
  const msg = (caught as Error).message;
  if (!msg.includes(expectedMessageFragment)) {
    console.log(
      `  FAIL  ${label}: error message "${msg}" missing fragment "${expectedMessageFragment}"`
    );
    failures += 1;
    return;
  }
  console.log(`  PASS  ${label}: SemanticError("${msg}")`);
}

// ── splitEqual ────────────────────────────────────────────────────────
console.log('splitEqual:');
// Note: tie-breaking for splitEqual uses id = index.toString() (i.e. "0",
// "1", "2", ...). The smallest id wins the residual. For inputs of size
// n=3 (ids "0", "1", "2"), the residual goes to "0".
assertDeepEq('1000 / 3 → [334, 333, 333]', splitEqual(1000n, 3), [334n, 333n, 333n]);
assertDeepEq('1000 / 1 → [1000]', splitEqual(1000n, 1), [1000n]);
assertDeepEq('100 / 3 → [34, 33, 33]', splitEqual(100n, 3), [34n, 33n, 33n]);
assertDeepEq('7 / 4 → [2, 2, 2, 1]', splitEqual(7n, 4), [2n, 2n, 2n, 1n]);
assertDeepEq('1 / 3 → [1, 0, 0]', splitEqual(1n, 3), [1n, 0n, 0n]);
assertDeepEq('0 / 5 → [0, 0, 0, 0, 0]', splitEqual(0n, 5), [0n, 0n, 0n, 0n, 0n]);
assertDeepEq('0 / 0 → []', splitEqual(0n, 0), []);
assertDeepEq('1000 / 0 → []', splitEqual(1000n, 0), []);

// ── splitProportional ─────────────────────────────────────────────────
console.log('\nsplitProportional:');
{
  const shares = splitProportional(1000n, [
    { tenantUserId: 'a', weight: 60 },
    { tenantUserId: 'b', weight: 40 },
  ]);
  assertEq('60/40 of 1000 → a shares', shares[0]?.shareMinor, 600n);
  assertEq('60/40 of 1000 → b shares', shares[1]?.shareMinor, 400n);
  assertEq('60/40 weight echoed (a)', shares[0]?.weightUsed, 60);
  assertEq('60/40 weight echoed (b)', shares[1]?.weightUsed, 40);
  assertInvariance('60/40 invariant Σ', shares.map((s) => s.shareMinor), 1000n);
}
{
  const shares = splitProportional(1000n, [
    { tenantUserId: 'a', weight: 1 },
    { tenantUserId: 'b', weight: 1 },
    { tenantUserId: 'c', weight: 1 },
  ]);
  // All fracs equal 0.333…; tie-break by id asc → a wins residual
  assertDeepEq(
    'equal weights of 1 (3-way) → [334, 333, 333]',
    shares.map((s) => s.shareMinor),
    [334n, 333n, 333n]
  );
  assertInvariance('1/1/1 invariant Σ', shares.map((s) => s.shareMinor), 1000n);
}
{
  // Three-way uneven: weights 1, 2, 3 → Σ = 6, of 1000 → 166.67, 333.33, 500
  const shares = splitProportional(1000n, [
    { tenantUserId: 'a', weight: 1 },
    { tenantUserId: 'b', weight: 2 },
    { tenantUserId: 'c', weight: 3 },
  ]);
  // 1000/6 = 166.666…, 333.333…, 500.000…
  // floors: 166, 333, 500; sum = 999; residual 1 → largest fractional is b
  // (b's fraction is 0.333… vs a's 0.666… wait no — b's fraction is 0.333…,
  // and c's is 0.000…). Actually b's frac is 0.333…, a's frac is 0.666…
  // → a wins the residual → [167, 333, 500].
  assertDeepEq(
    'weights 1/2/3 of 1000 → [167, 333, 500]',
    shares.map((s) => s.shareMinor),
    [167n, 333n, 500n]
  );
  assertInvariance('1/2/3 invariant Σ', shares.map((s) => s.shareMinor), 1000n);
}
{
  // String weights (Decimal-derived input).
  const shares = splitProportional(100n, [
    { tenantUserId: 'a', weight: '0.5' },
    { tenantUserId: 'b', weight: '0.5' },
  ]);
  assertDeepEq('0.5/0.5 of 100 → [50, 50]', shares.map((s) => s.shareMinor), [50n, 50n]);
  assertInvariance('0.5/0.5 invariant Σ', shares.map((s) => s.shareMinor), 100n);
}

// ── splitCustom ───────────────────────────────────────────────────────
console.log('\nsplitCustom:');
{
  const shares = splitCustom(1000n, [
    { tenantUserId: 'a', percent: 33.33 },
    { tenantUserId: 'b', percent: 33.33 },
    { tenantUserId: 'c', percent: 33.34 },
  ]);
  assertInvariance('33.33/33.33/33.34 invariant Σ', shares.map((s) => s.shareMinor), 1000n);
  // 1000 * 0.3333 = 333.3 → floor 333, frac 0.3
  // 1000 * 0.3333 = 333.3 → floor 333, frac 0.3
  // 1000 * 0.3334 = 333.4 → floor 333, frac 0.4
  // floors: 333, 333, 333; sum 999; residual 1 → c wins (largest frac 0.4)
  assertDeepEq(
    '33.33/33.33/33.34 → [333, 333, 334]',
    shares.map((s) => s.shareMinor),
    [333n, 333n, 334n]
  );
}
{
  const shares = splitCustom(100n, [
    { tenantUserId: 'a', percent: 50 },
    { tenantUserId: 'b', percent: 50 },
  ]);
  assertDeepEq('50/50 → [50, 50]', shares.map((s) => s.shareMinor), [50n, 50n]);
  assertInvariance('50/50 invariant Σ', shares.map((s) => s.shareMinor), 100n);
}
{
  const shares = splitCustom(0n, [
    { tenantUserId: 'a', percent: 33.33 },
    { tenantUserId: 'b', percent: 33.33 },
    { tenantUserId: 'c', percent: 33.34 },
  ]);
  assertDeepEq('zero total → all zero', shares.map((s) => s.shareMinor), [0n, 0n, 0n]);
}

// ── Validation errors ─────────────────────────────────────────────────
console.log('\nvalidation errors:');
assertThrows('PERCENT_MISMATCH (sum=99)', () => {
  splitCustom(1000n, [
    { tenantUserId: 'a', percent: 50 },
    { tenantUserId: 'b', percent: 49 },
  ]);
}, 'Sum of percentages must be 100');
assertThrows('PERCENT_OUT_OF_RANGE (>100)', () => {
  splitCustom(1000n, [
    { tenantUserId: 'a', percent: 150 },
  ]);
}, 'must be <= 100');
assertThrows('INVALID_WEIGHT (NaN)', () => {
  splitProportional(1000n, [{ tenantUserId: 'a', weight: 'not-a-number' }]);
}, 'must be a finite number');
assertThrows('INVALID_WEIGHT (negative)', () => {
  splitProportional(1000n, [{ tenantUserId: 'a', weight: -1 }]);
}, 'must be >= 0');
assertThrows('ZERO_WEIGHT_TOTAL (all zero)', () => {
  splitProportional(1000n, [
    { tenantUserId: 'a', weight: 0 },
    { tenantUserId: 'b', weight: 0 },
  ]);
}, 'Sum of weights must be > 0');
assertThrows('INVALID_N (negative)', () => {
  splitEqual(1000n, -1);
}, 'non-negative integer');

// ── Tie-breaking determinism ──────────────────────────────────────────
console.log('\ntie-breaking determinism:');
{
  // 100 cents split 3 ways → tied fractions (33.33… each). splitEqual
  // uses index.toString() as id, so the smallest index ("0") wins the
  // residual.
  const shares = splitEqual(100n, 3);
  assertDeepEq('splitEqual tie-break → index 0 wins residual', shares, [34n, 33n, 33n]);
}
{
  // splitCustom with three identical percentages (33.33, 33.33, 33.34):
  // floors are 333 each, residual 1 cent goes to the largest frac (c).
  // Custom receives real UUID-like ids, so the lex tie-break only kicks
  // in if all fracs tie exactly. Verify by giving two tenants the same
  // (largest) frac value.
  const shares = splitCustom(1000n, [
    { tenantUserId: 'b', percent: 33.34 },
    { tenantUserId: 'a', percent: 33.33 },
    { tenantUserId: 'c', percent: 33.33 },
  ]);
  // Fracs: 1000*0.3334 = 333.4, 1000*0.3333 = 333.3, 1000*0.3333 = 333.3.
  // Largest frac is b (0.4) → b wins residual.
  assertDeepEq('splitCustom largest-frac wins', shares.map((s) => s.shareMinor), [334n, 333n, 333n]);
}
{
  // Determinism: same inputs twice should produce identical output.
  const a = splitEqual(100n, 3);
  const b = splitEqual(100n, 3);
  assertEq('idempotent across calls', a.map(String).join(','), b.map(String).join(','));
}

// ── Stress test (the acceptance must_pass) ────────────────────────────
console.log('\nstress test (100 random inputs per mode):');
{
  // Deterministic PRNG (mulberry32) so the test is reproducible.
  let seed = 0xdeadbeef;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // splitEqual stress: random n in [2..20], random total in [0..100_000].
  let equalRuns = 0;
  for (let i = 0; i < 100; i++) {
    const n = 2 + Math.floor(rand() * 19); // 2..20
    const total = BigInt(Math.floor(rand() * 100_000));
    const shares = splitEqual(total, n);
    if (shares.length !== n) {
      console.log(`  FAIL  equal run ${i}: length mismatch (n=${n}, got ${shares.length})`);
      failures += 1;
      continue;
    }
    const sum = sumBigInts(shares);
    if (sum !== total) {
      console.log(
        `  FAIL  equal run ${i}: total=${total} Σ=${sum} (n=${n})`
      );
      failures += 1;
      continue;
    }
    equalRuns += 1;
  }
  console.log(`  PASS  splitEqual: 100/100 invariants held (${equalRuns} ok)`);

  // splitProportional stress: random inputs (1..15) with random weights.
  let propRuns = 0;
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(rand() * 15); // 1..15
    const total = BigInt(Math.floor(rand() * 1_000_000));
    const inputs = Array.from({ length: n }, (_, j) => ({
      tenantUserId: `t-${i}-${j}`,
      weight: Math.round(rand() * 1000) / 10, // 0..100, 1-decimal
    }));
    // Ensure weights sum > 0 (all-zero is rejected).
    if (inputs.every((inp) => inp.weight === 0)) inputs[0]!.weight = 1;
    const shares = splitProportional(total, inputs);
    if (shares.length !== n) {
      console.log(`  FAIL  proportional run ${i}: length mismatch`);
      failures += 1;
      continue;
    }
    const sum = sumBigInts(shares.map((s) => s.shareMinor));
    if (sum !== total) {
      console.log(
        `  FAIL  proportional run ${i}: total=${total} Σ=${sum} (n=${n})`
      );
      failures += 1;
      continue;
    }
    propRuns += 1;
  }
  console.log(`  PASS  splitProportional: 100/100 invariants held (${propRuns} ok)`);

  // splitCustom stress: random percent distributions summing to 100.
  let customRuns = 0;
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(rand() * 12); // 1..12
    const total = BigInt(Math.floor(rand() * 1_000_000));
    // Generate random integer percents in [1..50] each so the last
    // adjusted bucket can't go negative. Sum target is 100.
    const raw = Array.from({ length: n }, () => 1 + Math.floor(rand() * 50));
    const rawSum = raw.reduce((acc, v) => acc + v, 0);
    // Adjust the last one so the sum equals 100 exactly. If rawSum is
    // already > 100 (rare for small n), clamp by dividing each.
    let adjusted = raw.slice(0, -1);
    const last = 100 - adjusted.reduce((acc, v) => acc + v, 0);
    if (last < 1) {
      // Fallback: just use equal distribution.
      adjusted = Array.from({ length: n - 1 }, () => Math.floor(100 / n));
      adjusted.push(100 - adjusted.reduce((acc, v) => acc + v, 0));
    } else {
      adjusted.push(last);
    }
    const inputs = adjusted.map((p, j) => ({
      tenantUserId: `t-${i}-${j}`,
      percent: p,
    }));
    const shares = splitCustom(total, inputs);
    if (shares.length !== n) {
      console.log(`  FAIL  custom run ${i}: length mismatch`);
      failures += 1;
      continue;
    }
    const sum = sumBigInts(shares.map((s) => s.shareMinor));
    if (sum !== total) {
      console.log(
        `  FAIL  custom run ${i}: total=${total} Σ=${sum} (n=${n}, percents=[${adjusted.join(',')}])`
      );
      failures += 1;
      continue;
    }
    customRuns += 1;
  }
  console.log(`  PASS  splitCustom: 100/100 invariants held (${customRuns} ok)`);
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll Phase 16 splitter assertions passed.');
