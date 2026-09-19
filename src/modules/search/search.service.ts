// src/modules/search/search.service.ts
//
// Search surface for /search/* per 13 §13.2.4 + 08 §8.3.7.
//
// Phase 11 ships the Postgres fallback path only — no Elasticsearch /
// OpenSearch. The schema relies on indexes already created in Phase 10:
//
// properties_city_status_published_idx(city, status, published_at)
// rooms_status_available_idx(status, available_from)
// rooms_amenities_gin GIN on rooms.amenities TEXT[]
//
// Sort `relevance` falls back to `newest` (no BM25 / `tsvector` yet;
// FTS upgrade is deferred to Phase 20). Geo radius and saved-search
// refresh are also out of scope for this phase (see plan).
//
// FUTURE: ES upgrade — replace this service body with an ES client +
// keep the controller signature stable so callers don't notice.

import type { Prisma } from '@/generated/prisma/client';
import type { RoomStatus } from '@/generated/prisma/enums';

import * as cacheLib from '@/lib/cache';
import { hashFilter } from '@/lib/cache';
import { prisma } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import type {
  CreateSavedSearchInput,
  ListSavedSearchesQuery,
  SearchRoomsQuery,
  SuggestQuery,
} from './search.schemas';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

/**
 * Render-ready card view returned by /search/rooms. Joins room +
 * property + flat + building + owner summary so the client can render
 * a result without a second roundtrip.
 */
export interface RoomSearchView {
  id: string;
  propertyId: string;
  flatId: string | null;
  label: string;
  roomType: string;
  sizeSqft: string | null;
  maxOccupants: number;
  baseRentMinor: string;
  depositMinor: string;
  currency: string;
  amenities: string[];
  availableFrom: string | null;
  minLeaseMonths: number | null;
  maxLeaseMonths: number | null;
  version: number;
  createdAt: string;
  property: {
    id: string;
    title: string;
    city: string;
    area: string | null;
    countryCode: string;
    publishedAt: string | null;
  };
  flat: {
    id: string;
    floor: number | null;
    doorNumber: string | null;
    buildingName: string;
  } | null;
  owner: {
    id: string;
    displayName: string;
  };
}

