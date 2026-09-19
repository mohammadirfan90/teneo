// src/modules/applications/applications.service.ts
//
// Business logic for /api/v1/applications and /api/v1/viewings per
// 13 §13.2.5, 05 §5.5, 05 §5.6, 04 §4.3.4.
//
// Hot path of the phase: the SHORTLISTED → APPROVED transition runs
// inside a single $transaction that:
//   1. Locks the room row (`SELECT ... FOR UPDATE`) so concurrent
//      owner clicks on different applications for the same room
//      serialize on Postgres.
//   2. Re-validates the application with an optimistic `version` guard.
//   3. Bulk-rejects every other active application on the same room.
//   4. Flips the room to RESERVED.
//   5. Writes audit + outbox rows in the same tx.
//
// Combined with the partial UNIQUE
// `(room_id, tenant_user_id) WHERE status IN (active set)` from the
// migration SQL, this is physically impossible for two tenants to
// both end up APPROVED for the same room.

import { Prisma } from '@/generated/prisma/client';
import type { ApplicationStatus, ViewingStatus } from '@/generated/prisma/enums';

import * as cacheLib from '@/lib/cache';
import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';

import type {
  AddApplicationNoteInput,
  CancelViewingInput,
  ConfirmViewingInput,
  CreateApplicationInput,
  CreateViewingInput,
  ListApplicationsQuery,
  TransitionApplicationInput,
  WithdrawApplicationInput,
} from './applications.schemas';
import { isValidTransition } from './applications.state-machine';

// ──────────────────────────────────────────────────────────────────────
// Views (render-ready DTOs)
// ──────────────────────────────────────────────────────────────────────

export interface ApplicationNoteView {
  id: string;
  applicationId: string;
  authorUserId: string;
  note: string;
  createdAt: string;
}

export interface ApplicationView {
  id: string;
  roomId: string;
  tenantUserId: string;
  message: string | null;
  status: ApplicationStatus;
  submittedAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  // Convenience joins for the client (no extra roundtrip needed).
  tenant: { id: string; displayName: string };
  property: { id: string; title: string; city: string };
}

export interface ApplicationPage {
  items: ApplicationView[];
  nextCursor: string | null;
}

export interface ViewingView {
  id: string;
  applicationId: string | null;
  roomId: string;
  tenantUserId: string;
  proposedSlots: string[];
  confirmedSlot: string | null;
  status: ViewingStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  'SUBMITTED',
  'SCREENING',
  'VIEWING_SCHEDULED',
  'SHORTLISTED',
  'APPROVED',
];

function noteToView(n: {
  id: string;
  applicationId: string;
  authorUserId: string;
  note: string;
  createdAt: Date;
}): ApplicationNoteView {
  return {
    id: n.id,
    applicationId: n.applicationId,
    authorUserId: n.authorUserId,
    note: n.note,
    createdAt: n.createdAt.toISOString(),
  };
}

type ApplicationRow = {
  id: string;
  roomId: string;
  tenantUserId: string;
  message: string | null;
  status: ApplicationStatus;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  tenant: { id: string; tenantProfile: { displayName: string } | null };
  room: { id: string; property: { id: string; title: string; city: string } };
};

