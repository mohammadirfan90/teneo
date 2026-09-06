// src/modules/properties/properties.schemas.ts
//
// Zod validation for /properties/* endpoints per spec §13.2.3.

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// Shared enums (re-exported so other modules in /properties can reuse)
// ──────────────────────────────────────────────────────────────────────

export const PROPERTY_TYPE_VALUES = ['BUILDING', 'VILLA', 'STANDALONE_FLAT'] as const;
export const PROPERTY_STATUS_VALUES = ['DRAFT', 'PUBLISHED', 'TAKEN_DOWN'] as const;

const COUNTRY_CODE = z
  .string()
  .length(2, 'countryCode must be ISO 3166-1 alpha-2 (2 chars)')
  .regex(/^[A-Z]{2}$/, 'countryCode must be uppercase ISO 3166-1 alpha-2');

const LATITUDE = z
  .number()
  .min(-90, 'latitude must be between -90 and 90')
  .max(90, 'latitude must be between -90 and 90');

const LONGITUDE = z
  .number()
  .min(-180, 'longitude must be between -180 and 180')
  .max(180, 'longitude must be between -180 and 180');

// ──────────────────────────────────────────────────────────────────────
// POST /properties — create
// ──────────────────────────────────────────────────────────────────────

export const createPropertySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  area: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  countryCode: COUNTRY_CODE,
  latitude: LATITUDE.optional(),
  longitude: LONGITUDE.optional(),
  propertyType: z.enum(PROPERTY_TYPE_VALUES),
});

export type CreatePropertyInput = z.infer<typeof createPropertySchema>;

// ──────────────────────────────────────────────────────────────────────
// PATCH /properties/:id — partial update
// ──────────────────────────────────────────────────────────────────────

export const patchPropertySchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    addressLine1: z.string().min(1).max(200).optional(),
    addressLine2: z.string().max(200).nullable().optional(),
    city: z.string().min(1).max(100).optional(),
    area: z.string().max(100).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    countryCode: COUNTRY_CODE.optional(),
    latitude: LATITUDE.nullable().optional(),
    longitude: LONGITUDE.nullable().optional(),
    propertyType: z.enum(PROPERTY_TYPE_VALUES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type PatchPropertyInput = z.infer<typeof patchPropertySchema>;

// ──────────────────────────────────────────────────────────────────────
// Path/query params
// ──────────────────────────────────────────────────────────────────────

export const propertyIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type PropertyIdParams = z.infer<typeof propertyIdParamsSchema>;

export const listMyPropertiesQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListMyPropertiesQuery = z.infer<typeof listMyPropertiesQuerySchema>;
