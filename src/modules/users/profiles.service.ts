// src/modules/users/profiles.service.ts
//
// Business logic for /profiles/* endpoints. The role-profile
// (tenant_profiles / owner_profiles) holds the user's display name,
// bio, and avatar. Both endpoints accept GET + PATCH and upsert on
// PATCH so the user can start filling the sheet before KYC.

import type { Prisma } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

import type { ProfilePatchInput } from './users.schemas';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

interface RoleProfileView {
  userId: string;
  displayName: string;
  bio: string | null;
  avatarObjectKey: string | null;
  kycStatus: string;
  kycBadgeGrantedAt: string | null;
  reputationScore: string | null;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// GET
// ──────────────────────────────────────────────────────────────────────

export async function getOwnerProfile(userId: string): Promise<RoleProfileView> {
  const row = await prisma.ownerProfile.findUnique({
    where: { userId },
    select: profileSelect,
  });
  if (!row) throw new NotFoundError('Owner profile not found');
  return toView(row);
}

export async function getTenantProfile(userId: string): Promise<RoleProfileView> {
  const row = await prisma.tenantProfile.findUnique({
    where: { userId },
    select: profileSelect,
  });
  if (!row) throw new NotFoundError('Tenant profile not found');
  return toView(row);
}

// ──────────────────────────────────────────────────────────────────────
// PATCH (upsert)
// ──────────────────────────────────────────────────────────────────────

/**
 * Upsert the owner profile. If the row doesn't exist yet, we create
 * one with a sensible default `displayName` (email local-part) so the
 * user has something to point at. KYC starts at NONE; Phase 9 wires
 * the submission flow that promotes it.
 */
export async function patchOwnerProfile(
  userId: string,
  patch: ProfilePatchInput
): Promise<RoleProfileView> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new NotFoundError('User not found');

  const data: Prisma.OwnerProfileUncheckedUpdateInput = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.bio !== undefined) data.bio = patch.bio;
  if (patch.avatarObjectKey !== undefined) data.avatarObjectKey = patch.avatarObjectKey;

  const row = await prisma.ownerProfile.upsert({
    where: { userId },
    create: {
      userId,
      displayName: patch.displayName ?? defaultDisplayName(user.email),
      bio: patch.bio ?? null,
      avatarObjectKey: patch.avatarObjectKey ?? null,
    },
    update: data,
    select: profileSelect,
  });

  return toView(row);
}

export async function patchTenantProfile(
  userId: string,
  patch: ProfilePatchInput
): Promise<RoleProfileView> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new NotFoundError('User not found');

  const data: Prisma.TenantProfileUncheckedUpdateInput = {};
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.bio !== undefined) data.bio = patch.bio;
  if (patch.avatarObjectKey !== undefined) data.avatarObjectKey = patch.avatarObjectKey;

  const row = await prisma.tenantProfile.upsert({
    where: { userId },
    create: {
      userId,
      displayName: patch.displayName ?? defaultDisplayName(user.email),
      bio: patch.bio ?? null,
      avatarObjectKey: patch.avatarObjectKey ?? null,
    },
    update: data,
    select: profileSelect,
  });

  return toView(row);
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const profileSelect = {
  userId: true,
  displayName: true,
  bio: true,
  avatarObjectKey: true,
  kycStatus: true,
  kycBadgeGrantedAt: true,
  reputationScore: true,
  updatedAt: true,
} as const;

function toView(row: {
  userId: string;
  displayName: string;
  bio: string | null;
  avatarObjectKey: string | null;
  kycStatus: string;
  kycBadgeGrantedAt: Date | null;
  reputationScore: Prisma.Decimal | null;
  updatedAt: Date;
}): RoleProfileView {
  return {
    userId: row.userId,
    displayName: row.displayName,
    bio: row.bio,
    avatarObjectKey: row.avatarObjectKey,
    kycStatus: row.kycStatus,
    kycBadgeGrantedAt: row.kycBadgeGrantedAt?.toISOString() ?? null,
    reputationScore: row.reputationScore ? row.reputationScore.toString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultDisplayName(email: string): string {
  // "alice@example.com" → "alice". Fallback to the full email if
  // there's no local part (shouldn't happen with validated emails).
  const local = email.split('@')[0] ?? email;
  // Keep within the column's 80-char limit; trim if absurd.
  return local.slice(0, 80);
}