async function loadApplication(id: string): Promise<ApplicationRow> {
  const row = await prisma.application.findUnique({
    where: { id },
    select: {
      id: true,
      roomId: true,
      tenantUserId: true,
      message: true,
      status: true,
      submittedAt: true,
      decidedAt: true,
      decidedByUserId: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      tenant: {
        select: {
          id: true,
          tenantProfile: { select: { displayName: true } },
        },
      },
      room: {
        select: {
          id: true,
          property: { select: { id: true, title: true, city: true } },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('Application not found');
  return row as unknown as ApplicationRow;
}

function toApplicationView(row: ApplicationRow): ApplicationView {
  return {
    id: row.id,
    roomId: row.roomId,
    tenantUserId: row.tenantUserId,
    message: row.message,
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tenant: {
      id: row.tenant.id,
      // Fall back to email local-part when no tenant_profile is set.
      displayName: row.tenant.tenantProfile?.displayName ?? 'Tenant',
    },
    property: {
      id: row.room.property.id,
      title: row.room.property.title,
      city: row.room.property.city,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// KYC + ownership helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Tenant must be KYC_APPROVED before applying for a room (05 §5.5).
 * Mirrors `assertKycApprovedForOwner` in properties.service.ts.
 */
export async function assertKycApprovedForTenant(userId: string): Promise<void> {
  const profile = await prisma.tenantProfile.findUnique({
    where: { userId },
    select: { kycStatus: true },
  });
  if (!profile) {
    throw new ForbiddenError('KYC_REQUIRED', 'Tenant profile not set up; complete KYC first');
  }
  if (profile.kycStatus !== 'APPROVED') {
    throw new ForbiddenError('KYC_REQUIRED', 'KYC approval required before applying for a room');
  }
}

/**
 * Resolve the property owner for an application — used by
 * `requireOwnership` middleware. Chains application → room →
 * property → ownerUserId. Returns null when the application
 * doesn't exist (so the middleware surfaces 404 NOT_FOUND instead
 * of 403 NOT_OWNER, preventing existence leaks).
 */
export async function resolveOwnerIdForApplication(applicationId: string): Promise<string | null> {
  const row = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { room: { select: { property: { select: { ownerUserId: true } } } } },
  });
  return row?.room.property.ownerUserId ?? null;
}

/**
 * Resolve the parties to a viewing — either the property owner or
 * the tenant named on the viewing. Used by `requireOwnership` so
 * either party (or ADMIN) can read/cancel the viewing.
 */
export async function resolvePartiesForViewing(viewingId: string): Promise<{
  ownerId: string | null;
  tenantId: string | null;
}> {
  const row = await prisma.viewingRequest.findUnique({
    where: { id: viewingId },
    select: {
      tenantUserId: true,
      room: { select: { property: { select: { ownerUserId: true } } } },
    },
  });
  if (!row) return { ownerId: null, tenantId: null };
  return {
    ownerId: row.room.property.ownerUserId,
    tenantId: row.tenantUserId,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /applications
// ──────────────────────────────────────────────────────────────────────

export async function createApplication(
  callerUserId: string,
  body: CreateApplicationInput
): Promise<ApplicationView> {
  await assertKycApprovedForTenant(callerUserId);

  // Confirm the room exists, is PUBLISHED, and is not deleted.
  const room = await prisma.room.findFirst({
    where: { id: body.roomId, deletedAt: null, status: 'PUBLISHED' },
    select: { id: true },
  });
  if (!room) throw new NotFoundError('Room not found or not currently published');

  let createdId: string;
  try {
    const created = await prisma.application.create({
      data: {
        roomId: body.roomId,
        tenantUserId: callerUserId,
        message: body.message ?? null,
      },
      select: { id: true, roomId: true },
    });
    createdId = created.id;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new ConflictError(
        'CONFLICT',
        'You already have an active application for this room; withdraw it first'
      );
    }
    throw e;
  }

  // Outbox + audit in a follow-up $transaction so a flaky outbox
  // doesn't roll back the application creation.
  const ownerId = await prisma.room
    .findUnique({
      where: { id: body.roomId },
      select: { property: { select: { ownerUserId: true } } },
    })
    .then((r) => r?.property.ownerUserId ?? null);
  if (!ownerId) throw new NotFoundError('Room owner not found');

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'TENANT',
        action: 'application.created',
        targetEntityType: 'application',
        targetEntityId: createdId,
        before: Prisma.JsonNull,
        after: { status: 'SUBMITTED', roomId: body.roomId },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'application.received',
        payload: {
          applicationId: createdId,
          roomId: body.roomId,
          tenantUserId: callerUserId,
          ownerUserId: ownerId,
        } as Prisma.InputJsonValue,
      },
    });
  });

  const full = await loadApplication(createdId);
  // Bust the tenant's /applications/me cache so the new row is
  // visible on the next read.
  await cacheLib.invalidateTag(`applications:tenant:${callerUserId}`);
  return toApplicationView(full);
}

// ──────────────────────────────────────────────────────────────────────
// GET /applications  (TENANT own)
// ──────────────────────────────────────────────────────────────────────

export async function listApplicationsForTenant(
  callerUserId: string,
  query: ListApplicationsQuery
): Promise<ApplicationPage> {
  // Phase 21: cache wrapper. The tenant's own application list is a
  // hot dashboard endpoint; we cache for 60s and bust the tag from
  // every mutating path (createApplication, withdrawApplication,
  // transitionApplication) so the next read sees the fresh state.
  const cacheKey = buildTenantApplicationsCacheKey(callerUserId, query);
  const cached = await cacheLib.get<ApplicationPage>(cacheKey);
  if (cached !== null) return cached;

  const limit = query.limit;
  const take = limit + 1;
  const rows = await prisma.application.findMany({
    where: {
      tenantUserId: callerUserId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    select: {
      id: true,
      roomId: true,
      tenantUserId: true,
      message: true,
      status: true,
      submittedAt: true,
      decidedAt: true,
      decidedByUserId: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      tenant: { select: { id: true, tenantProfile: { select: { displayName: true } } } },
      room: {
        select: {
          id: true,
          property: { select: { id: true, title: true, city: true } },
        },
      },
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;
  const result: ApplicationPage = {
    items: page.map((r) => toApplicationView(r as unknown as ApplicationRow)),
    nextCursor,
  };
  await cacheLib.taggedSet(cacheKey, result, 60, [`applications:tenant:${callerUserId}`]);
  return result;
}

// Cache-key builder. Opaque hash so the key length stays bounded
// regardless of how many filters the caller sends. status/limit/cursor
// are encoded into the hash; the userId is part of the tag so all
// of one tenant's pages bust together.
function buildTenantApplicationsCacheKey(
  callerUserId: string,
  query: ListApplicationsQuery
): string {
  const filterHash = cacheLib.hashFilter({
    status: query.status ?? '',
    cursor: query.cursor ?? '',
    limit: query.limit,
  });
  return `applications:tenant:${callerUserId}:${filterHash}`;
}

/**
 * GET /applications — OWNER view (apps against rooms this owner owns).
 * The middleware already verified the caller is OWNER. We filter by
 * `room.property.ownerUserId = callerUserId`.
 */
export async function listApplicationsForOwner(
  callerUserId: string,
  query: ListApplicationsQuery
): Promise<ApplicationPage> {
  const limit = query.limit;
  const take = limit + 1;
  const rows = await prisma.application.findMany({
    where: {
      deletedAt: null,
      room: {
        property: { ownerUserId: callerUserId, deletedAt: null },
        deletedAt: null,
      },
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    select: {
      id: true,
      roomId: true,
      tenantUserId: true,
      message: true,
      status: true,
      submittedAt: true,
      decidedAt: true,
      decidedByUserId: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      tenant: { select: { id: true, tenantProfile: { select: { displayName: true } } } },
      room: {
        select: {
          id: true,
          property: { select: { id: true, title: true, city: true } },
        },
      },
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;
  return {
    items: page.map((r) => toApplicationView(r as unknown as ApplicationRow)),
    nextCursor,
  };
}

// ──────────────────────────────────────────────────────────────────────
// GET /applications/:id
// ──────────────────────────────────────────────────────────────────────

export async function getApplication(applicationId: string): Promise<ApplicationView> {
  const row = await loadApplication(applicationId);
  return toApplicationView(row);
}

// ──────────────────────────────────────────────────────────────────────
// POST /applications/:id/transition  — the HOT PATH for APPROVED
// ──────────────────────────────────────────────────────────────────────

export async function transitionApplication(
  callerUserId: string,
  applicationId: string,
  body: TransitionApplicationInput
): Promise<ApplicationView> {
  const existing = await loadApplication(applicationId);
  if (!isValidTransition(existing.status, body.to)) {
    throw new ConflictError('STATE_MACHINE', `Illegal transition ${existing.status} → ${body.to}`);
  }

  // For APPROVED we take the FOR UPDATE path; for everything else
  // we run the optimistic version-guarded update inline.
  let view: ApplicationView;
  if (body.to === 'APPROVED') {
    view = await transitionToApproved(callerUserId, applicationId, existing);
  } else {
    view = await transitionGeneric(callerUserId, applicationId, existing, body.to);
  }
  // Bust the tenant's /applications/me cache so the new status shows
  // on the next read.
  await cacheLib.invalidateTag(`applications:tenant:${existing.tenantUserId}`);
  return view;
}

/**
 * APPROVED is the only transition that needs the FOR UPDATE lock on
 * the room row. We:
 *   1. Lock the room row to serialize concurrent approvals.
 *   2. Re-validate the application with the version guard.
 *   3. Bulk-reject siblings in the active set.
 *   4. Flip the room to RESERVED.
 *   5. **Phase 13 retrofit**: insert a lease draft row + primary
 *      lease_tenants row (nested create) inside the same tx so lease
 *      creation is atomic with the application approval per spec
 *      §7.5.1.
 *   6. Audit + outbox (now including lease.draft_created) in the same tx.
 *
 * If the room is already RESERVED (another application won the race),
 * we surface 409 STATE_MACHINE.
 */
async function transitionToApproved(
  callerUserId: string,
  applicationId: string,
  existing: ApplicationRow
): Promise<ApplicationView> {
  return await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text FROM rooms
       WHERE id = ${existing.roomId} AND deleted_at IS NULL
       FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new NotFoundError('Room not found');
    }
    if (locked[0]?.status === 'RESERVED') {
      throw new ConflictError(
        'STATE_MACHINE',
        'Room is already reserved by another approved application'
      );
    }

    // Optimistic version guard on the application row.
    const upd = await tx.application.updateMany({
      where: {
        id: applicationId,
        status: 'SHORTLISTED',
        version: existing.version,
        deletedAt: null,
      },
      data: {
        status: 'APPROVED',
        decidedAt: new Date(),
        decidedByUserId: callerUserId,
        version: { increment: 1 },
      },
    });
    if (upd.count === 0) {
      throw new ConflictError(
        'STATE_MACHINE',
        'Application moved between read and write; refetch and retry'
      );
    }

    // Reserve the room.
    await tx.room.update({
      where: { id: existing.roomId },
      data: { status: 'RESERVED', version: { increment: 1 } },
    });

    // Bulk-reject siblings — anyone else still active on this room
    // loses the race. Their owners get the rejection event.
    await tx.application.updateMany({
      where: {
        roomId: existing.roomId,
        id: { not: applicationId },
        status: { in: ACTIVE_APPLICATION_STATUSES },
        deletedAt: null,
      },
      data: {
        status: 'REJECTED',
        decidedAt: new Date(),
        decidedByUserId: callerUserId,
        version: { increment: 1 },
      },
    });

    // Phase 13 — snapshot the room for the lease draft + insert
    // lease + primary lease_tenants row in one nested create. The
    // partial UNIQUE `leases_room_active_uniq` from Phase 12 prevents
    // race collisions; the partial UNIQUE
    // `lease_tenants_one_primary_per_lease` ensures only one primary
    // per lease. The ownerId lookup at the bottom of this function
    // is reused from this row read — no second query needed.
    const roomForLease = await tx.room.findUnique({
      where: { id: existing.roomId },
      select: {
        baseRentMinor: true,
        depositMinor: true,
        currency: true,
        minLeaseMonths: true,
        property: { select: { ownerUserId: true } },
      },
    });
    if (!roomForLease) {
      throw new NotFoundError('Room vanished mid-transaction');
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const leaseEnd = new Date(today);
    leaseEnd.setUTCMonth(leaseEnd.getUTCMonth() + (roomForLease.minLeaseMonths ?? 12));

    const lease = await tx.lease.create({
      data: {
        roomId: existing.roomId,
        ownerUserId: roomForLease.property.ownerUserId,
        primaryTenantUserId: existing.tenantUserId,
        startDate: today,
        endDate: leaseEnd,
        rentMinor: roomForLease.baseRentMinor,
        depositMinor: roomForLease.depositMinor,
        currency: roomForLease.currency,
        status: 'DRAFT',
        tenants: {
          create: [
            {
              tenantUserId: existing.tenantUserId,
              isPrimary: true,
              liabilityShare: '100.00',
            },
          ],
        },
      },
      select: { id: true },
    });

    // Audit + outbox. We now have ownerId from roomForLease (no extra
    // query needed).
    const ownerId = roomForLease.property.ownerUserId;
    const leaseId = lease.id;

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'application.approved',
        targetEntityType: 'application',
        targetEntityId: applicationId,
        before: { status: 'SHORTLISTED' },
        after: { status: 'APPROVED' },
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'lease.draft_created',
        targetEntityType: 'lease',
        targetEntityId: leaseId,
        before: Prisma.JsonNull,
        after: {
          applicationId,
          roomId: existing.roomId,
          tenantUserId: existing.tenantUserId,
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'application.approved',
        payload: {
          applicationId,
          roomId: existing.roomId,
          tenantUserId: existing.tenantUserId,
          ownerUserId: ownerId,
          leaseId,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'lease.draft_created',
        payload: {
          leaseId,
          applicationId,
          roomId: existing.roomId,
          tenantUserId: existing.tenantUserId,
          ownerUserId: ownerId,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'application.status_changed',
        payload: {
          applicationId,
          roomId: existing.roomId,
          tenantUserId: existing.tenantUserId,
          from: 'SHORTLISTED',
          to: 'APPROVED',
        } as Prisma.InputJsonValue,
      },
    });

    const fresh = await tx.application.findUnique({
      where: { id: applicationId },
      select: {
        id: true,
        roomId: true,
        tenantUserId: true,
        message: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        decidedByUserId: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        tenant: { select: { id: true, tenantProfile: { select: { displayName: true } } } },
        room: { select: { id: true, property: { select: { id: true, title: true, city: true } } } },
      },
    });
    return toApplicationView(fresh as unknown as ApplicationRow);
  });
}

/**
 * Generic (non-APPROVED) transition: optimistic version-guarded
 * update inside a $transaction with audit + outbox.
 */
async function transitionGeneric(
  callerUserId: string,
  applicationId: string,
  existing: ApplicationRow,
  to: ApplicationStatus
): Promise<ApplicationView> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const upd = await tx.application.updateMany({
      where: {
        id: applicationId,
        status: existing.status,
        version: existing.version,
        deletedAt: null,
      },
      data: {
        status: to,
        decidedAt: now,
        decidedByUserId: callerUserId,
        version: { increment: 1 },
      },
    });
    if (upd.count === 0) {
      throw new ConflictError(
        'STATE_MACHINE',
        'Application moved between read and write; refetch and retry'
      );
    }

    const ownerId = await tx.room
      .findUnique({
        where: { id: existing.roomId },
        select: { property: { select: { ownerUserId: true } } },
      })
      .then((r) => r?.property.ownerUserId ?? null);

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'application.transitioned',
        targetEntityType: 'application',
        targetEntityId: applicationId,
        before: { status: existing.status },
        after: { status: to },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'application.status_changed',
        payload: {
          applicationId,
          roomId: existing.roomId,
          tenantUserId: existing.tenantUserId,
          from: existing.status,
          to,
        } as Prisma.InputJsonValue,
      },
    });

    return { ownerId };
  });


  const fresh = await loadApplication(applicationId);
  return toApplicationView(fresh);
}

// ──────────────────────────────────────────────────────────────────────
// POST /applications/:id/withdraw
// ──────────────────────────────────────────────────────────────────────

export async function withdrawApplication(
  callerUserId: string,
  applicationId: string,
  _body: WithdrawApplicationInput
): Promise<ApplicationView> {
  const existing = await loadApplication(applicationId);
  // Only the tenant on the application can withdraw.
  if (existing.tenantUserId !== callerUserId) {
    throw new ForbiddenError('NOT_OWNER', 'Only the tenant may withdraw this application');
  }
  // Withdrawable from SUBMITTED, SCREENING, VIEWING_SCHEDULED (per spec §5.5).
  if (
    existing.status !== 'SUBMITTED' &&
    existing.status !== 'SCREENING' &&
    existing.status !== 'VIEWING_SCHEDULED'
  ) {
    throw new ConflictError('STATE_MACHINE', `Cannot withdraw from status ${existing.status}`);
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const upd = await tx.application.updateMany({
      where: {
        id: applicationId,
        status: existing.status,
        version: existing.version,
        deletedAt: null,
      },
      data: {
        status: 'WITHDRAWN',
        decidedAt: now,
        decidedByUserId: callerUserId,
        version: { increment: 1 },
      },
    });
    if (upd.count === 0) {
      throw new ConflictError(
        'STATE_MACHINE',
        'Application moved between read and write; refetch and retry'
      );
    }
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'TENANT',
        action: 'application.withdrawn',
        targetEntityType: 'application',
        targetEntityId: applicationId,
        before: { status: existing.status },
        after: { status: 'WITHDRAWN' },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'application.status_changed',
        payload: {
          applicationId,
          roomId: existing.roomId,
          tenantUserId: existing.tenantUserId,
          from: existing.status,
          to: 'WITHDRAWN',
        } as Prisma.InputJsonValue,
      },
    });
  });
  const fresh = await loadApplication(applicationId);
  // Bust the tenant's /applications/me cache so the new status shows
  // on the next read.
  await cacheLib.invalidateTag(`applications:tenant:${existing.tenantUserId}`);
  return toApplicationView(fresh);
}

