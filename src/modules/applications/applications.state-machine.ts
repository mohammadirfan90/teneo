// src/modules/applications/applications.state-machine.ts
//
// Pure state-machine for /applications/:id/transition per spec §5.5.
// Mirrors rooms.state-machine.ts — no I/O; consumed by
// applications.service.ts to validate `POST /transition` (and the
// withdraw / viewing endpoints).
//
// Trigger matrix (who can request each transition — enforced at
// the route + service layer, NOT here):
//   SUBMITTED        → SCREENING         OWNER
//   SUBMITTED        → REJECTED          OWNER / ADMIN
//   SUBMITTED        → WITHDRAWN         TENANT
//   SCREENING        → VIEWING_SCHEDULED OWNER (creates viewing_request)
//   SCREENING        → SHORTLISTED       OWNER
//   SCREENING        → REJECTED          OWNER / ADMIN
//   VIEWING_SCHEDULED → SHORTLISTED      OWNER (after viewing)
//   VIEWING_SCHEDULED → REJECTED         OWNER
//   VIEWING_SCHEDULED → CANCELLED        TENANT or OWNER (viewing cancel)
//   SHORTLISTED      → APPROVED          OWNER (reserves the room)
//   SHORTLISTED      → REJECTED          OWNER / ADMIN
//
// Terminal: APPROVED, REJECTED, WITHDRAWN, CANCELLED — no further moves.

import type { ApplicationStatus } from '@/generated/prisma/enums';

/** Allowed `to` set for each `from` status. */
const VALID_TRANSITIONS: Record<ApplicationStatus, ReadonlySet<ApplicationStatus>> = {
  SUBMITTED: new Set<ApplicationStatus>(['SCREENING', 'REJECTED', 'WITHDRAWN']),
  SCREENING: new Set<ApplicationStatus>(['VIEWING_SCHEDULED', 'SHORTLISTED', 'REJECTED']),
  VIEWING_SCHEDULED: new Set<ApplicationStatus>(['SHORTLISTED', 'REJECTED', 'CANCELLED']),
  SHORTLISTED: new Set<ApplicationStatus>(['APPROVED', 'REJECTED']),
  APPROVED: new Set<ApplicationStatus>([]),
  REJECTED: new Set<ApplicationStatus>([]),
  WITHDRAWN: new Set<ApplicationStatus>([]),
  CANCELLED: new Set<ApplicationStatus>([]),
};

/** Pure check: is the (from → to) transition allowed by the state machine? */
export function isValidTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all states reachable in one step from `from` (for debug / docs). */
export function nextStates(from: ApplicationStatus): readonly ApplicationStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}

/**
 * Set of statuses considered "active" for the partial UNIQUE index
 * `(room_id, tenant_user_id) WHERE status IN (...)` defined in the
 * migration SQL. Tenants can only have ONE row in this set per room.
 */
export const ACTIVE_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> =
  new Set<ApplicationStatus>([
    'SUBMITTED',
    'SCREENING',
    'VIEWING_SCHEDULED',
    'SHORTLISTED',
    'APPROVED',
  ]);
