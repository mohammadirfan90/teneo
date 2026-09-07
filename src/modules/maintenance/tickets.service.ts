// src/modules/maintenance/tickets.service.ts
//
// Business logic for /api/v1/rooms/:roomId/tickets and
// /api/v1/tickets/* per spec §5.7 + §11.5 (Phase 17).
//
// Authorization model:
//   • TENANT on the lease (raise-time must be ACTIVE or ended within
//     POST_LEASE_GRACE_DAYS — spec 11 §11.5.5) may CREATE tickets and
//     CANCEL their own pre-ACKNOWLEDGED ticket. They may also DISPUTE
//     a RESOLVED ticket.
//   • OWNER of the room's parent property may acknowledge, transition
//     to IN_PROGRESS, RESOLVE, or CLOSE.
//   • ADMIN may do any of the above AND may move DISPUTED → RESOLVED
//     (which neither owners nor tenants can).
//   • Any party (owner / tenant / admin) may READ the ticket and ADD
//     comments.
//
// Rating rules (POST /tickets/:id/rate):
//   • Only the raiser (raisedByUserId === caller) can rate.
//   • Only valid when status === RESOLVED.
//   • Only once per ticket (rating IS NULL pre-rate).

import { Prisma } from '@/generated/prisma/client';
import type {
  MaintenanceCategory,
  MaintenancePriority,
  MaintenanceStatus,
} from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  SemanticError,
} from '@/lib/errors';

