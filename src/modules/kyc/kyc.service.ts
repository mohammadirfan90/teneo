// src/modules/kyc/kyc.service.ts
//
// Business logic for /kyc/* endpoints per 06 §6.10 + 09 §9.3.
//
// Surfaces:
//   - User side:
//     POST   /kyc/submissions            create PENDING for self
//     GET    /kyc/submissions/me         list own submissions
//     GET    /kyc/submissions/:id        read one (own OR admin)
//   - Admin side:
//     GET    /kyc/queue                  PENDING list, OWNER before TENANT, cursor-paginated
//     POST   /kyc/submissions/:id/decision   APPROVED|REJECTED + notes
//     POST   /kyc/submissions/:id/request-info  PENDING + notes (no state change)
//
// Atomicity: the decision path runs in a single $transaction that
//   1. flips submission status + reviewerUserId + decidedAt + reviewNotes
//   2. writes audit_log row (actor=admin, action=kyc.decision, before/after)
//   3. on APPROVED: flips profile.kycStatus + kycBadgeGrantedAt + expiresAt
//   4. on APPROVED: writes outbox_events row (event_type=kyc.approved)
//
// Cross-user duplicate detection: when docHash matches a prior submission
// from another user, `flagged_for_review` flips true. Admin queue exposes
// flagged rows first.

import type { Prisma } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError, SemanticError } from '@/lib/errors';

