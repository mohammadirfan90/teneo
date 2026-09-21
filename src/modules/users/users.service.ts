// src/modules/users/users.service.ts
//
// Business logic for /users/* endpoints. Composes Prisma + the
// role-profile tables and throws typed errors for the controller.
//
// Two surfaces:
//   1. /users/me — caller is always themselves (requireAuth + the
//      route /me). No additional role gate.
//   2. /users/:id + /users/:id/deactivate — ADMIN only (mounted under
//      requireRole('ADMIN') in the router).

import type { Prisma } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { NotFoundError, SemanticError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import type { UpdateMeInput } from './users.schemas';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface MeView {
  id: string;
  email: string;
  gender: string | null;
  phone: string | null;
  status: string;
  roles: Array<'TENANT' | 'OWNER' | 'ADMIN'>;
  kycStatus: { tenant: string; owner: string } | null;
  createdAt: string;
}

export interface UserDetailView extends MeView {
  emailVerifiedAt: string | null;
  oauthProvider: string | null;
  deletedAt: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// /users/me
// ──────────────────────────────────────────────────────────────────────

/** Read the canonical "me" view for the authenticated user. */
export async function getMe(userId: string): Promise<MeView> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      gender: true,
      phone: true,
      status: true,
      createdAt: true,
      roles: { select: { role: true } },
      tenantProfile: { select: { kycStatus: true } },
      ownerProfile: { select: { kycStatus: true } },
    },
  });

  if (!user) {
    // Should be impossible — requireAuth already validated the user —
    // but defensive: 404 rather than a 500 if the row was deleted
    // between the auth check and this query.
    throw new NotFoundError('User not found');
  }

  return toMeView(user);
}

/** PATCH /users/me — gender + phone on the User row. */
export async function updateMe(userId: string, patch: UpdateMeInput): Promise<MeView> {
  // No-op patch? Just re-read.
  const data: Prisma.UserUpdateInput = {};
  if (patch.gender !== undefined) data.gender = patch.gender;
  if (patch.phone !== undefined) data.phone = patch.phone;

  if (Object.keys(data).length > 0) {
    try {
      await prisma.user.update({ where: { id: userId }, data });
    } catch (err) {
      // Prisma's P2025 is "record not found"; treat as 404.
      throwNotFoundIfP2025(err);
      throw err;
    }
  }

  return getMe(userId);
}

// ──────────────────────────────────────────────────────────────────────
// /users/:id — ADMIN
// ──────────────────────────────────────────────────────────────────────

export async function getUserById(id: string): Promise<UserDetailView> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      gender: true,
      phone: true,
      status: true,
      emailVerifiedAt: true,
      oauthProvider: true,
      createdAt: true,
      deletedAt: true,
      roles: { select: { role: true } },
      tenantProfile: { select: { kycStatus: true } },
      ownerProfile: { select: { kycStatus: true } },
    },
  });
  if (!user) throw new NotFoundError('User not found');

  return {
    ...toMeView(user),
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    oauthProvider: user.oauthProvider,
    deletedAt: user.deletedAt?.toISOString() ?? null,
  };
}

/**
 * Soft-delete + anonymize. Single transaction so the row can't end up
 * half-anonymized.
 *
 * Spec §4.9: deleted accounts have their PII overwritten; the row stays
 * around for auditability but no longer identifies the human.
 */
export async function deactivateUser(
  actorUserId: string,
  targetUserId: string
): Promise<UserDetailView> {
  if (actorUserId === targetUserId) {
    // ADMINs shouldn't be able to deactivate themselves; the role
    // provisioning path is what handles ADMIN onboarding / offboarding.
    throw new SemanticError('Admins cannot deactivate themselves');
  }

  const anonymizedEmail = `deactivated-${targetUserId}@deleted.local`;

  await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: targetUserId, deletedAt: null },
      data: {
        status: 'DEACTIVATED',
        deletedAt: new Date(),
        email: anonymizedEmail,
        phone: null,
        passwordHash: null,
        oauthProvider: null,
        oauthSubject: null,
        emailVerifiedAt: null,
      },
    });

    if (updated.count === 0) {
      // Either the user doesn't exist, or they were already deactivated.
      // Throw 404 in both cases; the ADMIN can re-GET to see the
      // anonymized email if they really need to know.
      throw new NotFoundError('User not found or already deactivated');
    }

    // Revoke all active refresh tokens (Redis would be killed
    // naturally on TTL but we save the wait). Single SQL UPDATE.
    await tx.refreshToken.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  // Best-effort log line. Phase 19 wires the structured audit row.
  logger.warn({ actorUserId, targetUserId, action: 'user.deactivate' }, 'user_deactivated');

  return getUserById(targetUserId);
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

function toMeView(user: {
  id: string;
  email: string;
  gender: string | null;
  phone: string | null;
  status: string;
  createdAt: Date;
  roles: Array<{ role: 'TENANT' | 'OWNER' | 'ADMIN' }>;
  tenantProfile?: { kycStatus: string } | null;
  ownerProfile?: { kycStatus: string } | null;
}): MeView {
  return {
    id: user.id,
    email: user.email, // PII; controlled endpoint (requireAuth), kept per spec
    gender: user.gender,
    phone: user.phone,
    status: user.status,
    roles: user.roles.map((r) => r.role),
    kycStatus:
      user.tenantProfile || user.ownerProfile
        ? {
            tenant: user.tenantProfile?.kycStatus ?? 'NONE',
            owner: user.ownerProfile?.kycStatus ?? 'NONE',
          }
        : null,
    createdAt: user.createdAt.toISOString(),
  };
}

function throwNotFoundIfP2025(err: unknown): void {
  if (isPrismaCode(err, 'P2025')) throw new NotFoundError('User not found');
}

function isPrismaCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === code
  );
}
