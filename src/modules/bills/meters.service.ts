// src/modules/bills/meters.service.ts
//
// Phase 16: utility meter CRUD + party resolution.
//
// Authorization model:
//   • OWNER of the parent property can create, list, and update a meter.
//   • ADMIN can do anything.
//   • TENANT of an active lease for the meter's property can list
//     (used by tenant-facing UI to see meter labels).
//
// The `resolvePartiesForMeter` function backs the
// `requireMeterParty` middleware in meters.controller.ts — it follows
// meter → property → leases → owner + tenants in 2 hops. Used both for
// authz and to surface a 404 (not 403) when the meter doesn't exist.

import { Prisma } from '@/generated/prisma/client';
import type { UtilityType } from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface MeterView {
  id: string;
  propertyId: string;
  utilityType: UtilityType;
  label: string;
  ratePerUnitMinor: string;
  currency: string;
  unitLabel: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row type + mapper
// ──────────────────────────────────────────────────────────────────────

type MeterRow = {
  id: string;
  propertyId: string;
  utilityType: UtilityType;
  label: string;
  ratePerUnitMinor: bigint;
  currency: string;
  unitLabel: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function meterRowToView(r: MeterRow): MeterView {
  return {
    id: r.id,
    propertyId: r.propertyId,
    utilityType: r.utilityType,
    label: r.label,
    ratePerUnitMinor: r.ratePerUnitMinor.toString(),
    currency: r.currency,
    unitLabel: r.unitLabel,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const fullMeterSelect = () =>
  ({
    id: true,
    propertyId: true,
    utilityType: true,
    label: true,
    ratePerUnitMinor: true,
    currency: true,
    unitLabel: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
  }) satisfies Prisma.PropertyMeterSelect;

// ──────────────────────────────────────────────────────────────────────
// Party resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Lookup used by `requireMeterParty` middleware (and by readings.service
 * to authorize reading submissions). Returns `ownerId: null` and
 * `tenantIds: []` when the meter doesn't exist so the middleware can
 * 404 without leaking existence.
 *
 * `tenantIds` is the union of every tenant on any ACTIVE lease whose
 * room belongs to the meter's parent property. Inactive leases
 * (DRAFT / ENDED / TERMINATED) are excluded so a former tenant can't
 * keep reading the meter.
 */
export async function resolvePartiesForMeter(meterId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
}> {
  const meter = await prisma.propertyMeter.findUnique({
    where: { id: meterId },
    select: { propertyId: true },
  });
  if (!meter) return { ownerId: null, tenantIds: [] };

  const property = await prisma.property.findUnique({
    where: { id: meter.propertyId },
    select: {
      ownerUserId: true,
      rooms: {
        select: {
          id: true,
        },
      },
    },
  });
  if (!property) return { ownerId: null, tenantIds: [] };

  const roomIds = property.rooms.map((r) => r.id);
  if (roomIds.length === 0) {
    return { ownerId: property.ownerUserId, tenantIds: [] };
  }

  const leases = await prisma.lease.findMany({
    where: {
      roomId: { in: roomIds },
      status: 'ACTIVE',
    },
    select: {
      tenants: { select: { tenantUserId: true } },
    },
  });

  const tenantIds = new Set<string>();
  for (const lease of leases) {
    for (const lt of lease.tenants) tenantIds.add(lt.tenantUserId);
  }
  return { ownerId: property.ownerUserId, tenantIds: [...tenantIds] };
}

// ──────────────────────────────────────────────────────────────────────
// createMeter — POST /properties/:propertyId/meters
// ──────────────────────────────────────────────────────────────────────

export interface CreateMeterInput {
  propertyId: string;
  utilityType: UtilityType;
  label: string;
  /** Per-unit price, in minor units. e.g., 350n = $3.50/m³. */
  ratePerUnitMinor: bigint;
  currency: string;
  unitLabel: string;
}

/**
 * Create a meter on the given property. Caller must be OWNER of the
 * property (ADMIN bypasses via requireRole in the route).
 *
 * Audit + outbox events are written in the same transaction.
 */
export async function createMeter(
  callerUserId: string,
  input: CreateMeterInput
): Promise<MeterView> {
  return await prisma.$transaction(async (tx) => {
    // 1. Property exists + caller is owner.
    const property = await tx.property.findUnique({
      where: { id: input.propertyId },
      select: { id: true, ownerUserId: true },
    });
    if (!property) throw new NotFoundError('Property not found');
    if (property.ownerUserId !== callerUserId) {
      throw new ForbiddenError(
        'NOT_OWNER',
        'Only the property owner may add a meter'
      );
    }

    // 2. Insert.
    const created = await tx.propertyMeter.create({
      data: {
        propertyId: input.propertyId,
        utilityType: input.utilityType,
        label: input.label,
        ratePerUnitMinor: input.ratePerUnitMinor,
        currency: input.currency,
        unitLabel: input.unitLabel,
        isActive: true,
      },
      select: { id: true },
    });

    // 3. Audit + outbox.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'meter.created',
        targetEntityType: 'property_meter',
        targetEntityId: created.id,
        before: Prisma.JsonNull,
        after: {
          propertyId: input.propertyId,
          utilityType: input.utilityType,
          label: input.label,
          ratePerUnitMinor: input.ratePerUnitMinor.toString(),
          currency: input.currency,
          unitLabel: input.unitLabel,
          isActive: true,
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'meter.created',
        payload: {
          meterId: created.id,
          propertyId: input.propertyId,
          utilityType: input.utilityType,
          label: input.label,
          actorUserId: callerUserId,
        } as Prisma.InputJsonValue,
      },
    });

    // 4. Reload for view.
    const reloaded = await tx.propertyMeter.findUnique({
      where: { id: created.id },
      select: fullMeterSelect(),
    });
    if (!reloaded) throw new NotFoundError('Meter vanished after create');
    return meterRowToView(reloaded as unknown as MeterRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// listMetersForProperty — GET /properties/:propertyId/meters
// ──────────────────────────────────────────────────────────────────────

/**
 * List all meters (active + inactive) for a property. Caller must be
 * OWNER of the property or ADMIN. Tenants can read the meter's public
 * fields via listReadingsForMeter / read paths; they don't need a
 * separate list endpoint for v1.
 */
export async function listMetersForProperty(
  callerUserId: string,
  propertyId: string,
  isAdmin: boolean
): Promise<MeterView[]> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, ownerUserId: true },
  });
  if (!property) throw new NotFoundError('Property not found');
  if (!isAdmin && property.ownerUserId !== callerUserId) {
    throw new ForbiddenError('NOT_OWNER', 'Only the property owner may list meters');
  }
  const rows = await prisma.propertyMeter.findMany({
    where: { propertyId },
    select: fullMeterSelect(),
    orderBy: [{ isActive: 'desc' }, { utilityType: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => meterRowToView(r as unknown as MeterRow));
}
