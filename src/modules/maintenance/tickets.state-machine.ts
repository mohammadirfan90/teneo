// src/modules/maintenance/tickets.state-machine.ts
//
// Pure state-machine for the maintenance-ticket lifecycle per spec §5.7
// and §11.5. Mirrors `invoices.state-machine.ts` /
// `applications.state-machine.ts` — no I/O; consumed by
// tickets.service.ts to validate `PATCH /tickets/:id`.
//
// Trigger matrix (who can request each transition — enforced at the
// route + service layer, NOT here):
//   OPEN          → ACKNOWLEDGED   OWNER (room's property) / ADMIN
//   OPEN          → CANCELLED      TENANT (the raiser) — pre-ack only
//   ACKNOWLEDGED  → IN_PROGRESS    OWNER (room's property) / ADMIN
//   ACKNOWLEDGED  → CANCELLED      TENANT (the raiser) — pre-in-progress
//   ACKNOWLEDGED  → DISPUTED       TENANT (a tenant on the lease)
//   IN_PROGRESS   → RESOLVED       OWNER (room's property) / ADMIN
//   IN_PROGRESS   → DISPUTED       TENANT (a tenant on the lease)
//   RESOLVED      → CLOSED         OWNER (room's property) / ADMIN
//   RESOLVED      → DISPUTED       TENANT (a tenant on the lease)
//   DISPUTED      → RESOLVED       ADMIN only
//
// Terminal: CLOSED, CANCELLED. (DISPUTED is NOT terminal — it can flow
// back to RESOLVED.)
//
// SLA policy (raised_at + these hours):
//   LOW      168h (7d)
//   MEDIUM    72h (3d)
//   HIGH      24h (1d)
//   URGENT     4h

import type {
  MaintenancePriority,
  MaintenanceStatus,
} from '@/generated/prisma/enums';

/** Allowed `to` set for each `from` status. */
const VALID_TRANSITIONS: Record<MaintenanceStatus, ReadonlySet<MaintenanceStatus>> = {
  OPEN: new Set<MaintenanceStatus>([
    'ACKNOWLEDGED',
    'CANCELLED',
  ]),
  ACKNOWLEDGED: new Set<MaintenanceStatus>([
    'IN_PROGRESS',
    'CANCELLED',
    'DISPUTED',
  ]),
  IN_PROGRESS: new Set<MaintenanceStatus>([
    'RESOLVED',
    'DISPUTED',
  ]),
  RESOLVED: new Set<MaintenanceStatus>([
    'CLOSED',
    'DISPUTED',
  ]),
  DISPUTED: new Set<MaintenanceStatus>([
    'RESOLVED',
  ]),
  CLOSED: new Set<MaintenanceStatus>([]),
  CANCELLED: new Set<MaintenanceStatus>([]),
};

/** Pure check: is the (from -> to) transition allowed by the state machine? */
export function isValidTicketTransition(
  from: MaintenanceStatus,
  to: MaintenanceStatus
): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

/** Return all states reachable in one step from `from`. */
export function nextTicketStates(
  from: MaintenanceStatus
): readonly MaintenanceStatus[] {
  return Array.from(VALID_TRANSITIONS[from]);
}

/** Terminal ticket statuses — no further transitions possible. */
export const TERMINAL_TICKET_STATUSES: ReadonlySet<MaintenanceStatus> =
  new Set<MaintenanceStatus>(['CLOSED', 'CANCELLED']);

/**
 * SLA-hours policy per priority. Single source of truth for
 * `MaintenanceTicket.slaTargetAt` computation at raise-time and for
 * the inline breach check inside `transitionTicket`.
 */
export const SLA_HOURS_BY_PRIORITY: Record<MaintenancePriority, number> = {
  LOW: 168, // 7d
  MEDIUM: 72, // 3d
  HIGH: 24, // 1d
  URGENT: 4,
};

/** Convenience wrapper used by the service layer. */
export function slaHoursFor(priority: MaintenancePriority): number {
  return SLA_HOURS_BY_PRIORITY[priority];
}

/**
 * Post-lease grace window for raising a new ticket (spec 11 §11.5.5).
 * A tenant whose lease ended can still raise tickets for this many
 * days after lease.endDate. Enforced at the service layer, not here.
 */
export const POST_LEASE_GRACE_DAYS = 7;
