// src/modules/search/search.schemas.ts
//
// Zod validation for /search/* endpoints per 13 §13.2.4 + 08 §8.3.7.
//
// Phase 11 ships the PostgreSQL-fallback search surface (no ES/OS yet).
// All query params come in as strings from `req.query` and are coerced
// to numbers/dates here. Sort `relevance` is accepted but maps to
// `newest` for now (no BM25 in PG; see TODO in search.service.ts).

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// Shared enums
// ──────────────────────────────────────────────────────────────────────

export const SEARCH_SORT_VALUES = ['relevance', 'newest', 'price_asc', 'price_desc'] as const;
export type SearchSort = (typeof SEARCH_SORT_VALUES)[number];

const CURRENCY = z
  .string()
  .length(3, 'currency must be ISO 4217 (3 chars)')
  .regex(/^[A-Z]{3}$/, 'currency must be uppercase ISO 4217');

// ──────────────────────────────────────────────────────────────────────
// GET /search/rooms — filter / sort / paginate PUBLISHED rooms
// ──────────────────────────────────────────────────────────────────────

/**
 * CSV of amenities (e.g. "wifi,heating"). Each token must be 1..50 chars
 * (matches the room.amenities validator). Coerced from the URL string.
 */
const amenitiesCsvSchema = z
  .string()
  .min(1)
  .max(500)
  .transform((s) =>
    s
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  )
  .pipe(z.array(z.string().min(1).max(50)).min(1).max(20));

export const searchRoomsQuerySchema = z.object({
  /** Exact match on properties.city (case-sensitive — caller normalises). */
  city: z.string().min(1).max(100).optional(),
  /** Free-text ILIKE over properties.title + properties.area. */
  q: z.string().min(1).max(100).optional(),
  /** Lower bound on base_rent_minor (inclusive). */
  rent_min: z.coerce.number().int().nonnegative().optional(),
  /** Upper bound on base_rent_minor (inclusive). */
  rent_max: z.coerce.number().int().nonnegative().optional(),
  /** Currency filter (3-char ISO 4217). */
  currency: CURRENCY.optional(),
  /** Comma-separated; rooms must contain ALL listed amenities. */
  amenities: amenitiesCsvSchema.optional(),
  /** Earliest acceptable available_from (room.available_from <= date OR NULL). */
  available_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'available_from must be YYYY-MM-DD')
    .optional(),
  /** Sort key. `relevance` falls back to `newest` in the service. */
  sort: z.enum(SEARCH_SORT_VALUES).default('newest'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type SearchRoomsQuery = z.infer<typeof searchRoomsQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// GET /search/rooms/suggest — ILIKE typeahead
// ──────────────────────────────────────────────────────────────────────

export const suggestQuerySchema = z.object({
  q: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /search/saved — persist a saved filter set
// ──────────────────────────────────────────────────────────────────────

export const createSavedSearchSchema = z.object({
  name: z.string().min(1).max(80),
  query: searchRoomsQuerySchema,
});

export type CreateSavedSearchInput = z.infer<typeof createSavedSearchSchema>;

// ──────────────────────────────────────────────────────────────────────
// GET /search/saved — list own saved searches
// ──────────────────────────────────────────────────────────────────────

export const listSavedSearchesQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListSavedSearchesQuery = z.infer<typeof listSavedSearchesQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// DELETE /search/saved/:id
// ──────────────────────────────────────────────────────────────────────

export const savedSearchIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type SavedSearchIdParams = z.infer<typeof savedSearchIdParamsSchema>;
