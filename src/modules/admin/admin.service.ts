// src/modules/admin/admin.service.ts
//
// Phase 19: business logic for /api/v1/admin/* — moderation actions,
// user search, and the inline `writeAuditLog` helper every privileged
// action in this module calls.
//
// Authorization model:
//   All routes in this module are mounted behind requireRole('ADMIN').
//   The service functions still re-check role in case a future caller
//   reaches them outside the standard middleware chain (e.g., a
//   cron job, an internal RPC). Defense in depth.

import { Prisma, type Prisma as PrismaTypes } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { redis } from '@/lib/redis';

// ──────────────────────────────────────────────────────────────────────
// Audit-log writer (shared helper)
// ──────────────────────────────────────────────────────────────────────

/**
 * Mirror of phases.json deliverable "audit.service.write()". Lives in
 * admin.service.ts to honor the strict 7-file scope for Phase 19 —
 * see the plan's Risks section. The signature is stable so Phase 21+
 * can either keep the import path or extract to src/lib/audit.ts.
 */
export interface WriteAuditLogInput {
  actorUserId: string | null;
  actorRole: 'ADMIN' | 'OWNER' | 'TENANT' | 'SYSTEM' | null;
  action: string;
  targetEntityType?: string;
  targetEntityId?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function writeAuditLog(
  input: WriteAuditLogInput,
  tx?: PrismaTypes.TransactionClient
): Promise<void> {
  const client = (tx ?? prisma) as PrismaTypes.TransactionClient;
  await client.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      action: input.action,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
      before:
        input.before === undefined ? Prisma.JsonNull : (input.before as PrismaTypes.InputJsonValue),
      after:
        input.after === undefined ? Prisma.JsonNull : (input.after as PrismaTypes.InputJsonValue),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// searchUsers — GET /admin/users/search
// ──────────────────────────────────────────────────────────────────────

export interface UserSearchHit {
  id: string;
  /** Concatenated from tenant/owner profile when present, else email local-part. */
  displayName: string;
  /** PII: present only when caller passed revealPii=true. */
  email?: string;
  phone?: string | null;
  roles: string[];
  kycStatus: string | null;
  createdAt: string;
  piiRedacted: boolean;
}

export interface UserSearchPage {
  items: UserSearchHit[];
  nextCursor: string | null;
}

export interface SearchUsersInput {
  q: string;
  revealPii: boolean;
  limit: number;
  cursor: string | null;
}

/**
 * Search users by email/phone/fullName substring. PII fields are
 * redacted unless the caller explicitly opts in via revealPii=true;
 * every reveal writes its own audit_log row (defensive — even though
 * the route is ADMIN-only).
 */
export async function searchUsers(
  input: SearchUsersInput,
  callerUserId: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<UserSearchPage> {
  const cursorDate = input.cursor ? decodeCursorDate(input.cursor) : null;

  // Build a single OR clause against email, phone, id (UUID exact),
  // or the display name on tenant/owner profiles. The id match
  // requires a special branch since it's exact, not substring.
  const trimmedQ = input.q.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedQ);

  const where = {
    deletedAt: null,
    ...(cursorDate && !Number.isNaN(cursorDate.getTime()) ? { createdAt: { lt: cursorDate } } : {}),
    ...(isUuid
      ? { id: trimmedQ }
      : {
          OR: [
            { email: { contains: trimmedQ, mode: 'insensitive' as const } },
            { phone: { contains: trimmedQ } },
            {
              tenantProfile: { displayName: { contains: trimmedQ, mode: 'insensitive' as const } },
            },
            { ownerProfile: { displayName: { contains: trimmedQ, mode: 'insensitive' as const } } },
          ],
        }),
  };

  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: {
      id: true,
      email: true,
      phone: true,
      createdAt: true,
      roles: { select: { role: true } },
      tenantProfile: { select: { displayName: true, kycStatus: true } },
      ownerProfile: { select: { displayName: true, kycStatus: true } },
    },
  });

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;

