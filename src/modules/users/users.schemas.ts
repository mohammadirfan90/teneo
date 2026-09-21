// src/modules/users/users.schemas.ts
//
// Zod schemas for the users / profiles / preferences module.
//
// Centralized so all three routers can share validation. Names follow
// the route path (camelCase of the path segments) so they're easy to
// grep from the controllers.

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// /users/me
// ──────────────────────────────────────────────────────────────────────

/**
 * PATCH /users/me
 *
 * - `displayName` lives on the role-profile (tenant_profiles /
 *   owner_profiles), not on User, so it isn't here. The user edits
 *   it via PATCH /profiles/<role> instead.
 * - `phone` is E.164-ish: optional `+`, 7–15 digits. Stored as text.
 */
export const updateMeSchema = z.object({
  gender: z.enum(['FEMALE', 'MALE', 'NONBINARY', 'UNDISCLOSED']).optional(),
  phone: z
    .string()
    .regex(/^\+?[0-9]{7,15}$/, 'Phone must be 7–15 digits, optional leading +')
    .nullable()
    .optional(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>;

// ──────────────────────────────────────────────────────────────────────
// /users/:id
// ──────────────────────────────────────────────────────────────────────

export const userIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'id must be a UUID' }),
});

export type UserIdParams = z.infer<typeof userIdParamsSchema>;

// ──────────────────────────────────────────────────────────────────────
// /profiles/owner, /profiles/tenant
// ──────────────────────────────────────────────────────────────────────

export const profilePatchSchema = z.object({
  displayName: z.string().min(2).max(80).optional(),
  bio: z.string().max(2000).nullable().optional(),
  avatarObjectKey: z.string().max(512).nullable().optional(),
});

export type ProfilePatchInput = z.infer<typeof profilePatchSchema>;

// ──────────────────────────────────────────────────────────────────────
// /preferences/tenant
// ──────────────────────────────────────────────────────────────────────

/**
 * PUT /preferences/tenant — write-the-whole-row semantics.
 *
 * `refine` enforces `budgetMinMinor <= budgetMaxMinor` when both are
 * present. We don't reject when only one is set (single-sided budget).
 */
export const preferencesPutSchema = z
  .object({
    budgetMinMinor: z.number().int().nonnegative().optional(),
    budgetMaxMinor: z.number().int().nonnegative().optional(),
    preferredCities: z.array(z.string().min(1).max(80)).max(20).optional(),
    moveInFrom: z.string().date().nullable().optional(),
    moveInTo: z.string().date().nullable().optional(),
    lifestyle: z.record(z.string(), z.unknown()).optional(),
    interests: z.array(z.string().min(1).max(40)).max(30).optional(),
    visibility: z.enum(['PUBLIC', 'MATCHES_ONLY', 'PRIVATE']).optional(),
  })
  .refine(
    (v) =>
      v.budgetMinMinor === undefined ||
      v.budgetMaxMinor === undefined ||
      v.budgetMinMinor <= v.budgetMaxMinor,
    {
      path: ['budgetMinMinor'],
      message: 'budgetMinMinor must be <= budgetMaxMinor',
    }
  );

export type PreferencesPutInput = z.infer<typeof preferencesPutSchema>;

export const preferencesVisibilitySchema = z.object({
  visibility: z.enum(['PUBLIC', 'MATCHES_ONLY', 'PRIVATE']),
});

export type PreferencesVisibilityInput = z.infer<typeof preferencesVisibilitySchema>;
