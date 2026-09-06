// src/modules/properties/flats.schemas.ts
//
// Zod validation for /flats/* endpoints per spec §13.2.3.

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// POST /buildings/:building_id/flats — create flat
// ──────────────────────────────────────────────────────────────────────

export const createFlatSchema = z.object({
  floor: z.number().int().min(-5).max(200).optional(),
  doorNumber: z.string().min(1).max(20).optional(),
});

export type CreateFlatInput = z.infer<typeof createFlatSchema>;

// ──────────────────────────────────────────────────────────────────────
// Path params
// ──────────────────────────────────────────────────────────────────────

export const buildingIdParamsSchema = z.object({
  buildingId: z.string().uuid(),
});

export const flatIdParamsSchema = z.object({
  flatId: z.string().uuid(),
});

export type BuildingIdParams = z.infer<typeof buildingIdParamsSchema>;
export type FlatIdParams = z.infer<typeof flatIdParamsSchema>;