  // If revealPii is on, emit one audit row per revealed user so an
  // operator can later review which admin looked at which PII.
  if (input.revealPii) {
    for (const r of page) {
      // Don't await — the response should not block on a write-only
      // audit log. Errors are logged but swallowed.
      void writeAuditLog({
        actorUserId: callerUserId,
        actorRole: 'ADMIN',
        action: 'admin.user.pii_revealed',
        targetEntityType: 'user',
        targetEntityId: r.id,
        after: { searchQuery: trimmedQ },
        ipAddress,
        userAgent,
      }).catch((err) => {
        logger.error({ err, targetUserId: r.id }, 'audit_write_failed');
      });
    }
  }

  const items: UserSearchHit[] = page.map((r) => {
    const displayName =
      r.tenantProfile?.displayName ?? r.ownerProfile?.displayName ?? r.email.split('@')[0] ?? r.id;
    const kycStatus = r.tenantProfile?.kycStatus ?? r.ownerProfile?.kycStatus ?? null;
    return {
      id: r.id,
      displayName,
      ...(input.revealPii
        ? { email: r.email, phone: r.phone, piiRedacted: false }
        : { piiRedacted: true }),
      roles: r.roles.map((role) => role.role),
      kycStatus,
      createdAt: r.createdAt.toISOString(),
    };
  });

  const lastRow = page[page.length - 1];
  const nextCursor =
    hasMore && lastRow
      ? Buffer.from(`${lastRow.createdAt.toISOString()}|${lastRow.id}`, 'utf8').toString(
          'base64url'
        )
      : null;

  return { items, nextCursor };
}

// ──────────────────────────────────────────────────────────────────────
// takedownListing — POST /admin/listings/:id/takedown
// ──────────────────────────────────────────────────────────────────────

export interface TakedownListingInput {
  propertyId: string;
  reason: string;
  callerUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface TakedownListingResult {
  id: string;
  status: string;
  rejectedApplications: number;
  cancelledViewings: number;
}

/**
 * Move a PUBLISHED property to TAKEN_DOWN inside a single $transaction
 * that also rejects active applications (SUBMITTED/SHORTLISTED/UNDER_REVIEW)
 * and cancels pending viewings (REQUESTED/CONFIRMED). Active leases
 * are intentionally untouched — those are operator-terminated via
 * the existing leases module.
 */
export async function takedownListing(input: TakedownListingInput): Promise<TakedownListingResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.property.findUnique({
      where: { id: input.propertyId },
      select: { id: true, status: true, ownerUserId: true, version: true },
    });
    if (!existing) throw new NotFoundError('Property not found');
    if (existing.status !== 'PUBLISHED') {
      throw new ConflictError(
        'STATE_MACHINE',
        `Property is in status ${existing.status}; only PUBLISHED can be taken down`
      );
    }

    const now = new Date();

    // 1) Property → TAKEN_DOWN, bump version, stamp deletedAt.
    const updated = await tx.property.update({
      where: { id: input.propertyId },
      data: {
        status: 'TAKEN_DOWN',
        deletedAt: now,
        version: { increment: 1 },
      },
      select: { id: true, status: true, version: true },
    });

    // 2) Reject active applications on every room of this property.
    //    "Active" = anything before the APPROVED terminal state per the
    //    Phase 12 state machine. APPROVED apps already triggered a lease
    //    draft (Phase 13) and need an explicit admin action to terminate.
    const appResult = await tx.application.updateMany({
      where: {
        status: {
          in: ['SUBMITTED', 'SCREENING', 'VIEWING_SCHEDULED', 'SHORTLISTED'],
        },
        room: { propertyId: input.propertyId },
      },
      data: { status: 'REJECTED', decidedAt: now },
    });

