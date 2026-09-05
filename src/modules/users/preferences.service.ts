// src/modules/users/preferences.service.ts
//
// Tenant preferences sheet per 04 §4.3.3. GET / PUT / visibility-PATCH.
//
// Phase 8 simplification: visibility is read+written, but matching
// (Phase 20) is what actually enforces "MATCHES_ONLY hides from
// non-matches". For now we just return the row to the user themselves
// + ADMIN.

import { Prisma } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

import type { PreferencesPutInput, PreferencesVisibilityInput } from './users.schemas';

// ──────────────────────────────────────────────────────────────────────
// View
// ──────────────────────────────────────────────────────────────────────

interface PreferencesView {
  userId: string;
  budgetMinMinor: string | null;
  budgetMaxMinor: string | null;
  preferredCities: string[];
  moveInFrom: string | null;
  moveInTo: string | null;
  lifestyle: Record<string, unknown> | null;
  interests: string[];
  visibility: 'PUBLIC' | 'MATCHES_ONLY' | 'PRIVATE';
  updatedAt: string;
}

const VISIBILITY_VALUES = new Set(['PUBLIC', 'MATCHES_ONLY', 'PRIVATE']);

function toView(row: {
  userId: string;
  budgetMinMinor: bigint | null;
  budgetMaxMinor: bigint | null;
  preferredCities: string[];
  moveInFrom: Date | null;
  moveInTo: Date | null;
  lifestyle: Prisma.JsonValue | null;
  interests: string[];
  visibility: string;
  updatedAt: Date;
}): PreferencesView {
  return {
    userId: row.userId,
    budgetMinMinor: row.budgetMinMinor === null ? null : row.budgetMinMinor.toString(),
    budgetMaxMinor: row.budgetMaxMinor === null ? null : row.budgetMaxMinor.toString(),
    preferredCities: row.preferredCities,
    moveInFrom: row.moveInFrom?.toISOString().slice(0, 10) ?? null,
    moveInTo: row.moveInTo?.toISOString().slice(0, 10) ?? null,
    lifestyle: isPlainObject(row.lifestyle) ? row.lifestyle : null,
    interests: row.interests,
    visibility: VISIBILITY_VALUES.has(row.visibility)
      ? (row.visibility as 'PUBLIC' | 'MATCHES_ONLY' | 'PRIVATE')
      : 'PRIVATE',
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ──────────────────────────────────────────────────────────────────────
// GET
// ──────────────────────────────────────────────────────────────────────

export async function getPreferences(userId: string): Promise<PreferencesView> {
  const row = await prisma.preferencesTenant.findUnique({
    where: { userId },
    select: selectFields,
  });
  if (!row) throw new NotFoundError('Tenant preferences not found');
  return toView(row);
}

// ──────────────────────────────────────────────────────────────────────
// PUT (upsert)
// ──────────────────────────────────────────────────────────────────────

export async function putPreferences(
  userId: string,
  body: PreferencesPutInput
): Promise<PreferencesView> {
  const data: Prisma.PreferencesTenantUncheckedUpdateInput = {};
  if (body.budgetMinMinor !== undefined) data.budgetMinMinor = body.budgetMinMinor;
  if (body.budgetMaxMinor !== undefined) data.budgetMaxMinor = body.budgetMaxMinor;
  if (body.preferredCities !== undefined) data.preferredCities = body.preferredCities;
  if (body.moveInFrom !== undefined)
    data.moveInFrom = body.moveInFrom ? new Date(body.moveInFrom) : null;
  if (body.moveInTo !== undefined) data.moveInTo = body.moveInTo ? new Date(body.moveInTo) : null;
  if (body.lifestyle !== undefined) {
    data.lifestyle = body.lifestyle as Prisma.InputJsonValue;
  }
  if (body.interests !== undefined) data.interests = body.interests;
  if (body.visibility !== undefined) data.visibility = body.visibility;

  const row = await prisma.preferencesTenant.upsert({
    where: { userId },
    create: {
      userId,
      budgetMinMinor: body.budgetMinMinor ?? null,
      budgetMaxMinor: body.budgetMaxMinor ?? null,
      preferredCities: body.preferredCities ?? [],
      moveInFrom: body.moveInFrom ? new Date(body.moveInFrom) : null,
      moveInTo: body.moveInTo ? new Date(body.moveInTo) : null,
      lifestyle:
        body.lifestyle === undefined ? Prisma.JsonNull : (body.lifestyle as Prisma.InputJsonValue),
      interests: body.interests ?? [],
      visibility: body.visibility ?? 'PRIVATE',
    },
    update: data,
    select: selectFields,
  });

  return toView(row);
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /visibility
// ──────────────────────────────────────────────────────────────────────

export async function patchVisibility(
  userId: string,
  body: PreferencesVisibilityInput
): Promise<PreferencesView> {
  // Upsert so the row exists even if the user has never PUT anything.
  await prisma.preferencesTenant.upsert({
    where: { userId },
    create: {
      userId,
      visibility: body.visibility,
    },
    update: { visibility: body.visibility },
    select: { userId: true },
  });

  return getPreferences(userId);
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const selectFields = {
  userId: true,
  budgetMinMinor: true,
  budgetMaxMinor: true,
  preferredCities: true,
  moveInFrom: true,
  moveInTo: true,
  lifestyle: true,
  interests: true,
  visibility: true,
  updatedAt: true,
} as const;

// Re-export so callers can wire it explicitly.
export { Prisma as PrismaNS };
