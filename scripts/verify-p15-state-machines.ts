// scripts/verify-p15-state-machines.ts
//
// Phase 15 sanity check. Pure-function tests for payment + invoice
// state machines. Runs without a DB. Invoke with:
//   npx tsx scripts/verify-p15-state-machines.ts

import { isValidInvoiceTransition, TERMINAL_INVOICE_STATUSES } from '@/modules/invoices/invoices.state-machine';
import {
  isValidPaymentTransition,
  nextPaymentStates,
  TERMINAL_PAYMENT_STATUSES,
} from '@/modules/payments/payments.state-machine';

let failures = 0;

function assertEq(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: expected=${String(expected)} actual=${String(actual)}`);
  if (!ok) failures += 1;
}

function assertArrayEq(label: string, actual: readonly unknown[], expected: readonly unknown[]): void {
  const sortedA = [...actual].sort().join(',');
  const sortedE = [...expected].sort().join(',');
  const ok = sortedA === sortedE;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: expected=[${sortedE}] actual=[${sortedA}]`);
  if (!ok) failures += 1;
}

// ── Payment state machine ──────────────────────────────────────────────
console.log('payments.state-machine:');
assertEq('PROCESSING → SUCCEEDED', isValidPaymentTransition('PROCESSING', 'SUCCEEDED'), true);
assertEq('PROCESSING → FAILED', isValidPaymentTransition('PROCESSING', 'FAILED'), true);
assertEq('PROCESSING → REFUNDED', isValidPaymentTransition('PROCESSING', 'REFUNDED'), false);
assertEq('SUCCEEDED → REFUNDED', isValidPaymentTransition('SUCCEEDED', 'REFUNDED'), true);
assertEq('SUCCEEDED → SUCCEEDED', isValidPaymentTransition('SUCCEEDED', 'SUCCEEDED'), false);
assertEq('SUCCEEDED → FAILED', isValidPaymentTransition('SUCCEEDED', 'FAILED'), false);
assertEq('FAILED → SUCCEEDED', isValidPaymentTransition('FAILED', 'SUCCEEDED'), false);
assertEq('FAILED → REFUNDED', isValidPaymentTransition('FAILED', 'REFUNDED'), false);
assertEq('REFUNDED → SUCCEEDED', isValidPaymentTransition('REFUNDED', 'SUCCEEDED'), false);
assertArrayEq('next from PROCESSING', nextPaymentStates('PROCESSING'), ['SUCCEEDED', 'FAILED']);
assertArrayEq('next from SUCCEEDED', nextPaymentStates('SUCCEEDED'), ['REFUNDED']);
assertArrayEq('next from FAILED', nextPaymentStates('FAILED'), []);
assertArrayEq('next from REFUNDED', nextPaymentStates('REFUNDED'), []);
assertEq('FAILED is terminal', TERMINAL_PAYMENT_STATUSES.has('FAILED'), true);
assertEq('REFUNDED is terminal', TERMINAL_PAYMENT_STATUSES.has('REFUNDED'), true);
assertEq('PROCESSING not terminal', TERMINAL_PAYMENT_STATUSES.has('PROCESSING'), false);
assertEq('SUCCEEDED not terminal', TERMINAL_PAYMENT_STATUSES.has('SUCCEEDED'), false);

// ── Invoice state machine — Phase 15 refund re-transitions ─────────────
console.log('\ninvoices.state-machine (Phase 15 extensions):');
// Phase 15 new transitions (refund-driven).
assertEq('PAID → DUE (refund)', isValidInvoiceTransition('PAID', 'DUE'), true);
assertEq('PAID → PARTIALLY_PAID (partial refund)', isValidInvoiceTransition('PAID', 'PARTIALLY_PAID'), true);
assertEq('PARTIALLY_PAID → DUE (full refund)', isValidInvoiceTransition('PARTIALLY_PAID', 'DUE'), true);
// Old transitions still allowed.
assertEq('DUE → PAID (webhook)', isValidInvoiceTransition('DUE', 'PAID'), true);
assertEq('DUE → DISPUTED (party)', isValidInvoiceTransition('DUE', 'DISPUTED'), true);
assertEq('DUE → WAIVED (admin)', isValidInvoiceTransition('DUE', 'WAIVED'), true);
assertEq('PARTIALLY_PAID → PAID (webhook)', isValidInvoiceTransition('PARTIALLY_PAID', 'PAID'), true);
assertEq('DISPUTED → DUE (admin resolves)', isValidInvoiceTransition('DISPUTED', 'DUE'), true);
assertEq('DISPUTED → PAID (webhook)', isValidInvoiceTransition('DISPUTED', 'PAID'), true);
// Illegal transitions.
assertEq('PAID → WAIVED (illegal)', isValidInvoiceTransition('PAID', 'WAIVED'), false);
assertEq('WAIVED → PAID (illegal, terminal)', isValidInvoiceTransition('WAIVED', 'PAID'), false);
assertEq('WAIVED → DUE (illegal, terminal)', isValidInvoiceTransition('WAIVED', 'DUE'), false);
// Phase 15 terminal set: only WAIVED (PAID removed since refund reverts it).
assertEq('WAIVED is terminal', TERMINAL_INVOICE_STATUSES.has('WAIVED'), true);
assertEq('PAID is no longer terminal', TERMINAL_INVOICE_STATUSES.has('PAID'), false);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED.`);
  process.exit(1);
}
console.log('\nAll Phase 15 state-machine assertions passed.');