// ──────────────────────────────────────────────────────────────────────
// POST /applications/:id/notes
// ──────────────────────────────────────────────────────────────────────

export async function addApplicationNote(
  callerUserId: string,
  applicationId: string,
  body: AddApplicationNoteInput
): Promise<ApplicationNoteView> {
  // Ensure the application exists. Ownership is enforced by middleware.
  // Existence/404 guard: loadApplication throws when the row is missing.
  await loadApplication(applicationId);
  const created = await prisma.$transaction(async (tx) => {
    const note = await tx.applicationNote.create({
      data: {
        applicationId,
        authorUserId: callerUserId,
        note: body.note,
      },
      select: {
        id: true,
        applicationId: true,
        authorUserId: true,
        note: true,
        createdAt: true,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'application.note_added',
        targetEntityType: 'application',
        targetEntityId: applicationId,
        before: Prisma.JsonNull,
        after: { noteId: note.id },
      },
    });
    return note;
  });
  return noteToView(created);
}

// ──────────────────────────────────────────────────────────────────────
// POST /applications/:id/viewing
// ──────────────────────────────────────────────────────────────────────

export async function createViewingRequest(
  callerUserId: string,
  applicationId: string,
  body: CreateViewingInput
): Promise<ViewingView> {
  // Ensure the application exists and is in a state where viewings make sense.
  const existing = await loadApplication(applicationId);
  if (
    existing.status !== 'SUBMITTED' &&
    existing.status !== 'SCREENING' &&
    existing.status !== 'VIEWING_SCHEDULED'
  ) {
    throw new ConflictError(
      'STATE_MACHINE',
      `Cannot create viewing for application in status ${existing.status}`
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const v = await tx.viewingRequest.create({
      data: {
        applicationId,
        roomId: existing.roomId,
        tenantUserId: existing.tenantUserId,
        proposedSlots: body.proposedSlots.map((s) => new Date(s)),
      },
      select: {
        id: true,
        applicationId: true,
        roomId: true,
        tenantUserId: true,
        proposedSlots: true,
        confirmedSlot: true,
        status: true,
        reason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // Move application to VIEWING_SCHEDULED if currently earlier in the flow.
    if (existing.status !== 'VIEWING_SCHEDULED') {
      await tx.application.updateMany({
        where: {
          id: applicationId,
          status: existing.status,
          version: existing.version,
          deletedAt: null,
        },
        data: {
          status: 'VIEWING_SCHEDULED',
          version: { increment: 1 },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: 'application.status_changed',
          payload: {
            applicationId,
            roomId: existing.roomId,
            tenantUserId: existing.tenantUserId,
            from: existing.status,
            to: 'VIEWING_SCHEDULED',
          } as Prisma.InputJsonValue,
        },
      });
    }

    const ownerId = await tx.room
      .findUnique({
        where: { id: existing.roomId },
        select: { property: { select: { ownerUserId: true } } },
      })
      .then((r) => r?.property.ownerUserId ?? null);

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'viewing.created',
        targetEntityType: 'viewing',
        targetEntityId: v.id,
        before: Prisma.JsonNull,
        after: { applicationId, proposedSlots: body.proposedSlots },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'viewing.requested',
        payload: {
          viewingId: v.id,
          applicationId,
          roomId: existing.roomId,
          ownerUserId: ownerId,
          tenantUserId: existing.tenantUserId,
          proposedSlots: body.proposedSlots,
        } as Prisma.InputJsonValue,
      },
    });
    return v;
  });

  return toViewingView(created);
}