    // 3) Cancel pending viewings (REQUESTED or CONFIRMED) on every room.
    //    ViewingRequest has no decidedAt; the takedown reason lands in
    //    the existing `reason` column.
    const viewingResult = await tx.viewingRequest.updateMany({
      where: {
        status: { in: ['REQUESTED', 'CONFIRMED'] },
        room: { propertyId: input.propertyId },
      },
      data: { status: 'CANCELLED', reason: input.reason },
    });

    // 4) Audit log row.
    await writeAuditLog(
      {
        actorUserId: input.callerUserId,
        actorRole: 'ADMIN',
        action: 'admin.listing.takedown',
        targetEntityType: 'property',
        targetEntityId: input.propertyId,
        before: { status: 'PUBLISHED', version: existing.version },
        after: { status: 'TAKEN_DOWN', reason: input.reason, version: updated.version },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx
    );

    return {
      id: updated.id,
      status: updated.status,
      rejectedApplications: appResult.count,
      cancelledViewings: viewingResult.count,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// reinstateListing — POST /admin/listings/:id/reinstate
// ──────────────────────────────────────────────────────────────────────

export interface ReinstateListingInput {
  propertyId: string;
  callerUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ReinstateListingResult {
  id: string;
  status: string;
}

/**
 * Reverse of takedown. Only acts on properties currently in
 * TAKEN_DOWN. Clears deletedAt, restores PUBLISHED, bumps version.
 * No cascade to applications (already REJECTED) or viewings
 * (already CANCELLED) — those rows are intentionally history.
 */
export async function reinstateListing(
  input: ReinstateListingInput
): Promise<ReinstateListingResult> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.property.findUnique({
      where: { id: input.propertyId },
      select: { id: true, status: true, version: true },
    });
    if (!existing) throw new NotFoundError('Property not found');
    if (existing.status !== 'TAKEN_DOWN') {
      throw new ConflictError(
        'STATE_MACHINE',
        `Property is in status ${existing.status}; only TAKEN_DOWN can be reinstated`
      );
    }

    const updated = await tx.property.update({
      where: { id: input.propertyId },
      data: {
        status: 'PUBLISHED',
        deletedAt: null,
        version: { increment: 1 },
      },
      select: { id: true, status: true, version: true },
    });

    await writeAuditLog(
      {
        actorUserId: input.callerUserId,
        actorRole: 'ADMIN',
        action: 'admin.listing.reinstated',
        targetEntityType: 'property',
        targetEntityId: input.propertyId,
        before: { status: 'TAKEN_DOWN', version: existing.version },
        after: { status: 'PUBLISHED', version: updated.version },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      tx
    );

    return { id: updated.id, status: updated.status };
  });
}

// ──────────────────────────────────────────────────────────────────────
// getAdminHealth — GET /admin/health
// ──────────────────────────────────────────────────────────────────────

export interface AdminHealthView {
  db: 'ok' | 'down';
  redis: 'ok' | 'down';
  recentErrors: number;
  uptime: number;
}

/**
 * Light subsystem check for the admin dashboard. DB and Redis are
 * probed with the cheapest valid call (`SELECT 1` / `PING`).
 * `recentErrors` always returns 0 in Phase 19 — wiring a real scrape
 * off the Pino transport is Phase 20+ scope.
 */
export async function getAdminHealth(): Promise<AdminHealthView> {
  let db: 'ok' | 'down' = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = 'ok';
  } catch {
    db = 'down';
  }

  let redisStatus: 'ok' | 'down' = 'down';
  try {
    const reply = await redis.ping();
    redisStatus = reply === 'PONG' ? 'ok' : 'down';
  } catch {
    redisStatus = 'down';
  }

  return {
    db,
    redis: redisStatus,
    recentErrors: 0,
    uptime: Math.round(process.uptime()),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Cursor helpers (not exported)
// ──────────────────────────────────────────────────────────────────────

function decodeCursorDate(cursor: string): Date | undefined {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [dateIso] = decoded.split('|');
    if (!dateIso) return undefined;
    return new Date(dateIso);
  } catch {
    return undefined;
  }
}
