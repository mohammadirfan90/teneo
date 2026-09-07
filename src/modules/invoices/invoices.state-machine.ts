// src/modules/invoices/invoices.state-machine.ts
//
// Pure state-machine for the rent invoice lifecycle per spec §5.2.
//
// Mirrors `leases.state-machine.ts` and `applications.state-machine.ts`
// — no I/O; consumed by `invoices.service.ts` to validate the
// `POST /invoices/:id/dispute` and `POST /invoices/:id/waive` transitions.
//
// Trigger matrix (who can request each transition — enforced at the
// route + service layer, NOT here):
//   DUE             → PARTIALLY_PAID   Phase 15 (Stripe webhook)
//   DUE             → PAID             Phase 15 (Stripe webhook)
//   DUE             → OVERDUE          Phase 17 cron
//   DUE             → WAIVED           ADMIN
//   DUE             → DISPUTED         TENANT or OWNER party
//   PARTIALLY_PAID  → PAID             Phase 15 (Stripe webhook)
//   PARTIALLY_PAID  → DUE              Phase 15 (refund webhook — full
//                                    refund leaves amount_paid=0, so we
//                                    drop back to DUE)
//   PARTIALLY_PAID  → OVERDUE          Phase 17 cron
//   PARTIALLY_PAID  → WAIVED           ADMIN
//   PARTIALLY_PAID  → DISPUTED         TENANT or OWNER party
//   OVERDUE         → PARTIALLY_PAID   Phase 15 (Stripe webhook)
//   OVERDUE         → PAID             Phase 15 (Stripe webhook)
//   OVERDUE         → WAIVED           ADMIN
//   OVERDUE         → DISPUTED         TENANT or OWNER party
//   PAID            → DUE              Phase 15 (refund webhook — full
//                                    refund leaves amount_paid=0)
//   PAID            → PARTIALLY_PAID   Phase 15 (partial refund — see note
//                                    in payments.service.ts:handleChargeRefunded)
//   DISPUTED        → DUE              ADMIN resolves (rejects dispute)
//   DISPUTED        → PARTIALLY_PAID   Phase 15 (Stripe webhook) — partial
//                                    payment during a dispute is allowed
//   DISPUTED        → PAID             Phase 15 (Stripe webhook)
//   DISPUTED        → WAIVED           ADMIN resolves (forgives balance)
//
// Terminal: WAIVED only. (PAID is reachable from DUE/PARTIALLY_PAID via
// webhook and revertible back to DUE/PARTIALLY_PAID via refund.)

import type { InvoiceStatus } from '@/generated/prisma/enums';

/** Allowed `to` set for each `from` status. */
const VALID_TRANSITIONS: Record<InvoiceStatus, ReadonlySet<InvoiceStatus>> = {
  DUE: new Set<InvoiceStatus>([
    'PARTIALLY_PAID',
    'PAID',
    'OVERDUE',
    'WAIVED',
    'DISPUTED',
  ]),
  PARTIALLY_PAID: new Set<InvoiceStatus>([
    'PAID',
    'DUE',
    'OVERDUE',
    'WAIVED',
    'DISPUTED',
  ]),
  PAID: new Set<InvoiceStatus>([
    'DUE',
    'PARTIALLY_PAID',
  ]),
  OVERDUE: new Set<InvoiceStatus>([
    'PARTIALLY_PAID',
    'PAID',
    'WAIVED',
    'DISPUTED',
  ]),
  WAIVED: new Set<InvoiceStatus>([]),
  DISPUTED: new Set<InvoiceStatus>([
    'DUE',
    'PARTIALLY_PAID',
    'PAID',
    'WAIVED',
  ]),
};

/** Pure check: is the (from → to) transition allowed by the state machine? */
export function isValidInvoiceTransition(
  from: InvoiceStatus,
  to: InvoiceStatus
): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all states reachable in one step from `from`. */
export function nextInvoiceStates(from: InvoiceStatus): readonly InvoiceStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}

/** Terminal invoice statuses (no further transitions possible). */
export const TERMINAL_INVOICE_STATUSES: ReadonlySet<InvoiceStatus> = new Set<InvoiceStatus>([
  // PAID was removed in Phase 15 because refund webhooks can revert it
  // back to DUE or PARTIALLY_PAID. Only WAIVED is truly terminal.
  'WAIVED',
]);