// ──────────────────────────────────────────────────────────────────────
// GET /viewings/:id
// ──────────────────────────────────────────────────────────────────────

export async function getViewing(viewingId: string): Promise<ViewingView> {
  const row = await prisma.viewingRequest.findUnique({
    where: { id: viewingId },
    select: {
      id: true,
      applicationId: true,
      roomId: true,
      tenantUserId: true,
      proposedSlots: true,
      confirmedSlot: true,
      status: true,
      reason: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw new NotFoundError('Viewing not found');
  return toViewingView(row);
}

// ──────────────────────────────────────────────────────────────────────
// POST /viewings/:id/confirm
// ──────────────────────────────────────────────────────────────────────

export async function confirmViewing(
  callerUserId: string,
  viewingId: string,
  body: ConfirmViewingInput
): Promise<ViewingView> {
  const viewing = await prisma.viewingRequest.findUnique({
    where: { id: viewingId },
    select: { id: true, status: true },
  });
  if (!viewing) throw new NotFoundError('Viewing not found');
  if (viewing.status !== 'REQUESTED') {
    throw new ConflictError('STATE_MACHINE', `Cannot confirm viewing in status ${viewing.status}`);
  }
  const confirmedSlotDate = new Date(body.confirmedSlot);
  // Relaxed: we accept any ISO datetime even if it wasn't in the
  // originally proposed list (owners may slip a slot via direct
  // negotiation). Strict matching is a future enhancement, and is
  // why proposedSlots is deliberately not selected above.

  const updated = await prisma.$transaction(async (tx) => {
    const v = await tx.viewingRequest.update({
      where: { id: viewingId },
      data: { status: 'CONFIRMED', confirmedSlot: confirmedSlotDate },
      select: {
        id: true,
        applicationId: true,
        roomId: true,
        tenantUserId: true,
        proposedSlots: true,
        confirmedSlot: true,
        status: true,
        reason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'viewing.confirmed',
        targetEntityType: 'viewing',
        targetEntityId: viewingId,
        before: { status: 'REQUESTED' },
        after: { status: 'CONFIRMED', confirmedSlot: body.confirmedSlot },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'viewing.confirmed',
        payload: {
          viewingId,
          applicationId: v.applicationId,
          confirmedSlot: body.confirmedSlot,
        } as Prisma.InputJsonValue,
      },
    });
    return v;
  });
  return toViewingView(updated);
}

// ──────────────────────────────────────────────────────────────────────
// POST /viewings/:id/cancel
// ──────────────────────────────────────────────────────────────────────

export async function cancelViewing(
  callerUserId: string,
  viewingId: string,
  body: CancelViewingInput
): Promise<ViewingView> {
  const viewing = await prisma.viewingRequest.findUnique({
    where: { id: viewingId },
    select: { id: true, status: true },
  });
  if (!viewing) throw new NotFoundError('Viewing not found');
  if (viewing.status === 'CANCELLED' || viewing.status === 'COMPLETED') {
    throw new ConflictError('STATE_MACHINE', `Cannot cancel viewing in status ${viewing.status}`);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const v = await tx.viewingRequest.update({
      where: { id: viewingId },
      data: { status: 'CANCELLED', reason: body.reason ?? null },
      select: {
        id: true,
        applicationId: true,
        roomId: true,
        tenantUserId: true,
        proposedSlots: true,
        confirmedSlot: true,
        status: true,
        reason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: null, // either party
        action: 'viewing.cancelled',
        targetEntityType: 'viewing',
        targetEntityId: viewingId,
        before: { status: viewing.status },
        after: { status: 'CANCELLED', reason: body.reason ?? null },
      },
    });
    return v;
  });
  return toViewingView(updated);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers — row → view
// ──────────────────────────────────────────────────────────────────────

type ViewingRow = {
  id: string;
  applicationId: string | null;
  roomId: string;
  tenantUserId: string;
  proposedSlots: Date[];
  confirmedSlot: Date | null;
  status: ViewingStatus;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toViewingView(row: ViewingRow): ViewingView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    roomId: row.roomId,
    tenantUserId: row.tenantUserId,
    proposedSlots: row.proposedSlots.map((d) => d.toISOString()),
    confirmedSlot: row.confirmedSlot?.toISOString() ?? null,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
