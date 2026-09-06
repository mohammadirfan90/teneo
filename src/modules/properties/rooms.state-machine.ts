// src/modules/properties/rooms.state-machine.ts
//
// Pure state-machine table for /rooms/:id/transition per spec §5.4.
// No I/O — consumed by rooms.service.ts to validate `POST /transition`
// and `POST /publish` (DRAFT→PUBLISHED shortcut).
//
// Trigger matrix (who can request each transition):
//   DRAFT             → PUBLISHED             OWNER (own)  [publish]
//   PUBLISHED         → RESERVED              system       [application approved — Phase 12]
//   PUBLISHED         → MAINTENANCE           OWNER (own)
//   PUBLISHED         → TAKEN_DOWN            ADMIN
//   RESERVED          → OCCUPIED              system       [lease activated — Phase 13]
//   RESERVED          → PUBLISHED             system       [lease draft cancelled — Phase 12]
//   OCCUPIED          → MAINTENANCE_CHECK     system       [lease ended — Phase 13]
//   MAINTENANCE_CHECK → PUBLISHED             OWNER (own)
//   MAINTENANCE       → PUBLISHED             OWNER (own)
//
// Phase 10 only accepts OWNER-driven transitions (and ADMIN for
// TAKEN_DOWN). System transitions are wired in later phases; the
// state machine itself doesn't enforce *who* — that's the caller's
// responsibility (route layer + service layer).

import type { RoomStatus } from '@/generated/prisma/enums';

/** Allowed `to` set for each `from` status. */
const VALID_TRANSITIONS: Record<RoomStatus, ReadonlySet<RoomStatus>> = {
  DRAFT: new Set<RoomStatus>(['PUBLISHED']),
  PUBLISHED: new Set<RoomStatus>(['RESERVED', 'MAINTENANCE', 'TAKEN_DOWN']),
  RESERVED: new Set<RoomStatus>(['OCCUPIED', 'PUBLISHED']),
  OCCUPIED: new Set<RoomStatus>(['MAINTENANCE_CHECK']),
  MAINTENANCE_CHECK: new Set<RoomStatus>(['PUBLISHED']),
  MAINTENANCE: new Set<RoomStatus>(['PUBLISHED']),
  TAKEN_DOWN: new Set<RoomStatus>([]),
};

/** Pure check: is the (from → to) transition allowed by the state machine? */
export function isValidTransition(from: RoomStatus, to: RoomStatus): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all states reachable in one step from `from` (for debug / docs). */
export function nextStates(from: RoomStatus): readonly RoomStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}
