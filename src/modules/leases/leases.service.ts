// src/modules/leases/leases.service.ts
//
// Business logic for /api/v1/leases per spec §13.2.5, §7.5.1, §7.5.2.
//
// Hot paths (all guarded by `prisma.$transaction`):
// - signLease: insert lease_signature row, flip DRAFT → SIGNED
// only when every required party has signed.
// Idempotent per party via UNIQUE(lease_id, signer_user_id).
// - confirmMoveIn: SELECT ... FOR UPDATE on rooms row + optimistic
// version-guarded lease update + room → OCCUPIED.
// - terminateLease: SELECT ... FOR UPDATE on rooms row + optimistic
// version-guarded lease update + room → MAINTENANCE_CHECK
// (per MoveOut saga §7.5.2).
//
// All transitions emit audit rows in the same tx (pattern
// from Phase 12 applications.service.ts).

import { Prisma } from '@/generated/prisma/client';
import type {
  LeaseAmendmentStatus,
  LeasePartyRole,
  LeaseStatus,
} from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';

import type {
  ConfirmMoveInInput,
  ProposeAmendmentInput,
  SignAmendmentInput,
  SignLeaseInput,
  TerminateLeaseInput,
} from './leases.schemas';
import { isValidLeaseTransition } from './leases.state-machine';

// ──────────────────────────────────────────────────────────────────────
// Views (render-ready DTOs)
// ──────────────────────────────────────────────────────────────────────

export interface LeaseSignatureView {
  id: string;
  leaseId: string;
  signerUserId: string;
  signerRole: LeasePartyRole;
  signedAt: string;
}

export interface LeaseTenantView {
  leaseId: string;
  tenantUserId: string;
  isPrimary: boolean;
  liabilityShare: string;
  createdAt: string;
}

export interface LeaseView {
  id: string;
  roomId: string;
  ownerUserId: string;
  primaryTenantUserId: string;
  startDate: string;
  endDate: string;
  rentMinor: string;
  depositMinor: string;
  currency: string;
  utilitySplitMode: string;
  status: LeaseStatus;
  signedAt: string | null;
  activatedAt: string | null;
  endedAt: string | null;
  contractObjectKey: string | null;
  createdAt: string;
  updatedAt: string;
  tenants: LeaseTenantView[];
  signatures: LeaseSignatureView[];
}

export interface LeaseSummaryView {
  id: string;
  roomId: string;
  status: LeaseStatus;
  startDate: string;
  endDate: string;
  rentMinor: string;
  depositMinor: string;
  currency: string;
  role: 'OWNER' | 'TENANT';
  isPrimary: boolean;
  createdAt: string;
}

export interface LeasePage {
  items: LeaseSummaryView[];
  nextCursor: string | null;
}

export interface LeaseDocumentView {
  url: string;
  expiresAt: string;
}

