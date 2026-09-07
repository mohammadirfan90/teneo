// src/modules/payments/payments.state-machine.ts
//
// Pure state-machine for the Payment lifecycle per spec §7.4.
//
// Mirrors `invoices.state-machine.ts` and `leases.state-machine.ts` —
// no I/O; consumed by `payments.service.ts` to gate transitions.
//
// Trigger matrix (who can request each transition — enforced at the
// route + service layer, NOT here):
//   PROCESSING → SUCCEEDED   Stripe webhook (payment_intent.succeeded)
//   PROCESSING → FAILED      Stripe webhook (payment_intent.payment_failed)
//   SUCCEEDED  → REFUNDED    Stripe webhook (charge.refunded, full refund
//                            only in v1; partial is logged but doesn't
//                            flip status — see payments.service.ts)
//   FAILED     → (terminal)
//   REFUNDED   → (terminal)
//
// Terminal: FAILED, REFUNDED.

import type { PaymentStatus } from '@/generated/prisma/enums';

/** Allowed `to` set for each `from` status. */
const VALID_TRANSITIONS: Record<PaymentStatus, ReadonlySet<PaymentStatus>> = {
  PROCESSING: new Set<PaymentStatus>([
    'SUCCEEDED',
    'FAILED',
  ]),
  SUCCEEDED: new Set<PaymentStatus>([
    'REFUNDED',
  ]),
  FAILED: new Set<PaymentStatus>([]),
  REFUNDED: new Set<PaymentStatus>([]),
};

/** Pure check: is the (from → to) transition allowed by the state machine? */
export function isValidPaymentTransition(
  from: PaymentStatus,
  to: PaymentStatus
): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all states reachable in one step from `from`. */
export function nextPaymentStates(from: PaymentStatus): readonly PaymentStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}

/** Terminal payment statuses (no further transitions possible). */
export const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  'FAILED',
  'REFUNDED',
]);
