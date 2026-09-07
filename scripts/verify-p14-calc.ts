// scripts/verify-p14-calc.ts
//
// Phase 14 math sanity check. Pure-function tests for rent-calculator.
// Runs without a DB. Invoke with: npx tsx scripts/verify-p14-calc.ts

import {
  calculateLateFee,
  monthlyTotal,
  proratedRent,
} from '@/modules/invoices/rent-calculator';

let failures = 0;

function assertEq(label: string, actual: bigint | number, expected: bigint | number): void {
  const ok = actual === expected;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${label}: expected=${expected} actual=${actual}`);
  if (!ok) failures += 1;
}

console.log('rent-calculator: monthlyTotal');
assertEq('rent+util+late', monthlyTotal({ rentMinor: 100_000n, utilityShareMinor: 0n, lateFeeMinor: 5_000n }), 105_000n);
assertEq('all zero', monthlyTotal({ rentMinor: 0n, utilityShareMinor: 0n, lateFeeMinor: 0n }), 0n);

console.log('rent-calculator: proratedRent (banker rounding)');
// 300000 × 16 / 30 = 160000 (exact)
assertEq(
  'mid-month 16/30 of 300000',
  proratedRent({
    baseRentMinor: 300_000n,
    startDate: new Date(Date.UTC(2026, 8, 15)),
    endOfMonth: new Date(Date.UTC(2026, 8, 30, 23, 59, 59, 999)),
    daysInMonth: 30,
  }),
  160_000n
);
// Full month: 1st-30th of 30-day month = 30/30 of 300000
assertEq(
  'full month 30/30',
  proratedRent({
    baseRentMinor: 300_000n,
    startDate: new Date(Date.UTC(2026, 8, 1)),
    endOfMonth: new Date(Date.UTC(2026, 8, 30, 23, 59, 59, 999)),
    daysInMonth: 30,
  }),
  300_000n
);
// 1000 × 1/3 = 333.333... → banker's rounding rounds half-to-even → 334 (since 333 is odd)
assertEq(
  'banker tie → even',
  proratedRent({
    baseRentMinor: 1_000n,
    startDate: new Date(Date.UTC(2026, 8, 1)),
    endOfMonth: new Date(Date.UTC(2026, 8, 1, 23, 59, 59, 999)),
    daysInMonth: 3,
  }),
  // (1_000 * 1) / 3 = 333 remainder 1; remainder*2 < denominator → truncate to 333.
  333n
);

console.log('rent-calculator: calculateLateFee');
const todayPastDue = new Date(Date.UTC(2026, 9, 6)); // 2026-10-06
const todayInGrace = new Date(Date.UTC(2026, 9, 8)); // 2026-10-08
const dueDate = new Date(Date.UTC(2026, 9, 5));      // 2026-10-05

// 100000 × 5% = 5000, ceil
assertEq(
  'PERCENT 5% past grace',
  calculateLateFee({
    outstandingMinor: 100_000n,
    policy: { graceDays: 0, mode: 'PERCENT', value: 5 },
    today: todayPastDue,
    dueDate,
  }),
  5_000n
);
// In grace window (3 days past, grace=5)
assertEq(
  'PERCENT 5% within grace',
  calculateLateFee({
    outstandingMinor: 100_000n,
    policy: { graceDays: 5, mode: 'PERCENT', value: 5 },
    today: todayInGrace,
    dueDate,
  }),
  0n
);
// FIXED 250 cents
assertEq(
  'FIXED 250 past grace',
  calculateLateFee({
    outstandingMinor: 100_000n,
    policy: { graceDays: 0, mode: 'FIXED', value: 250 },
    today: todayPastDue,
    dueDate,
  }),
  250n
);
// null policy → 0
assertEq(
  'null policy',
  calculateLateFee({
    outstandingMinor: 100_000n,
    policy: null,
    today: todayPastDue,
    dueDate,
  }),
  0n
);
// PERCENT with ceiling (no exact division): 100001 × 5 / 100 = 5000.05 → 5001
assertEq(
  'PERCENT ceiling',
  calculateLateFee({
    outstandingMinor: 100_001n,
    policy: { graceDays: 0, mode: 'PERCENT', value: 5 },
    today: todayPastDue,
    dueDate,
  }),
  5_001n
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll rent-calculator assertions passed.');
