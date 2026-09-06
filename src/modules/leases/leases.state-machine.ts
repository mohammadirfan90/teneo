// src/modules/leases/leases.state-machine.ts
//
// Pure state-machine for the lease lifecycle per spec §7.5.1, §7.5.2.
//
// Mirrors `applications.state-machine.ts` — no I/O; consumed by
// `leases.service.ts` to validate transitions and gate the sign /
// confirm-move-in / terminate routes.
//
// Transitions are gated at the route + service layer with identity
// checks (owner / tenant parties), NOT here, because the DRAFT →
// SIGNED transition requires every party to have signed, which is a
// database query.
//
// Trigger matrix (who / when):
//   DRAFT     → SIGNED      last required lease_signature row inserted
//                           (owner + every co-tenant). Idempotent per
//                           party via UNIQUE(lease_id, signer_user_id).
//   SIGNED    → ACTIVE      POST /confirm-move-in (any tenant party)
//   ACTIVE    → ENDED       Phase 14 cron (no route in Phase 13)
//   ACTIVE    → TERMINATED  POST /terminate (TENANT or OWNER party)
//
// Terminal: ENDED, TERMINATED.

import type { LeaseStatus } from '@/generated/prisma/enums';

/** Allowed `to` set for each `from` status. */
const VALID_TRANSITIONS: Record<LeaseStatus, ReadonlySet<LeaseStatus>> = {
  DRAFT: new Set<LeaseStatus>(['SIGNED']),
  SIGNED: new Set<LeaseStatus>(['ACTIVE']),
  ACTIVE: new Set<LeaseStatus>(['ENDED', 'TERMINATED']),
  ENDED: new Set<LeaseStatus>([]),
  TERMINATED: new Set<LeaseStatus>([]),
};

/** Pure check: is the (from → to) transition allowed by the state machine? */
export function isValidLeaseTransition(from: LeaseStatus, to: LeaseStatus): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all states reachable in one step from `from` (for debug / docs). */
export function nextLeaseStates(from: LeaseStatus): readonly LeaseStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}

/** Terminal lease statuses (no further transitions possible). */
export const TERMINAL_LEASE_STATUSES: ReadonlySet<LeaseStatus> = new Set<LeaseStatus>([
  'ENDED',
  'TERMINATED',
]);
