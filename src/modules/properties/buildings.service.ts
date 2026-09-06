// src/modules/properties/buildings.service.ts
//
// Business logic for /buildings/* per spec §13.2.3.
//
// Surfaces:
//   POST /properties/:property_id/buildings   OWNER (own) — create
//   PATCH /buildings/:id                      OWNER (own via property)

import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';

import type { CreateBuildingInput, PatchBuildingInput } from './buildings.schemas';
import { assertCallerOwnsOrAdmin, resolveOwnerIdForBuilding } from './properties.service';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface BuildingView {
  id: string;
  propertyId: string;
  name: string;
  floors: number | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

const buildingSelect = {
  id: true,
  propertyId: true,
  name: true,
  floors: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

type BuildingRow = {
  id: string;
  propertyId: string;
  name: string;
  floors: number | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
};

function toBuildingView(row: BuildingRow): BuildingView {
  return {
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    floors: row.floors,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /properties/:property_id/buildings
// ──────────────────────────────────────────────────────────────────────

export async function createBuilding(
  propertyId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: CreateBuildingInput
): Promise<BuildingView> {
  // Confirm the property exists, isn't soft-deleted, and the caller owns it.
  const property = await prisma.property.findFirst({
    where: { id: propertyId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!property) throw new NotFoundError('Property not found');
  assertCallerOwnsOrAdmin(property.ownerUserId, callerUserId, callerRoles);

  const created = await prisma.building.create({
    data: {
      propertyId,
      name: body.name,
      floors: body.floors,
      status: 'ACTIVE',
    },
    select: buildingSelect,
  });
  return toBuildingView(created);
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /buildings/:id
// ──────────────────────────────────────────────────────────────────────

export async function patchBuilding(
  buildingId: string,
  callerUserId: string,
  callerRoles: readonly string[],
  body: PatchBuildingInput
): Promise<BuildingView> {
  const ownerId = await resolveOwnerIdForBuilding(buildingId, { throwIfMissing: true });
  assertCallerOwnsOrAdmin(ownerId, callerUserId, callerRoles);

  const data: {
    name?: string;
    floors?: number | null;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.floors !== undefined) data.floors = body.floors;

  const updated = await prisma.building.update({
    where: { id: buildingId },
    data,
    select: buildingSelect,
  });
  return toBuildingView(updated);
}
