// src/modules/properties/rooms.schemas.ts
//
// Zod validation for /rooms/* endpoints per spec §13.2.3.

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// Shared enums
// ──────────────────────────────────────────────────────────────────────

export const ROOM_TYPE_VALUES = ['PRIVATE', 'SHARED', 'STUDIO', 'ENTIRE_FLAT'] as const;
export const ROOM_STATUS_VALUES = [
  'DRAFT',
  'PUBLISHED',
  'RESERVED',
  'OCCUPIED',
  'MAINTENANCE_CHECK',
  'MAINTENANCE',
  'TAKEN_DOWN',
] as const;

const CURRENCY = z
  .string()
  .length(3, 'currency must be ISO 4217 (3 chars)')
  .regex(/^[A-Z]{3}$/, 'currency must be uppercase ISO 4217');

// ──────────────────────────────────────────────────────────────────────
// POST /flats/:flat_id/rooms — create room
// ──────────────────────────────────────────────────────────────────────

export const createRoomSchema = z
  .object({
    label: z.string().min(1).max(100),
    roomType: z.enum(ROOM_TYPE_VALUES),
    sizeSqft: z.number().positive().max(100_000).optional(),
    maxOccupants: z.number().int().min(1).max(20).optional(),
    baseRentMinor: z.number().int().nonnegative(),
    depositMinor: z.number().int().nonnegative(),
    currency: CURRENCY,
    billsIncluded: z.boolean().optional(),
    amenities: z.array(z.string().min(1).max(50)).max(50).optional(),
    availableFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'availableFrom must be YYYY-MM-DD')
      .optional(),
    minLeaseMonths: z.number().int().min(1).max(60).optional(),
    maxLeaseMonths: z.number().int().min(1).max(60).optional(),
    rules: z.string().max(2000).optional(),
  })
  .refine(
    (data) =>
      data.minLeaseMonths === undefined ||
      data.maxLeaseMonths === undefined ||
      data.minLeaseMonths <= data.maxLeaseMonths,
    { message: 'minLeaseMonths must be <= maxLeaseMonths', path: ['minLeaseMonths'] }
  );

export type CreateRoomInput = z.infer<typeof createRoomSchema>;

// ──────────────────────────────────────────────────────────────────────
// PATCH /rooms/:id — partial update
// ──────────────────────────────────────────────────────────────────────

export const patchRoomSchema = z
  .object({
    label: z.string().min(1).max(100).optional(),
    roomType: z.enum(ROOM_TYPE_VALUES).optional(),
    sizeSqft: z.number().positive().max(100_000).nullable().optional(),
    maxOccupants: z.number().int().min(1).max(20).optional(),
    baseRentMinor: z.number().int().nonnegative().optional(),
    depositMinor: z.number().int().nonnegative().optional(),
    currency: CURRENCY.optional(),
    billsIncluded: z.boolean().optional(),
    amenities: z.array(z.string().min(1).max(50)).max(50).optional(),
    availableFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'availableFrom must be YYYY-MM-DD')
      .nullable()
      .optional(),
    minLeaseMonths: z.number().int().min(1).max(60).nullable().optional(),
    maxLeaseMonths: z.number().int().min(1).max(60).nullable().optional(),
    rules: z.string().max(2000).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type PatchRoomInput = z.infer<typeof patchRoomSchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/transition — explicit state transition
// ──────────────────────────────────────────────────────────────────────

export const transitionRoomSchema = z.object({
  to: z.enum(ROOM_STATUS_VALUES),
  /** Optional optimistic-concurrency guard. If provided and stale → 409. */
  expectedVersion: z.number().int().nonnegative().optional(),
});

export type TransitionRoomInput = z.infer<typeof transitionRoomSchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/photos — presigned URL stub (Phase 18 will own real upload)
// ──────────────────────────────────────────────────────────────────────

export const requestPhotoUploadSchema = z.object({
  contentType: z
    .string()
    .regex(/^image\/(jpeg|png|webp)$/i, 'contentType must be image/jpeg, image/png, or image/webp'),
  ext: z.enum(['jpg', 'jpeg', 'png', 'webp']).optional(),
});

export type RequestPhotoUploadInput = z.infer<typeof requestPhotoUploadSchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:id/photos/:photo_id/reorder
// ──────────────────────────────────────────────────────────────────────

export const reorderPhotoSchema = z.object({
  position: z.number().int().min(0).max(1000),
});

export type ReorderPhotoInput = z.infer<typeof reorderPhotoSchema>;

// ──────────────────────────────────────────────────────────────────────
// Path params
// ──────────────────────────────────────────────────────────────────────

export const roomIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const flatIdParamsSchema = z.object({
  flatId: z.string().uuid(),
});

export const photoIdParamsSchema = z.object({
  id: z.string().uuid(),
  photoId: z.string().uuid(),
});

export type RoomIdParams = z.infer<typeof roomIdParamsSchema>;
export type FlatIdParams = z.infer<typeof flatIdParamsSchema>;
export type PhotoIdParams = z.infer<typeof photoIdParamsSchema>;