import {
  POST_LEASE_GRACE_DAYS,
  SLA_HOURS_BY_PRIORITY,
  TERMINAL_TICKET_STATUSES,
  isValidTicketTransition,
  slaHoursFor,
} from './tickets.state-machine';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface TicketView {
  id: string;
  roomId: string;
  leaseId: string;
  raisedByUserId: string;
  title: string;
  description: string;
  category: MaintenanceCategory;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  slaTargetAt: string;
  slaBreachedAt: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  closedAt: string | null;
  closedByUserId: string | null;
  rating: number | null;
  ratingComment: string | null;
  ratingSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketSummaryView {
  id: string;
  roomId: string;
  leaseId: string;
  title: string;
  category: MaintenanceCategory;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  slaTargetAt: string;
  slaBreachedAt: string | null;
  resolvedAt: string | null;
  rating: number | null;
  createdAt: string;
}

export interface UpdateView {
  id: string;
  ticketId: string;
  authorUserId: string;
  body: string;
  statusAfter: MaintenanceStatus | null;
  createdAt: string;
}

export interface TicketDetailView {
  ticket: TicketView;
  updates: UpdateView[];
}

export interface TicketPage {
  items: TicketSummaryView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row types + mappers
// ──────────────────────────────────────────────────────────────────────

type TicketRow = {
  id: string;
  roomId: string;
  leaseId: string;
  raisedByUserId: string;
  title: string;
  description: string;
  category: MaintenanceCategory;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  slaTargetAt: Date;
  slaBreachedAt: Date | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  rating: number | null;
  ratingComment: string | null;
  ratingSubmittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type UpdateRow = {
  id: string;
  ticketId: string;
  authorUserId: string;
  body: string;
  statusAfter: MaintenanceStatus | null;
  createdAt: Date;
};

function ticketRowToView(r: TicketRow): TicketView {
  return {
    id: r.id,
    roomId: r.roomId,
    leaseId: r.leaseId,
    raisedByUserId: r.raisedByUserId,
    title: r.title,
    description: r.description,
    category: r.category,
    priority: r.priority,
    status: r.status,
    slaTargetAt: r.slaTargetAt.toISOString(),
    slaBreachedAt: r.slaBreachedAt?.toISOString() ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedByUserId: r.resolvedByUserId,
    closedAt: r.closedAt?.toISOString() ?? null,
    closedByUserId: r.closedByUserId,
    rating: r.rating,
    ratingComment: r.ratingComment,
    ratingSubmittedAt: r.ratingSubmittedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function ticketRowToSummary(r: TicketRow): TicketSummaryView {
  return {
    id: r.id,
    roomId: r.roomId,
    leaseId: r.leaseId,
    title: r.title,
    category: r.category,
    priority: r.priority,
    status: r.status,
    slaTargetAt: r.slaTargetAt.toISOString(),
    slaBreachedAt: r.slaBreachedAt?.toISOString() ?? null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    rating: r.rating,
    createdAt: r.createdAt.toISOString(),
  };
}

function updateRowToView(r: UpdateRow): UpdateView {
  return {
    id: r.id,
    ticketId: r.ticketId,
    authorUserId: r.authorUserId,
    body: r.body,
    statusAfter: r.statusAfter,
    createdAt: r.createdAt.toISOString(),
  };
}

const fullTicketSelect = () =>
  ({
    id: true,
    roomId: true,
    leaseId: true,
    raisedByUserId: true,
    title: true,
    description: true,
    category: true,
    priority: true,
    status: true,
    slaTargetAt: true,
    slaBreachedAt: true,
    resolvedAt: true,
    resolvedByUserId: true,
    closedAt: true,
    closedByUserId: true,
    rating: true,
    ratingComment: true,
    ratingSubmittedAt: true,
    createdAt: true,
    updatedAt: true,
  }) satisfies Prisma.MaintenanceTicketSelect;

const summaryTicketSelect = () =>
  ({
    id: true,
    roomId: true,
    leaseId: true,
    title: true,
    category: true,
    priority: true,
    status: true,
    slaTargetAt: true,
    slaBreachedAt: true,
    resolvedAt: true,
    rating: true,
    createdAt: true,
  }) satisfies Prisma.MaintenanceTicketSelect;

const fullUpdateSelect = () =>
  ({
    id: true,
    ticketId: true,
    authorUserId: true,
    body: true,
    statusAfter: true,
    createdAt: true,
  }) satisfies Prisma.MaintenanceUpdateSelect;

// ──────────────────────────────────────────────────────────────────────
// Party resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Resolve parties for an EXISTING ticket. Returns `ownerId: null` and
 * `tenantIds: []` when the ticket doesn't exist so the middleware
 * can 404 without leaking existence.
 *
 * 2-hop lookup: ticket → lease → owner + tenants. Mirrors
 * `resolvePartiesForInvoice` (Phase 14) and `resolvePartiesForMeter`
 * (Phase 16).
 */
export async function resolvePartiesForTicket(ticketId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
  roomId: string | null;
  leaseId: string | null;
}> {
  const row = await prisma.maintenanceTicket.findUnique({
    where: { id: ticketId },
    select: {
      roomId: true,
      leaseId: true,
      lease: {
        select: {
          ownerUserId: true,
          tenants: { select: { tenantUserId: true } },
        },
      },
    },
  });
  if (!row) return { ownerId: null, tenantIds: [], roomId: null, leaseId: null };
  return {
    ownerId: row.lease.ownerUserId,
    tenantIds: row.lease.tenants.map((t) => t.tenantUserId),
    roomId: row.roomId,
    leaseId: row.leaseId,
  };
}

/**
 * Resolve parties for a room (when no ticket yet exists). 2-hop:
 * room → property → owner; tenants via property.rooms → leases
 * (ACTIVE only). Mirrors `resolvePartiesForMeter` (Phase 16).
 */
export async function resolvePartiesForRoom(roomId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
  propertyId: string | null;
}> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { propertyId: true },
  });
  if (!room) return { ownerId: null, tenantIds: [], propertyId: null };

  const property = await prisma.property.findUnique({
    where: { id: room.propertyId },
    select: { ownerUserId: true, rooms: { select: { id: true } } },
  });
  if (!property) return { ownerId: null, tenantIds: [], propertyId: room.propertyId };

  const roomIds = property.rooms.map((r) => r.id);
  if (roomIds.length === 0) {
    return {
      ownerId: property.ownerUserId,
      tenantIds: [],
      propertyId: room.propertyId,
    };
  }

  const leases = await prisma.lease.findMany({
    where: { roomId: { in: roomIds }, status: 'ACTIVE' },
    select: { tenants: { select: { tenantUserId: true } } },
  });
  const tenantIds = new Set<string>();
  for (const lease of leases) {
    for (const lt of lease.tenants) tenantIds.add(lt.tenantUserId);
  }
  return {
    ownerId: property.ownerUserId,
    tenantIds: [...tenantIds],
    propertyId: room.propertyId,
  };
}

// ──────────────────────────────────────────────────────────────────────
// RAISE-TIME GUARD — find an eligible lease for the caller
// ──────────────────────────────────────────────────────────────────────

interface EligibleLease {
  id: string;
  leaseId: string;
  roomId: string;
  endedAt: Date | null;
}

/**
 * Find a lease the caller can raise a ticket on for the given room.
 * Eligible means:
 *   (a) Caller is a tenant on the lease; AND
 *   (b) lease.status === 'ACTIVE' OR
 *       lease.endedAt is within POST_LEASE_GRACE_DAYS of today (UTC).
 *
 * Returns the FIRST eligible lease (most-recent by endedAt desc, so a
 * recently-ended lease wins over an older ACTIVE one if the tenant is
 * on both — unusual but cheap).
 *
 * Returns `null` when no eligible lease exists; service throws 403.
 */
async function findEligibleLeaseForRaise(
  tx: Prisma.TransactionClient,
  callerUserId: string,
  roomId: string,
  now: Date
): Promise<EligibleLease | null> {
  // Pull the most-recent ACTIVE or recently-ENDED lease for this room
  // that includes the caller as a tenant.
  const leases = await tx.lease.findMany({
    where: {
      roomId,
      tenants: { some: { tenantUserId: callerUserId } },
      OR: [
        { status: 'ACTIVE' },
        // Ended leases inside the post-lease grace window.
        {
          status: 'ENDED',
          endedAt: { gte: new Date(now.getTime() - POST_LEASE_GRACE_DAYS * 24 * 60 * 60 * 1000) },
        },
        {
          status: 'TERMINATED',
          endedAt: { gte: new Date(now.getTime() - POST_LEASE_GRACE_DAYS * 24 * 60 * 60 * 1000) },
        },
      ],
    },
    orderBy: { endedAt: 'desc' },
    select: { id: true, roomId: true, endedAt: true },
  });
  return leases[0] ? { ...leases[0], leaseId: leases[0].id } : null;
}

// ──────────────────────────────────────────────────────────────────────
// createTicket — POST /rooms/:roomId/tickets
// ──────────────────────────────────────────────────────────────────────

export interface CreateTicketServiceInput {
  roomId: string;
  title: string;
  description: string;
  category: MaintenanceCategory;
  priority: MaintenancePriority;
}

/**
 * Create a new maintenance ticket. Caller must be a tenant on an
 * eligible lease (see findEligibleLeaseForRaise). Computes SLA target
 * from priority, writes the ticket + first update row + audit +
 * outbox in a single transaction.
 */
export async function createTicket(
  callerUserId: string,
  input: CreateTicketServiceInput
): Promise<TicketView> {
  return await prisma.$transaction(async (tx) => {
    const now = new Date();

    // 1. Room exists.
    const room = await tx.room.findUnique({
      where: { id: input.roomId },
      select: { id: true, propertyId: true },
    });
    if (!room) throw new NotFoundError('Room not found');

    // 2. Caller is a tenant on an eligible lease.
    const eligible = await findEligibleLeaseForRaise(
      tx,
      callerUserId,
      input.roomId,
      now
    );
    if (!eligible) {
      throw new ForbiddenError(
        'NOT_OWNER',
        'Caller is not a tenant on an eligible lease for this room'
      );
    }

    // 3. Compute SLA target.
    const slaHours = slaHoursFor(input.priority);
    const slaTargetAt = new Date(now.getTime() + slaHours * 60 * 60 * 1000);

    // 4. Insert the ticket.
    const created = await tx.maintenanceTicket.create({
      data: {
        roomId: input.roomId,
        leaseId: eligible.leaseId,
        raisedByUserId: callerUserId,
        title: input.title,
        description: input.description,
        category: input.category,
        priority: input.priority,
        status: 'OPEN',
        slaTargetAt,
      },
      select: { id: true },
    });

    // 5. First update row — the description as the ticket's initial
    // entry. Lets the timeline view be one list without a special case.
    await tx.maintenanceUpdate.create({
      data: {
        ticketId: created.id,
        authorUserId: callerUserId,
        body: input.description,
        statusAfter: null,
      },
      select: { id: true },
    });

    // 6. Audit + outbox.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'TENANT',
        action: 'ticket.created',
        targetEntityType: 'maintenance_ticket',
        targetEntityId: created.id,
        before: Prisma.JsonNull,
        after: {
          roomId: input.roomId,
          leaseId: eligible.leaseId,
          title: input.title,
          category: input.category,
          priority: input.priority,
          slaTargetAt: slaTargetAt.toISOString(),
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'ticket.created',
        payload: {
          ticketId: created.id,
          roomId: input.roomId,
          leaseId: eligible.leaseId,
          raisedByUserId: callerUserId,
          title: input.title,
          category: input.category,
          priority: input.priority,
          slaTargetAt: slaTargetAt.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    // 7. Reload for view.
    const reloaded = await tx.maintenanceTicket.findUnique({
      where: { id: created.id },
      select: fullTicketSelect(),
    });
    if (!reloaded) throw new NotFoundError('Ticket vanished after create');
    return ticketRowToView(reloaded as unknown as TicketRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// transitionTicket — PATCH /tickets/:id
// ──────────────────────────────────────────────────────────────────────

/**
 * Authoritative transition path. Validates the state machine, the
 * caller's authorization for the specific (from, to), and lazily
 * flags SLA breach if `now > slaTargetAt`. Side effects:
 *   - → RESOLVED: resolvedAt + resolvedByUserId
 *   - → CLOSED:   closedAt   + closedByUserId
 *   - DISPUTED allowed from ACK/IN_PROGRESS/RESOLVED (tenant only)
 *
 * Pure re-load for caller — no separate statusAfter update is needed
 * because the status column itself is the source of truth.
 */
export interface TransitionTicketServiceInput {
  id: string;
  toStatus: MaintenanceStatus;
  /** Optional — appended as a comment row in the same tx. */
  comment: string | null;
}

export async function transitionTicket(
  callerUserId: string,
  isAdmin: boolean,
  input: TransitionTicketServiceInput
): Promise<TicketView> {
  return await prisma.$transaction(async (tx) => {
    const now = new Date();

    // 1. Load ticket.
    const ticket = await tx.maintenanceTicket.findUnique({
      where: { id: input.id },
      select: {
        ...fullTicketSelect(),
        raisedByUserId: true,
      },
    });
    if (!ticket) throw new NotFoundError('Ticket not found');

    // 2. Caller authorization.
    assertCallerCanTransition(
      tx,
      ticket,
      callerUserId,
      isAdmin,
      input.toStatus
    );

    // 3. Validate state machine.
    if (!isValidTicketTransition(ticket.status, input.toStatus)) {
      throw new ConflictError(
        'STATE_MACHINE',
        `Invalid transition: ${ticket.status} → ${input.toStatus}`,
        [
          {
            field: 'toStatus',
            code: 'INVALID_TRANSITION',
            message: `cannot move from ${ticket.status} to ${input.toStatus}`,
          },
        ]
      );
    }
    if (TERMINAL_TICKET_STATUSES.has(ticket.status)) {
      throw new ConflictError(
        'STATE_MACHINE',
        `Ticket is in terminal state ${ticket.status}`,
        [
          {
            field: 'status',
            code: 'TERMINAL',
            message: `no further transitions from ${ticket.status}`,
          },
        ]
      );
    }

    // 4. Build the patch data.
    const data: Prisma.MaintenanceTicketUpdateInput = {
      status: input.toStatus,
    };
    if (input.toStatus === 'RESOLVED') {
      data.resolvedAt = now;
      data.resolvedBy = {
        connect: { id: callerUserId },
      };
    }
    if (input.toStatus === 'CLOSED') {
      data.closedAt = now;
      data.closedBy = {
        connect: { id: callerUserId },
      };
    }

    // 5. Inline SLA breach — set slaBreachedAt lazily on the first
    // transition after sla_target_at while the ticket is still open.
    const slaStillOpen =
      ticket.status !== 'CLOSED' &&
      ticket.status !== 'CANCELLED' &&
      ticket.status !== 'RESOLVED' &&
      input.toStatus !== 'CLOSED' &&
      input.toStatus !== 'CANCELLED' &&
      input.toStatus !== 'RESOLVED';
    if (
      ticket.slaBreachedAt === null &&
      slaStillOpen &&
      now.getTime() > ticket.slaTargetAt.getTime()
    ) {
      data.slaBreachedAt = now;
    }

    // 6. Apply.
    const updated = await tx.maintenanceTicket.update({
      where: { id: input.id },
      data,
      select: fullTicketSelect(),
    });

    // 7. Append the comment row (if any).
    if (input.comment) {
      await tx.maintenanceUpdate.create({
        data: {
          ticketId: input.id,
          authorUserId: callerUserId,
          body: input.comment,
          statusAfter: input.toStatus,
        },
        select: { id: true },
      });
    }

    // 8. Audit + outbox.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: isAdmin ? 'ADMIN' : 'OWNER', // tenant-raiser already blocked
        action: `ticket.transition.${input.toStatus.toLowerCase()}`,
        targetEntityType: 'maintenance_ticket',
        targetEntityId: input.id,
        before: { status: ticket.status },
        after: { status: input.toStatus },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'ticket.transition',
        payload: {
          ticketId: input.id,
          from: ticket.status,
          to: input.toStatus,
          actorUserId: callerUserId,
          slaBreached: data.slaBreachedAt != null,
        } as Prisma.InputJsonValue,
      },
    });

    return ticketRowToView(updated as unknown as TicketRow);
  });
}

/**
 * Authorization for the (ticket, caller, target-status) triple.
 * Throws 403 NOT_OWNER when the caller is not permitted.
 *
 *   OPEN          → ACKNOWLEDGED/CANCELLED       OWNER/ADMIN; CANCELLED also TENANT (raiser)
 *   ACKNOWLEDGED  → IN_PROGRESS/CANCELLED/DISPUTED  OWNER/ADMIN for first two; TENANT for last two
 *   IN_PROGRESS   → RESOLVED/DISPUTED            OWNER/ADMIN; TENANT for DISPUTED
 *   RESOLVED      → CLOSED/DISPUTED              OWNER/ADMIN for first; TENANT for last
 *   DISPUTED      → RESOLVED                     ADMIN ONLY
 */
async function assertCallerCanTransition(
  tx: Prisma.TransactionClient,
  ticket: { raisedByUserId: string; leaseId: string },
  callerUserId: string,
  isAdmin: boolean,
  toStatus: MaintenanceStatus
): Promise<void> {
  const lease = await tx.lease.findUnique({
    where: { id: ticket.leaseId },
    select: {
      ownerUserId: true,
      tenants: { select: { tenantUserId: true } },
    },
  });
  if (!lease) {
    throw new NotFoundError('Underlying lease not found');
  }
  const isOwner = lease.ownerUserId === callerUserId;
  const isTenant = lease.tenants.some((t) => t.tenantUserId === callerUserId);
  const isRaiser = ticket.raisedByUserId === callerUserId;

  const isOwnerOrAdmin = isOwner || isAdmin;

  switch (toStatus) {
    case 'ACKNOWLEDGED':
    case 'IN_PROGRESS':
    case 'RESOLVED':
    case 'CLOSED':
      if (!isOwnerOrAdmin) {
        throw new ForbiddenError(
          'NOT_OWNER',
          `Only the property owner or ADMIN may transition to ${toStatus}`
        );
      }
      // DISPUTED → RESOLVED is the only ADMIN-only path.
      return;

    case 'DISPUTED':
      if (!isTenant) {
        throw new ForbiddenError(
          'NOT_OWNER',
          'Only a tenant on the lease may dispute a resolution'
        );
      }
      return;

    case 'CANCELLED':
      // Tenant (the raiser) may cancel pre-acknowledged; no one else.
      if (!isRaiser) {
        throw new ForbiddenError(
          'NOT_OWNER',
          'Only the ticket raiser may cancel'
        );
      }
      return;

    default:
      throw new ForbiddenError('NOT_OWNER', `Unsupported transition target: ${toStatus}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// addUpdate — POST /tickets/:id/updates
// ──────────────────────────────────────────────────────────────────────

export interface AddUpdateServiceInput {
  ticketId: string;
  body: string;
  statusAfter: MaintenanceStatus | null;
}

/**
 * Append a comment to the ticket. If `statusAfter` is set, the same
 * call also transitions the ticket — the row carries both fields so
 * the timeline view shows them as one entry.
 *
 * Authorization: party to the ticket (owner / tenant / admin).
 */
export async function addUpdate(
  callerUserId: string,
  isAdmin: boolean,
  input: AddUpdateServiceInput
): Promise<UpdateView> {
  return await prisma.$transaction(async (tx) => {
    const ticket = await tx.maintenanceTicket.findUnique({
      where: { id: input.ticketId },
      select: { id: true, status: true, leaseId: true, raisedByUserId: true },
    });
    if (!ticket) throw new NotFoundError('Ticket not found');

    // Caller must be a party.
    const lease = await tx.lease.findUnique({
      where: { id: ticket.leaseId },
      select: {
        ownerUserId: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Underlying lease not found');
    const isParty =
      isAdmin ||
      lease.ownerUserId === callerUserId ||
      lease.tenants.some((t) => t.tenantUserId === callerUserId);
    if (!isParty) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this ticket');
    }

    // If we're transitioning in the same call, validate the state
    // machine + authz for the transition target.
    let breachUpdate: Date | null = null;
    if (input.statusAfter) {
      // Delegate to transitionTicket (without comment) so the auth +
      // SLA + audit logic stays in one place.
      // Inline the patch here to keep this whole operation in one tx.
      assertCallerCanTransition(
        tx,
        ticket,
        callerUserId,
        isAdmin,
        input.statusAfter
      );
      if (
        !isValidTicketTransition(ticket.status, input.statusAfter)
      ) {
        throw new ConflictError(
          'STATE_MACHINE',
          `Invalid transition: ${ticket.status} -> ${input.statusAfter}`,
          [
            {
              field: 'statusAfter',
              code: 'INVALID_TRANSITION',
              message: `cannot move from ${ticket.status} to ${input.statusAfter}`,
            },
          ]
        );
      }
      const now = new Date();
      const updateData: Prisma.MaintenanceTicketUpdateInput = {
        status: input.statusAfter,
      };
      if (input.statusAfter === 'RESOLVED') {
        updateData.resolvedAt = now;
        updateData.resolvedBy = { connect: { id: callerUserId } };
      }
      if (input.statusAfter === 'CLOSED') {
        updateData.closedAt = now;
        updateData.closedBy = { connect: { id: callerUserId } };
      }
      const fullNow = await tx.maintenanceTicket.findUnique({
        where: { id: input.ticketId },
        select: { slaBreachedAt: true, slaTargetAt: true },
      });
      if (
        fullNow &&
        fullNow.slaBreachedAt === null &&
        now.getTime() > fullNow.slaTargetAt.getTime() &&
        input.statusAfter !== 'CLOSED' &&
        input.statusAfter !== 'CANCELLED' &&
        input.statusAfter !== 'RESOLVED'
      ) {
        breachUpdate = now;
        updateData.slaBreachedAt = now;
      }
      await tx.maintenanceTicket.update({
        where: { id: input.ticketId },
        data: updateData,
      });
    }

    // 4. Append the update row (statusAfter mirrors the transition if any).
    const created = await tx.maintenanceUpdate.create({
      data: {
        ticketId: input.ticketId,
        authorUserId: callerUserId,
        body: input.body,
        statusAfter: input.statusAfter,
      },
      select: fullUpdateSelect(),
    });
    return updateRowToView(created as unknown as UpdateRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// rateTicket — POST /tickets/:id/rate
// ──────────────────────────────────────────────────────────────────────

export interface RateTicketServiceInput {
  id: string;
  rating: number;
  comment: string | null;
}

/**
 * Set the tenant satisfaction rating. Authorization:
 *   • Caller must be the original raiser (raisedByUserId === caller).
 *   • ticket.status must be RESOLVED.
 *   • ticket.rating must be NULL (re-rating returns 409 CONFLICT).
 */
export async function rateTicket(
  callerUserId: string,
  input: RateTicketServiceInput
): Promise<TicketView> {
  return await prisma.$transaction(async (tx) => {
    const ticket = await tx.maintenanceTicket.findUnique({
      where: { id: input.id },
      select: {
        ...fullTicketSelect(),
        raisedByUserId: true,
      },
    });
    if (!ticket) throw new NotFoundError('Ticket not found');

    // 1. Raiser only.
    if (ticket.raisedByUserId !== callerUserId) {
      throw new ForbiddenError(
        'NOT_OWNER',
        'Only the ticket raiser may submit a rating'
      );
    }

    // 2. Status must be RESOLVED.
    if (ticket.status !== 'RESOLVED') {
      throw new SemanticError(
        `Rating requires ticket status RESOLVED (got ${ticket.status})`,
        [
          {
            field: 'rating',
            code: 'INVALID_STATE',
            message: 'ticket must be RESOLVED before rating',
          },
        ]
      );
    }

    // 3. Rating not already submitted.
    if (ticket.rating !== null) {
      throw new ConflictError(
        'CONFLICT',
        'Ticket already has a rating',
        [
          {
            field: 'rating',
            code: 'ALREADY_RATED',
            message: 'rating may be submitted only once per ticket',
          },
        ]
      );
    }

    const now = new Date();
    const updated = await tx.maintenanceTicket.update({
      where: { id: input.id },
      data: {
        rating: input.rating,
        ratingComment: input.comment,
        ratingSubmittedAt: now,
      },
      select: fullTicketSelect(),
    });

    await tx.outboxEvent.create({
      data: {
        eventType: 'ticket.rated',
        payload: {
          ticketId: input.id,
          rating: input.rating,
          actorUserId: callerUserId,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'TENANT',
        action: 'ticket.rated',
        targetEntityType: 'maintenance_ticket',
        targetEntityId: input.id,
        before: { rating: null },
        after: { rating: input.rating },
      },
    });

    return ticketRowToView(updated as unknown as TicketRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// List endpoints
// ──────────────────────────────────────────────────────────────────────

export interface ListTicketsFilter {
  status?: MaintenanceStatus;
  priority?: MaintenancePriority;
}

/**
 * List tickets for the calling user. Three branches per role:
 *   • TENANT: tickets the caller raised (across all rooms).
 *   • OWNER: tickets for rooms on properties they own.
 *   • ADMIN: all tickets (no where-clause narrowing on tenancy).
 */
export async function listTicketsForCaller(
  callerUserId: string,
  isAdmin: boolean,
  isOwner: boolean,
  filter: ListTicketsFilter,
  limit: number,
  cursor: string | null
): Promise<TicketPage> {
  const where: Prisma.MaintenanceTicketWhereInput = {};
  if (!isAdmin) {
    if (isOwner) {
      // Owner: rooms on their properties.
      where.room = {
        property: { ownerUserId: callerUserId },
      };
    } else {
      // Tenant: only their own raised tickets.
      where.raisedByUserId = callerUserId;
    }
  }
  if (filter.status) where.status = filter.status;
  if (filter.priority) where.priority = filter.priority;

  return paginateTickets(where, limit, cursor);
}

/**
 * List tickets on a specific room. Caller must be a party
 * (owner / active tenant / admin) — middleware enforces.
 */
export async function listTicketsForRoom(
  callerUserId: string,
  isAdmin: boolean,
  roomId: string,
  filter: ListTicketsFilter,
  limit: number,
  cursor: string | null
): Promise<TicketPage> {
  const where: Prisma.MaintenanceTicketWhereInput = { roomId };
  if (!isAdmin) {
    where.OR = [
      { raisedByUserId: callerUserId },
      {
        room: { property: { ownerUserId: callerUserId } },
      },
    ];
  }
  if (filter.status) where.status = filter.status;
  if (filter.priority) where.priority = filter.priority;
  return paginateTickets(where, limit, cursor);
}

/**
 * Owner / admin triage queue. Order is SLA-target ascending so the
 * most-urgent ticket rises to the top.
 */
export async function listQueue(
  callerUserId: string,
  isAdmin: boolean,
  filter: ListTicketsFilter,
  limit: number,
  cursor: string | null
): Promise<TicketPage> {
  const where: Prisma.MaintenanceTicketWhereInput = {
    status: { notIn: ['CLOSED', 'CANCELLED'] },
  };
  if (!isAdmin) {
    where.room = { property: { ownerUserId: callerUserId } };
  }
  if (filter.status) {
    // /queue already excludes terminal; if caller filters to a
    // terminal status, return an empty page (clearer than 422).
    where.status = filter.status;
  }
  if (filter.priority) where.priority = filter.priority;
  return paginateTickets(where, limit, cursor, [{ slaTargetAt: 'asc' }]);
}

/**
 * GET /tickets/me — convenience: same as listTicketsForCaller with
 * role=TENANT.
 */
export async function listMyTickets(
  callerUserId: string,
  filter: ListTicketsFilter,
  limit: number,
  cursor: string | null
): Promise<TicketPage> {
  return listTicketsForCaller(callerUserId, false, false, filter, limit, cursor);
}

// ──────────────────────────────────────────────────────────────────────
// getTicket — GET /tickets/:id (party-or-admin)
// ──────────────────────────────────────────────────────────────────────

export async function getTicket(
  callerUserId: string,
  isAdmin: boolean,
  ticketId: string
): Promise<TicketDetailView> {
  // Authorization handled by the requireTicketParty middleware; this
  // service trusts that. Re-resolve parties to load the full detail.
  const ticket = await prisma.maintenanceTicket.findUnique({
    where: { id: ticketId },
    select: fullTicketSelect(),
  });
  if (!ticket) throw new NotFoundError('Ticket not found');

  const updates = await prisma.maintenanceUpdate.findMany({
    where: { ticketId },
    select: fullUpdateSelect(),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  return {
    ticket: ticketRowToView(ticket as unknown as TicketRow),
    updates: updates.map((u) => updateRowToView(u as unknown as UpdateRow)),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Pagination helper
// ──────────────────────────────────────────────────────────────────────

type OrderBy = Prisma.MaintenanceTicketOrderByWithRelationInput;

async function paginateTickets(
  where: Prisma.MaintenanceTicketWhereInput,
  limit: number,
  cursor: string | null,
  extraOrderBy?: OrderBy[]
): Promise<TicketPage> {
  const { cursorDate, cursorId } = decodeCursor(cursor);
  if (cursorDate && !Number.isNaN(cursorDate.getTime())) {
    // Cursor pagination: (createdAt < cursor.date) OR
    //                    (createdAt = cursor.date AND id < cursor.id).
    const or: Prisma.MaintenanceTicketWhereInput[] = [
      { createdAt: { lt: cursorDate } },
    ];
    if (cursorId) or.push({ createdAt: cursorDate, id: { lt: cursorId } });
    where.OR = or;
  }

  const rows = await prisma.maintenanceTicket.findMany({
    where,
    select: summaryTicketSelect(),
    orderBy: [
      ...(extraOrderBy ?? []),
      { createdAt: 'desc' },
      { id: 'desc' },
    ],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString(
          'base64url'
        )
      : null;

  return {
    items: slice.map((r) => ticketRowToSummary(r as unknown as TicketRow)),
    nextCursor,
  };
}

/**
 * Decode a cursor `<createdAt ISO>|<id>` into (date, id). Returns
 * `null` for any field that can't be parsed — invalid cursors are
 * silently ignored (caller gets the first page).
 */
function decodeCursor(cursor: string | null): {
  cursorDate: Date | null;
  cursorId: string | null;
} {
  if (!cursor) return { cursorDate: null, cursorId: null };
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    const date = iso ? new Date(iso) : null;
    return {
      cursorDate: date && !Number.isNaN(date.getTime()) ? date : null,
      cursorId: id || null,
    };
  } catch {
    return { cursorDate: null, cursorId: null };
  }
}

// Re-export for tests / callers that need to confirm the priority
// policy outside the service.
export { SLA_HOURS_BY_PRIORITY };