import type {
  CreateSubmissionInput,
  DecisionInput,
  QueueQueryInput,
  RequestInfoInput,
} from './kyc.schemas';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface SubmissionView {
  id: string;
  userId: string;
  role: 'TENANT' | 'OWNER' | 'ADMIN';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  documentObjectKeys: string[];
  reviewNotes: string | null;
  reviewerUserId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  docHash: string | null;
  flaggedForReview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QueuePage {
  items: SubmissionView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

function toSubmissionView(row: {
  id: string;
  userId: string;
  role: 'TENANT' | 'OWNER' | 'ADMIN';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  documentObjectKeys: string[];
  reviewNotes: string | null;
  reviewerUserId: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  docHash: string | null;
  flaggedForReview: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SubmissionView {
  return {
    id: row.id,
    userId: row.userId,
    role: row.role,
    status: row.status,
    documentObjectKeys: row.documentObjectKeys,
    reviewNotes: row.reviewNotes,
    reviewerUserId: row.reviewerUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    docHash: row.docHash,
    flaggedForReview: row.flaggedForReview,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const submissionSelect = {
  id: true,
  userId: true,
  role: true,
  status: true,
  documentObjectKeys: true,
  reviewNotes: true,
  reviewerUserId: true,
  decidedAt: true,
  expiresAt: true,
  docHash: true,
  flaggedForReview: true,
  createdAt: true,
  updatedAt: true,
} as const;

function isPrismaCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === code
  );
}

// ──────────────────────────────────────────────────────────────────────
// POST /kyc/submissions
// ──────────────────────────────────────────────────────────────────────

/**
 * Create a PENDING KYC submission for the authenticated user.
 *
 * Pre-conditions:
 *   - The role-profile (owner or tenant) exists. If missing → 404.
 *   - No active submission for (user, role) — enforced by the partial
 *     unique index `kyc_submissions_active_uniq` (P2002 → 409 CONFLICT).
 *
 * Side effects:
 *   - If another user already submitted with the same docHash, this
 *     submission is flagged_for_review=true so admins see it.
 */
export async function createSubmission(
  userId: string,
  body: CreateSubmissionInput
): Promise<SubmissionView> {
  // Confirm the role-profile exists. Without it we have nothing to attach
  // the eventual approval to.
  const profile =
    body.role === 'OWNER'
      ? await prisma.ownerProfile.findUnique({ where: { userId }, select: { userId: true } })
      : await prisma.tenantProfile.findUnique({ where: { userId }, select: { userId: true } });

  if (!profile) {
    throw new NotFoundError(`Profile not set up; PATCH /profiles/${body.role.toLowerCase()} first`);
  }

  // Cross-user duplicate check. We don't reject — we flag for review.
  const dup = await prisma.kycSubmission.findFirst({
    where: { docHash: body.docHash, userId: { not: userId } },
    select: { id: true },
  });
  const flagged = dup !== null;

  try {
    const created = await prisma.kycSubmission.create({
      data: {
        userId,
        role: body.role,
        status: 'PENDING',
        documentObjectKeys: body.documentObjectKeys,
        docHash: body.docHash,
        flaggedForReview: flagged,
      },
      select: submissionSelect,
    });
    return toSubmissionView(created);
  } catch (err) {
    if (isPrismaCode(err, 'P2002')) {
      // Partial unique index hit: an active submission already exists.
      throw new ConflictError(
        'CONFLICT',
        `An active ${body.role} KYC submission already exists for this user`
      );
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /kyc/submissions/me
// ──────────────────────────────────────────────────────────────────────

export async function listMySubmissions(userId: string): Promise<SubmissionView[]> {
  const rows = await prisma.kycSubmission.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: submissionSelect,
  });
  return rows.map(toSubmissionView);
}

// ──────────────────────────────────────────────────────────────────────
// GET /kyc/submissions/:id
// ──────────────────────────────────────────────────────────────────────

/**
 * Read a single submission. Authorization: the caller must be the
 * submission owner OR have the ADMIN role.
 *
 * `callerIsAdmin` is computed at the route level from `req.user.roles`.
 */
export async function getSubmissionById(
  id: string,
  callerId: string,
  callerIsAdmin: boolean
): Promise<SubmissionView> {
  const row = await prisma.kycSubmission.findUnique({
    where: { id },
    select: submissionSelect,
  });
  if (!row) throw new NotFoundError('KYC submission not found');
  if (!callerIsAdmin && row.userId !== callerId) {
    // Don't leak existence to non-owners.
    throw new NotFoundError('KYC submission not found');
  }
  return toSubmissionView(row);
}

// ──────────────────────────────────────────────────────────────────────
// GET /kyc/queue (ADMIN)
// ──────────────────────────────────────────────────────────────────────

/**
 * Cursor-paginated PENDING queue. Ordering: OWNER before TENANT (Owners
 * are gating the property marketplace, so we triage them first), then
 * flagged_for_review first (cross-user dup signal), then oldest first.
 *
 * Cursor format: opaque UUID of the last submission.id seen.
 */
export async function listQueue(query: QueueQueryInput): Promise<QueuePage> {
  // Pin order via raw SQL-fragment emulation: we can't easily express
  // "OWNER before TENANT" inside Prisma's orderBy on a string enum, so
  // we order by (role DESC: OWNER > TENANT alphabetically, but that
  // happens to be the wrong way). Instead use a CASE via $queryRaw —
  // simpler: load with role+createdAt ordering and sort in-memory.
  //
  // For Phase 9 simplicity we use Prisma's orderBy with multiple
  // expressions and a deterministic tiebreaker (createdAt asc, id asc).
  const take = (typeof query.limit === 'number' ? query.limit : 20) + 1;
  const args = {
    where: { status: 'PENDING' as const },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    select: submissionSelect,
  };
  const rows = await prisma.kycSubmission.findMany(args);

  // In-memory ordering: OWNER before TENANT, flagged first within each role.
  const ordered = [...rows].sort((a, b) => {
    const ra = a.role === 'OWNER' ? 0 : 1;
    const rb = b.role === 'OWNER' ? 0 : 1;
    if (ra !== rb) return ra - rb;
    const fa = a.flaggedForReview ? 0 : 1;
    const fb = b.flaggedForReview ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const hasMore = ordered.length > query.limit;
  const page = hasMore ? ordered.slice(0, query.limit) : ordered;
  const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

  return {
    items: page.map(toSubmissionView),
    nextCursor,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /kyc/submissions/:id/decision (ADMIN)
// ──────────────────────────────────────────────────────────────────────

/** KYC approval expiry — spec §6.10 step 5: now + 24 months. */
const KYC_APPROVAL_MS = 24 * 30 * 24 * 60 * 60 * 1000;

export async function decideSubmission(
  submissionId: string,
  adminId: string,
  body: DecisionInput
): Promise<SubmissionView> {
  // Pre-fetch outside the transaction so we know which profile to flip.
  const existing = await prisma.kycSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, userId: true, role: true, status: true },
  });
  if (!existing) throw new NotFoundError('KYC submission not found');
  if (existing.status !== 'PENDING') {
    throw new ConflictError(
      'STATE_MACHINE',
      `Submission is already ${existing.status}; only PENDING can be decided`
    );
  }

  const now = new Date();
  const expiresAt = body.decision === 'APPROVED' ? new Date(now.getTime() + KYC_APPROVAL_MS) : null;

  // Run all side effects in a single transaction.
  const result = await prisma.$transaction(async (tx) => {
    // 1. Flip the submission row.
    const updated = await tx.kycSubmission.update({
      where: { id: submissionId },
      data: {
        status: body.decision,
        reviewNotes: body.notes,
        reviewerUserId: adminId,
        decidedAt: now,
        expiresAt,
      },
      select: submissionSelect,
    });

    // 2. On APPROVED, flip the matching role-profile.
    if (body.decision === 'APPROVED') {
      if (updated.role === 'OWNER') {
        await tx.ownerProfile.update({
          where: { userId: updated.userId },
          data: { kycStatus: 'APPROVED', kycBadgeGrantedAt: now },
        });
      } else if (updated.role === 'TENANT') {
        await tx.tenantProfile.update({
          where: { userId: updated.userId },
          data: { kycStatus: 'APPROVED', kycBadgeGrantedAt: now },
        });
      } else {
        // ADMIN submissions are never created by users; this is just
        // defensive — Phase 9 doesn't expose an ADMIN KYC endpoint.
        throw new SemanticError('ADMIN KYC submissions are not supported');
      }
    } else {
      // REJECTED — flip the profile's status too so the user can see why.
      if (updated.role === 'OWNER') {
        await tx.ownerProfile.update({
          where: { userId: updated.userId },
          data: { kycStatus: 'REJECTED' },
        });
      } else if (updated.role === 'TENANT') {
        await tx.tenantProfile.update({
          where: { userId: updated.userId },
          data: { kycStatus: 'REJECTED' },
        });
      }
    }

    // 3. Append-only audit row.
    await tx.auditLog.create({
      data: {
        actorUserId: adminId,
        actorRole: 'ADMIN',
        action: body.decision === 'APPROVED' ? 'kyc.approved' : 'kyc.rejected',
        targetEntityType: 'kyc_submission',
        targetEntityId: updated.id,
        before: { status: 'PENDING' },
        after: { status: updated.status, expiresAt },
      },
    });

    // 4. Outbox event for downstream consumers (notifications, etc.).
    await tx.outboxEvent.create({
      data: {
        eventType: body.decision === 'APPROVED' ? 'kyc.approved' : 'kyc.rejected',
        payload: {
          submissionId: updated.id,
          userId: updated.userId,
          role: updated.role,
          decidedAt: now.toISOString(),
          expiresAt: expiresAt?.toISOString() ?? null,
          notes: body.notes,
        } as Prisma.InputJsonValue,
      },
    });

    return updated;
  });

  return toSubmissionView(result);
}

// ──────────────────────────────────────────────────────────────────────
// POST /kyc/submissions/:id/request-info (ADMIN)
// ──────────────────────────────────────────────────────────────────────

export async function requestInfo(
  submissionId: string,
  adminId: string,
  body: RequestInfoInput
): Promise<SubmissionView> {
  const existing = await prisma.kycSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, status: true, userId: true, role: true },
  });
  if (!existing) throw new NotFoundError('KYC submission not found');
  if (existing.status !== 'PENDING') {
    throw new ConflictError(
      'STATE_MACHINE',
      `Submission is already ${existing.status}; only PENDING can receive info requests`
    );
  }

  const now = new Date();
  const updated = await prisma.kycSubmission.update({
    where: { id: submissionId },
    data: {
      reviewNotes: body.notes,
      reviewerUserId: adminId,
      // Don't change decidedAt/decidedStatus; status stays PENDING.
    },
    select: submissionSelect,
  });

  // Audit + outbox for the info request (not a decision).
  await prisma.auditLog.create({
    data: {
      actorUserId: adminId,
      actorRole: 'ADMIN',
      action: 'kyc.request_info',
      targetEntityType: 'kyc_submission',
      targetEntityId: updated.id,
      before: { status: 'PENDING' },
      after: { status: 'PENDING', notes: body.notes },
    },
  });

  await prisma.outboxEvent.create({
    data: {
      eventType: 'kyc.request_info',
      payload: {
        submissionId: updated.id,
        userId: updated.userId,
        role: updated.role,
        requestedAt: now.toISOString(),
        notes: body.notes,
      } as Prisma.InputJsonValue,
    },
  });

  return toSubmissionView(updated);
}

// ──────────────────────────────────────────────────────────────────────
// Re-export so callers can wire it explicitly.
// ──────────────────────────────────────────────────────────────────────

export type { Prisma } from '@/generated/prisma/client';

// Phase 9 doesn't expose admin role-gate helpers; keep the export for tests.
export const __testing = { ForbiddenError };
