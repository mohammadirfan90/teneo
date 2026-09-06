// src/modules/properties/buildings.schemas.ts
//
// Zod validation for /buildings/* and /properties/:id/buildings endpoints
// per spec §13.2.3.

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// POST /properties/:property_id/buildings — create building
// ──────────────────────────────────────────────────────────────────────

export const createBuildingSchema = z.object({
  name: z.string().min(1).max(100),
  floors: z.number().int().min(1).max(200).optional(),
});

export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;

// ──────────────────────────────────────────────────────────────────────
// PATCH /buildings/:id — partial update
// ──────────────────────────────────────────────────────────────────────

export const patchBuildingSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    floors: z.number().int().min(1).max(200).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type PatchBuildingInput = z.infer<typeof patchBuildingSchema>;

// ──────────────────────────────────────────────────────────────────────
// Path params
// ──────────────────────────────────────────────────────────────────────

export const propertyIdParamsSchema = z.object({
  propertyId: z.string().uuid(),
});

export const buildingIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type PropertyIdParams = z.infer<typeof propertyIdParamsSchema>;
export type BuildingIdParams = z.infer<typeof buildingIdParamsSchema>;