export interface LeaseAmendmentView {
  id: string;
  leaseId: string;
  proposedByUserId: string;
  status: LeaseAmendmentStatus;
  payload: Prisma.JsonValue;
  createdAt: string;
  signedAt: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

type LeaseRow = {
  id: string;
  roomId: string;
  ownerUserId: string;
  primaryTenantUserId: string;
  startDate: Date;
  endDate: Date;
  rentMinor: bigint;
  depositMinor: bigint;
  currency: string;
  utilitySplitMode: string;
  status: LeaseStatus;
  signedAt: Date | null;
  activatedAt: Date | null;
  endedAt: Date | null;
  contractObjectKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type LeaseTenantRow = {
  leaseId: string;
  tenantUserId: string;
  isPrimary: boolean;
  liabilityShare: Prisma.Decimal | number | string;
  createdAt: Date;
};

type LeaseSignatureRow = {
  id: string;
  leaseId: string;
  signerUserId: string;
  signerRole: LeasePartyRole;
  signedAt: Date;
};

function tenantRowToView(r: LeaseTenantRow): LeaseTenantView {
  return {
    leaseId: r.leaseId,
    tenantUserId: r.tenantUserId,
    isPrimary: r.isPrimary,
    liabilityShare: String(r.liabilityShare),
    createdAt: r.createdAt.toISOString(),
  };
}

function signatureRowToView(r: LeaseSignatureRow): LeaseSignatureView {
  return {
    id: r.id,
    leaseId: r.leaseId,
    signerUserId: r.signerUserId,
    signerRole: r.signerRole,
    signedAt: r.signedAt.toISOString(),
  };
}

function leaseRowToView(
  row: LeaseRow,
  tenants: LeaseTenantRow[],
  signatures: LeaseSignatureRow[]
): LeaseView {
  return {
    id: row.id,
    roomId: row.roomId,
    ownerUserId: row.ownerUserId,
    primaryTenantUserId: row.primaryTenantUserId,
    startDate: row.startDate.toISOString(),
    endDate: row.endDate.toISOString(),
    rentMinor: row.rentMinor.toString(),
    depositMinor: row.depositMinor.toString(),
    currency: row.currency,
    utilitySplitMode: row.utilitySplitMode,
    status: row.status,
    signedAt: row.signedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    contractObjectKey: row.contractObjectKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    tenants: tenants.map(tenantRowToView),
    signatures: signatures.map(signatureRowToView),
  };
}

async function loadLease(id: string): Promise<{
  row: LeaseRow;
  tenants: LeaseTenantRow[];
  signatures: LeaseSignatureRow[];
}> {
  const row = await prisma.lease.findUnique({
    where: { id },
    select: {
      id: true,
      roomId: true,
      ownerUserId: true,
      primaryTenantUserId: true,
      startDate: true,
      endDate: true,
      rentMinor: true,
      depositMinor: true,
      currency: true,
      utilitySplitMode: true,
      status: true,
      signedAt: true,
      activatedAt: true,
      endedAt: true,
      contractObjectKey: true,
      createdAt: true,
      updatedAt: true,
      tenants: {
        select: {
          leaseId: true,
          tenantUserId: true,
          isPrimary: true,
          liabilityShare: true,
          createdAt: true,
        },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      },
      signatures: {
        select: {
          id: true,
          leaseId: true,
          signerUserId: true,
          signerRole: true,
          signedAt: true,
        },
        orderBy: { signedAt: 'asc' },
      },
    },
  });
  if (!row) throw new NotFoundError('Lease not found');
  return {
    row: row as unknown as LeaseRow,
    tenants: row.tenants as unknown as LeaseTenantRow[],
    signatures: row.signatures as unknown as LeaseSignatureRow[],
  };
}

// ──────────────────────────────────────────────────────────────────────
// resolvePartiesForLease
// ──────────────────────────────────────────────────────────────────────

/**
 * Single-row lookup used by `requireLeaseParty` middleware to decide
 * whether the caller is allowed to access the lease. Returns
 * `null` for ownerId and `[]` for tenantIds when the lease doesn't
 * exist (so the middleware can 404 without leaking existence).
 */
export async function resolvePartiesForLease(leaseId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
  primaryTenantId: string | null;
}> {
  const row = await prisma.lease.findUnique({
    where: { id: leaseId },
    select: {
      ownerUserId: true,
      primaryTenantUserId: true,
      tenants: { select: { tenantUserId: true } },
    },
  });
  if (!row) return { ownerId: null, tenantIds: [], primaryTenantId: null };
  return {
    ownerId: row.ownerUserId,
    tenantIds: row.tenants.map((t) => t.tenantUserId),
    primaryTenantId: row.primaryTenantUserId,
  };
}

// ──────────────────────────────────────────────────────────────────────
// GET /leases/me — caller sees own (owner OR tenant party)
// ──────────────────────────────────────────────────────────────────────

export async function listLeasesForCaller(
  callerUserId: string,
  limit: number
): Promise<LeasePage> {
  const take = limit + 1;
  const rows = await prisma.lease.findMany({
    where: {
      OR: [
        { ownerUserId: callerUserId },
        { tenants: { some: { tenantUserId: callerUserId } } },
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      roomId: true,
      status: true,
      startDate: true,
      endDate: true,
      rentMinor: true,
      depositMinor: true,
      currency: true,
      createdAt: true,
      ownerUserId: true,
      tenants: {
        where: { tenantUserId: callerUserId },
        select: { isPrimary: true },
        take: 1,
      },
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: LeaseSummaryView[] = page.map((r) => {
    const tenantRow = r.tenants[0];
    const role: 'OWNER' | 'TENANT' = r.ownerUserId === callerUserId ? 'OWNER' : 'TENANT';
    return {
      id: r.id,
      roomId: r.roomId,
      status: r.status,
      startDate: r.startDate.toISOString(),
      endDate: r.endDate.toISOString(),
      rentMinor: r.rentMinor.toString(),
      depositMinor: r.depositMinor.toString(),
      currency: r.currency,
      role,
      isPrimary: role === 'TENANT' ? (tenantRow?.isPrimary ?? false) : false,
      createdAt: r.createdAt.toISOString(),
    };
  });
  const nextCursor = hasMore && items.length > 0 ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

// ──────────────────────────────────────────────────────────────────────
// GET /leases/:id
// ──────────────────────────────────────────────────────────────────────

export async function getLease(leaseId: string): Promise<LeaseView> {
  const { row, tenants, signatures } = await loadLease(leaseId);
  return leaseRowToView(row, tenants, signatures);
}

// ──────────────────────────────────────────────────────────────────────
// POST /leases/:id/sign
// ──────────────────────────────────────────────────────────────────────

/**
 * Multi-party signing. Algorithm:
 *   1. Load lease + its tenants; require caller is OWNER or a TENANT party.
 *   2. Require lease.status === DRAFT.
 *   3. Idempotently insert a lease_signature row (UNIQUE constraint).
 *   4. Recompute "have all required parties signed?" — required set is
 *      { ownerUserId } ∪ { every tenant in lease_tenants }.
 *   5. If all signed, flip lease → SIGNED + set signedAt.
 *   6. Emit lease.signed (only when the transition fires) + lease.status_changed
 *      + audit row.
 */
export async function signLease(
  callerUserId: string,
  leaseId: string,
  _body: SignLeaseInput,
  context: { ipAddress: string | null; userAgent: string | null }
): Promise<LeaseView> {
  return await prisma.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        status: true,
        signedAt: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Lease not found');
    if (lease.status !== 'DRAFT') {
      throw new ConflictError('STATE_MACHINE', `Cannot sign lease in status ${lease.status}`);
    }
    // Caller must be a party.
    const isOwner = lease.ownerUserId === callerUserId;
    const isTenant = lease.tenants.some((t) => t.tenantUserId === callerUserId);
    if (!isOwner && !isTenant) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this lease');
    }

    // Idempotent signature insert — UNIQUE(leaseId, signerUserId) means
    // a duplicate insert fails, so we first check. The schema constraint
    // is the source of truth; this lookup is a soft check for the
    // existing-row branch.
    const existing = await tx.leaseSignature.findUnique({
      where: {
        lease_signatures_lease_signer_uq: { leaseId, signerUserId: callerUserId },
      },
      select: { id: true, signedAt: true, signerRole: true },
    });
    let insertedNow = false;
    if (!existing) {
      try {
        await tx.leaseSignature.create({
          data: {
            leaseId,
            signerUserId: callerUserId,
            signerRole: isOwner ? 'OWNER' : 'TENANT',
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
          },
          select: { id: true, signedAt: true },
        });
        insertedNow = true;
      } catch (e) {
        // P2002 from the UNIQUE(leaseId, signerUserId) constraint means
        // a concurrent signer inserted in between the check above and
        // this point. Treat as idempotent — the row we lost the race
        // to is the canonical signature.
        if ((e as { code?: string }).code !== 'P2002') {
          throw e;
        }
      }
    }

    // Recompute "all parties signed".
    // Required = { ownerUserId } ∪ { every tenant in lease_tenants }.
    // We need every required signer to be present in signedRows.
    const signedRows = await tx.leaseSignature.findMany({
      where: { leaseId },
      select: { signerUserId: true, signerRole: true, signedAt: true },
      orderBy: { signedAt: 'asc' },
    });
    const required = new Set<string>([lease.ownerUserId, ...lease.tenants.map((t) => t.tenantUserId)]);
    const signed = new Set<string>(signedRows.map((s) => s.signerUserId));
    // "All signed" iff every required party has signed (set difference is empty).
    const allSigned = [...required].every((userId) => signed.has(userId));

    let statusChanged = false;
    if (allSigned) {
      const upd = await tx.lease.updateMany({
        where: { id: leaseId, status: 'DRAFT' },
        data: { status: 'SIGNED', signedAt: new Date() },
      });
      statusChanged = upd.count > 0;
    }

    if (statusChanged) {
      await tx.auditLog.create({
        data: {
          actorUserId: callerUserId,
          actorRole: isOwner ? 'OWNER' : 'TENANT',
          action: 'lease.signed',
          targetEntityType: 'lease',
          targetEntityId: leaseId,
          before: { status: 'DRAFT' },
          after: {
            status: 'SIGNED',
            signers: signedRows.map((s) => ({
              userId: s.signerUserId,
              role: s.signerRole,
              signedAt: s.signedAt.toISOString(),
            })),
          },
        },
      });
      
      
    } else if (insertedNow) {
      // Partial signing — record the individual signature event but no
      // status change yet. Useful for downstream "X signed" notifications.
      
    }

    // Re-load lease for the view.
    const reloaded = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        roomId: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        startDate: true,
        endDate: true,
        rentMinor: true,
        depositMinor: true,
        currency: true,
        utilitySplitMode: true,
        status: true,
        signedAt: true,
        activatedAt: true,
        endedAt: true,
        contractObjectKey: true,
        createdAt: true,
        updatedAt: true,
        tenants: {
          select: {
            leaseId: true,
            tenantUserId: true,
            isPrimary: true,
            liabilityShare: true,
            createdAt: true,
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        signatures: {
          select: {
            id: true,
            leaseId: true,
            signerUserId: true,
            signerRole: true,
            signedAt: true,
          },
          orderBy: { signedAt: 'asc' },
        },
      },
    });
    if (!reloaded) throw new NotFoundError('Lease not found after sign');
    return leaseRowToView(
      reloaded as unknown as LeaseRow,
      reloaded.tenants as unknown as LeaseTenantRow[],
      reloaded.signatures as unknown as LeaseSignatureRow[]
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /leases/:id/confirm-move-in
// ──────────────────────────────────────────────────────────────────────

/**
 * SIGNED → ACTIVE. The tenant confirms they have moved in; we flip
 * the room to OCCUPIED per spec §7.5.1.
 *
 * Concurrency:
 *   - SELECT ... FOR UPDATE on the room row blocks competing
 *     confirm-move-in / terminate calls until commit.
 *   - Optimistic version guard on the lease catches a refetch race.
 */
export async function confirmMoveIn(
  callerUserId: string,
  leaseId: string,
  _body: ConfirmMoveInInput
): Promise<LeaseView> {
  return await prisma.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        roomId: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        status: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Lease not found');
    if (!isValidLeaseTransition(lease.status, 'ACTIVE')) {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot confirm move-in from status ${lease.status}`
      );
    }
    // Caller must be a tenant party.
    const isTenant = lease.tenants.some((t) => t.tenantUserId === callerUserId);
    if (!isTenant) {
      throw new ForbiddenError('NOT_OWNER', 'Only a tenant party may confirm move-in');
    }

    // Lock the room row to serialize concurrent confirm / terminate.
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text FROM rooms WHERE id = ${lease.roomId} AND deleted_at IS NULL FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Room not found');
    if (locked[0]?.status === 'OCCUPIED') {
      throw new ConflictError(
        'STATE_MACHINE',
        'Room is already occupied by another active lease'
      );
    }

    const now = new Date();
    const upd = await tx.lease.updateMany({
      where: { id: leaseId, status: 'SIGNED' },
      data: { status: 'ACTIVE', activatedAt: now },
    });
    if (upd.count === 0) {
      throw new ConflictError('STATE_MACHINE', 'Lease moved between read and write; refetch and retry');
    }

    await tx.room.update({
      where: { id: lease.roomId },
      data: { status: 'OCCUPIED', version: { increment: 1 } },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'TENANT',
        action: 'lease.activated',
        targetEntityType: 'lease',
        targetEntityId: leaseId,
        before: { status: 'SIGNED' },
        after: { status: 'ACTIVE', activatedAt: now.toISOString() },
      },
    });
    
    

    const reloaded = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        roomId: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        startDate: true,
        endDate: true,
        rentMinor: true,
        depositMinor: true,
        currency: true,
        utilitySplitMode: true,
        status: true,
        signedAt: true,
        activatedAt: true,
        endedAt: true,
        contractObjectKey: true,
        createdAt: true,
        updatedAt: true,
        tenants: {
          select: {
            leaseId: true,
            tenantUserId: true,
            isPrimary: true,
            liabilityShare: true,
            createdAt: true,
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        signatures: {
          select: {
            id: true,
            leaseId: true,
            signerUserId: true,
            signerRole: true,
            signedAt: true,
          },
          orderBy: { signedAt: 'asc' },
        },
      },
    });
    if (!reloaded) throw new NotFoundError('Lease not found after confirm');
    return leaseRowToView(
      reloaded as unknown as LeaseRow,
      reloaded.tenants as unknown as LeaseTenantRow[],
      reloaded.signatures as unknown as LeaseSignatureRow[]
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /leases/:id/terminate
// ──────────────────────────────────────────────────────────────────────

/**
 * ACTIVE → TERMINATED. Either party may invoke (MoveOut saga §7.5.2).
 * Room flips to MAINTENANCE_CHECK.
 */
export async function terminateLease(
  callerUserId: string,
  leaseId: string,
  body: TerminateLeaseInput
): Promise<LeaseView> {
  return await prisma.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        roomId: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        status: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Lease not found');
    if (lease.status !== 'ACTIVE') {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot terminate lease in status ${lease.status}`
      );
    }
    const isOwner = lease.ownerUserId === callerUserId;
    const isTenant = lease.tenants.some((t) => t.tenantUserId === callerUserId);
    if (!isOwner && !isTenant) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this lease');
    }

    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status::text FROM rooms WHERE id = ${lease.roomId} AND deleted_at IS NULL FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Room not found');

    const now = new Date();
    const upd = await tx.lease.updateMany({
      where: { id: leaseId, status: 'ACTIVE' },
      data: { status: 'TERMINATED', endedAt: now },
    });
    if (upd.count === 0) {
      throw new ConflictError('STATE_MACHINE', 'Lease moved between read and write; refetch and retry');
    }

    await tx.room.update({
      where: { id: lease.roomId },
      data: { status: 'MAINTENANCE_CHECK', version: { increment: 1 } },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: isOwner ? 'OWNER' : 'TENANT',
        action: 'lease.terminated',
        targetEntityType: 'lease',
        targetEntityId: leaseId,
        before: { status: 'ACTIVE' },
        after: { status: 'TERMINATED', endedAt: now.toISOString(), reason: body.reason },
      },
    });
    
    

    const reloaded = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        id: true,
        roomId: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        startDate: true,
        endDate: true,
        rentMinor: true,
        depositMinor: true,
        currency: true,
        utilitySplitMode: true,
        status: true,
        signedAt: true,
        activatedAt: true,
        endedAt: true,
        contractObjectKey: true,
        createdAt: true,
        updatedAt: true,
        tenants: {
          select: {
            leaseId: true,
            tenantUserId: true,
            isPrimary: true,
            liabilityShare: true,
            createdAt: true,
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        signatures: {
          select: {
            id: true,
            leaseId: true,
            signerUserId: true,
            signerRole: true,
            signedAt: true,
          },
          orderBy: { signedAt: 'asc' },
        },
      },
    });
    if (!reloaded) throw new NotFoundError('Lease not found after terminate');
    return leaseRowToView(
      reloaded as unknown as LeaseRow,
      reloaded.tenants as unknown as LeaseTenantRow[],
      reloaded.signatures as unknown as LeaseSignatureRow[]
    );
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /leases/:id/document
// ──────────────────────────────────────────────────────────────────────

/**
 * Phase 13 stub: returns a mock signed-URL pointer. Phase 18 will
 * replace this with a real S3 pre-signed URL. Expiry is 15 minutes
 * per common practice for tenant documents.
 */
export async function getLeaseDocument(leaseId: string): Promise<LeaseDocumentView> {
  // No DB lookup here — the caller already passed requireLeaseParty.
  // Phase 18 will read the contract_object_key from leases and call S3.
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  return {
    url: `mock://signed-url/${leaseId}`,
    expiresAt: expiresAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /leases/:id/amend (Phase 13 stub)
// ──────────────────────────────────────────────────────────────────────

export async function proposeAmendment(
  callerUserId: string,
  leaseId: string,
  body: ProposeAmendmentInput
): Promise<LeaseAmendmentView> {
  return await prisma.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        ownerUserId: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Lease not found');
    const isOwner = lease.ownerUserId === callerUserId;
    const isTenant = lease.tenants.some((t) => t.tenantUserId === callerUserId);
    if (!isOwner && !isTenant) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this lease');
    }

    const amendment = await tx.leaseAmendment.create({
      data: {
        leaseId,
        proposedByUserId: callerUserId,
        status: 'PROPOSED',
        payload: body.payload as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        leaseId: true,
        proposedByUserId: true,
        status: true,
        payload: true,
        createdAt: true,
        signedAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: isOwner ? 'OWNER' : 'TENANT',
        action: 'lease.amendment_proposed',
        targetEntityType: 'lease_amendment',
        targetEntityId: amendment.id,
        before: Prisma.JsonNull,
        after: { leaseId, payload: body.payload as Prisma.JsonValue },
      },
    });
    

    return amendmentToView(amendment);
  });
}

// ──────────────────────────────────────────────────────────────────────
// POST /leases/:id/amendments/:aid/sign (Phase 13 stub)
// ──────────────────────────────────────────────────────────────────────

export async function signAmendment(
  callerUserId: string,
  leaseId: string,
  amendmentId: string,
  _body: SignAmendmentInput
): Promise<LeaseAmendmentView> {
  return await prisma.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: leaseId },
      select: {
        ownerUserId: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Lease not found');
    const isOwner = lease.ownerUserId === callerUserId;
    const isTenant = lease.tenants.some((t) => t.tenantUserId === callerUserId);
    if (!isOwner && !isTenant) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this lease');
    }

    const amendment = await tx.leaseAmendment.findUnique({
      where: { id: amendmentId },
      select: {
        id: true,
        leaseId: true,
        proposedByUserId: true,
        status: true,
        payload: true,
        createdAt: true,
        signedAt: true,
      },
    });
    if (!amendment) throw new NotFoundError('Amendment not found');
    if (amendment.leaseId !== leaseId) {
      throw new NotFoundError('Amendment does not belong to this lease');
    }
    if (amendment.status === 'SIGNED') {
      // Idempotent: return current state.
      return amendmentToView(amendment);
    }
    if (amendment.status === 'REJECTED') {
      throw new ConflictError('STATE_MACHINE', 'Cannot sign a rejected amendment');
    }

    const now = new Date();
    const updated = await tx.leaseAmendment.update({
      where: { id: amendmentId },
      data: { status: 'SIGNED', signedAt: now },
      select: {
        id: true,
        leaseId: true,
        proposedByUserId: true,
        status: true,
        payload: true,
        createdAt: true,
        signedAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: isOwner ? 'OWNER' : 'TENANT',
        action: 'lease.amendment_signed',
        targetEntityType: 'lease_amendment',
        targetEntityId: amendmentId,
        before: { status: 'PROPOSED' },
        after: { status: 'SIGNED', signedAt: now.toISOString() },
      },
    });
    

    return amendmentToView(updated);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (row → view)
// ──────────────────────────────────────────────────────────────────────

type AmendmentRow = {
  id: string;
  leaseId: string;
  proposedByUserId: string;
  status: LeaseAmendmentStatus;
  payload: Prisma.JsonValue;
  createdAt: Date;
  signedAt: Date | null;
};

function amendmentToView(row: AmendmentRow): LeaseAmendmentView {
  return {
    id: row.id,
    leaseId: row.leaseId,
    proposedByUserId: row.proposedByUserId,
    status: row.status,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
    signedAt: row.signedAt?.toISOString() ?? null,
  };
}