export interface SearchRoomsPage {
  items: RoomSearchView[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface RoomSuggestItem {
  id: string;
  label: string;
  city: string;
  area: string | null;
}

export interface SavedSearchView {
  id: string;
  userId: string;
  name: string;
  query: SearchRoomsQuery;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSearchPage {
  items: SavedSearchView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// helpers — decimal / bigint / date serialisation (mirror rooms.service.ts)
// ──────────────────────────────────────────────────────────────────────

function decimalToString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'object' && v !== null && 'toString' in v) {
    return (v as { toString(): string }).toString();
  }
  return null;
}

function bigintToString(v: bigint): string {
  return v.toString();
}

function dateOnlyToString(v: Date | null): string | null {
  if (!v) return null;
  return v.toISOString().slice(0, 10);
}

function decimalFloorToNumberOrNull(v: unknown): number | null {
  // Flat/building `floor` is Int in the schema, but defensively coerce in
  // case a future migration makes it numeric.
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Select shape for the search-rows join. Keeps the SQL narrow (no
// unnecessary room-rules or billsIncluded hydration).
const searchRowSelect = {
  id: true,
  propertyId: true,
  flatId: true,
  label: true,
  roomType: true,
  sizeSqft: true,
  maxOccupants: true,
  baseRentMinor: true,
  depositMinor: true,
  currency: true,
  amenities: true,
  availableFrom: true,
  minLeaseMonths: true,
  maxLeaseMonths: true,
  version: true,
  createdAt: true,
  property: {
    select: {
      id: true,
      title: true,
      city: true,
      area: true,
      countryCode: true,
      publishedAt: true,
      deletedAt: true,
      ownerUserId: true,
      owner: {
        select: {
          id: true,
          ownerProfile: { select: { displayName: true } },
        },
      },
    },
  },
  flat: {
    select: {
      id: true,
      floor: true,
      doorNumber: true,
      building: { select: { name: true } },
    },
  },
} satisfies Prisma.RoomSelect;

type SearchRow = NonNullable<Awaited<ReturnType<typeof runSearchQuery>>[number]>;

function toRoomSearchView(row: SearchRow): RoomSearchView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    flatId: row.flatId,
    label: row.label,
    roomType: row.roomType,
    sizeSqft: decimalToString(row.sizeSqft),
    maxOccupants: row.maxOccupants,
    baseRentMinor: bigintToString(row.baseRentMinor),
    depositMinor: bigintToString(row.depositMinor),
    currency: row.currency,
    amenities: row.amenities,
    availableFrom: dateOnlyToString(row.availableFrom),
    minLeaseMonths: row.minLeaseMonths,
    maxLeaseMonths: row.maxLeaseMonths,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    property: {
      id: row.property.id,
      title: row.property.title,
      city: row.property.city,
      area: row.property.area,
      countryCode: row.property.countryCode,
      publishedAt: row.property.publishedAt?.toISOString() ?? null,
    },
    flat: row.flat
      ? {
          id: row.flat.id,
          floor: decimalFloorToNumberOrNull(row.flat.floor),
          doorNumber: row.flat.doorNumber,
          buildingName: row.flat.building.name,
        }
      : null,
    owner: {
      id: row.property.owner.id,
      // Fall back to email local-part when no owner_profile is set.
      displayName: row.property.owner.ownerProfile?.displayName ?? 'Owner',
    },
  };
}

async function runSearchQuery(
  where: Prisma.RoomWhereInput,
  orderBy: Prisma.RoomOrderByWithRelationInput[],
  take: number,
  cursor?: { id: string }
) {
  return prisma.room.findMany({
    where,
    orderBy,
    take,
    ...(cursor ? { skip: 1, cursor } : {}),
    select: searchRowSelect,
  });
}

// ──────────────────────────────────────────────────────────────────────
// GET /search/rooms
// ──────────────────────────────────────────────────────────────────────

export async function searchRooms(query: SearchRoomsQuery): Promise<SearchRoomsPage> {
  // Phase 21: cache wrapper. The cache key includes the city (so a
  // search in 'Mumbai' doesn't pollute 'Bangalore' results) plus a
  // deterministic hash of the remaining filter set (rent_min/max,
  // amenities, sort, cursor, q, etc.). TTL 120s; invalidated by
  // tag 'search:{city}' on property PATCH/takedown (Phase 21 wires
  // that path in properties.service.ts).
  const cacheKey = buildSearchCacheKey(query);
  const cached = await cacheLib.get<SearchRoomsPage>(cacheKey);
  if (cached !== null) {
    logger.info({ cacheKey }, 'cache_hit');
    return cached;
  }
  logger.info({ cacheKey }, 'cache_miss');

  // Hard filters: only PUBLISHED rooms on PUBLISHED, non-deleted
  // properties (rooms on MAINTENANCE / TAKEN_DOWN are hidden per
  // 05 §5.4 invariant — MAINTENANCE rooms don't appear in search).
  const where: Prisma.RoomWhereInput = {
    status: 'PUBLISHED',
    deletedAt: null,
    property: {
      status: 'PUBLISHED',
      deletedAt: null,
      ...(query.city ? { city: query.city } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { area: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.rent_min !== undefined || query.rent_max !== undefined
      ? {
          baseRentMinor: {
            ...(query.rent_min !== undefined ? { gte: BigInt(query.rent_min) } : {}),
            ...(query.rent_max !== undefined ? { lte: BigInt(query.rent_max) } : {}),
          },
        }
      : {}),
    ...(query.amenities && query.amenities.length > 0
      ? { amenities: { hasEvery: query.amenities } }
      : {}),
    ...(query.available_from
      ? {
          // Rooms must be available by this date: available_from is
          // NULL (always available) OR <= date.
          OR: [{ availableFrom: null }, { availableFrom: { lte: new Date(query.available_from) } }],
        }
      : {}),
  };

  // Sort. Phase 11: relevance falls back to newest because we have no
  // BM25 score. When Phase 20 adds `tsvector`, switch `relevance` to
  // `orderBy: { _relevance: 'desc' }` (Prisma raw + ts_rank).
  const orderBy: Prisma.RoomOrderByWithRelationInput[] = (() => {
    switch (query.sort) {
      case 'price_asc':
        return [{ baseRentMinor: 'asc' }, { id: 'asc' }];
      case 'price_desc':
        return [{ baseRentMinor: 'desc' }, { id: 'asc' }];
      default:
        return [{ property: { publishedAt: 'desc' } }, { id: 'asc' }];
    }
  })();

  const limit = query.limit;
  const take = limit + 1;
  const cursor = query.cursor ? { id: query.cursor } : undefined;
  const rows = await runSearchQuery(where, orderBy, take, cursor);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;

  const result: SearchRoomsPage = {
    items: page.map(toRoomSearchView),
    nextCursor,
    hasMore,
  };

  // Cache write-through. Tag every entry with search:{city} so a
  // property takedown in this city evicts them in one call.
  await cacheLib.taggedSet(cacheKey, result, 120, [
    query.city ? `search:${query.city.toLowerCase()}` : 'search:all',
  ]);

  return result;
}

// Cache-key builder. Opaque hash so the key length stays bounded
// regardless of how many amenities / filter fields the caller sends.
function buildSearchCacheKey(query: SearchRoomsQuery): string {
  const filterHash = hashFilter({
    city: query.city ?? '',
    q: query.q ?? '',
    currency: query.currency ?? '',
    rent_min: query.rent_min ?? '',
    rent_max: query.rent_max ?? '',
    amenities: (query.amenities ?? []).slice().sort(),
    available_from: query.available_from ?? '',
    sort: query.sort ?? '',
    cursor: query.cursor ?? '',
    limit: query.limit,
  });
  return `search:rooms:${query.city ?? 'all'}:${filterHash}`;
}

// ──────────────────────────────────────────────────────────────────────
// GET /search/rooms/suggest
// ──────────────────────────────────────────────────────────────────────

export async function suggestRooms(query: SuggestQuery): Promise<RoomSuggestItem[]> {
  const rows = await prisma.room.findMany({
    where: {
      status: 'PUBLISHED',
      deletedAt: null,
      property: {
        status: 'PUBLISHED',
        deletedAt: null,
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { area: { contains: query.q, mode: 'insensitive' } },
        ],
      },
    },
    orderBy: [{ property: { publishedAt: 'desc' } }, { id: 'asc' }],
    take: query.limit,
    select: {
      id: true,
      label: true,
      property: { select: { city: true, area: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    city: r.property.city,
    area: r.property.area,
  }));
}

// ──────────────────────────────────────────────────────────────────────
// POST /search/saved
// ──────────────────────────────────────────────────────────────────────

export async function createSavedSearch(
  userId: string,
  body: CreateSavedSearchInput
): Promise<SavedSearchView> {
  // Partial unique index `saved_searches_user_active_name_uniq` enforces
  // name uniqueness per active user. We catch P2002 and surface a
  // friendlier ConflictError so the client gets a useful message.
  try {
    const created = await prisma.savedSearch.create({
      data: {
        userId,
        name: body.name,
        // Cast the parsed query to InputJsonValue — schema ensures it's
        // a JSON-serialisable object.
        query: body.query as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        userId: true,
        name: true,
        query: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return savedSearchToView(created);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      throw new ConflictError(
        'CONFLICT',
        `A saved search named "${body.name}" already exists; delete it first or pick another name`
      );
    }
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────────────
// GET /search/saved
// ──────────────────────────────────────────────────────────────────────

export async function listSavedSearches(
  userId: string,
  query: ListSavedSearchesQuery
): Promise<SavedSearchPage> {
  const limit = query.limit;
  const take = limit + 1;
  const rows = await prisma.savedSearch.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    select: {
      id: true,
      userId: true,
      name: true,
      query: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? (page[page.length - 1]?.id ?? null) : null;
  return {
    items: page.map(savedSearchToView),
    nextCursor,
  };
}

// ──────────────────────────────────────────────────────────────────────
// DELETE /search/saved/:id — soft-delete with existence-leak guard
// ──────────────────────────────────────────────────────────────────────

export async function deleteSavedSearch(
  userId: string,
  savedSearchId: string
): Promise<{ id: string; deletedAt: string }> {
  const existing = await prisma.savedSearch.findFirst({
    where: { id: savedSearchId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('Saved search not found');

  const now = new Date();
  await prisma.savedSearch.update({
    where: { id: savedSearchId },
    data: { deletedAt: now },
    select: { id: true },
  });

  // Audit.
  await prisma.auditLog.create({
    data: {
      actorUserId: userId,
      actorRole: null, // any logged-in user; no admin override needed
      action: 'saved_search.deleted',
      targetEntityType: 'saved_search',
      targetEntityId: savedSearchId,
      before: { deletedAt: null },
      after: { deletedAt: now.toISOString() },
    },
  });

  return { id: savedSearchId, deletedAt: now.toISOString() };
}

// ──────────────────────────────────────────────────────────────────────
// helpers — row → view
// ──────────────────────────────────────────────────────────────────────

type SavedSearchRow = {
  id: string;
  userId: string;
  name: string;
  query: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function savedSearchToView(row: SavedSearchRow): SavedSearchView {
  // The DB stores `query` as JSONB; Zod already validated it on the way
  // in, so it's safe to round-trip the parsed shape here.
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    query: row.query as SearchRoomsQuery,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Re-export so the controller can compose the typed view.
export type { RoomStatus };
