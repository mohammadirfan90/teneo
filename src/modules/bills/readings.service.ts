// src/modules/bills/readings.service.ts
//
// Phase 16: meter reading CRUD + UNIQUE(meter_id, reading_date) handling.
//
// A reading is a snapshot of a meter value on a specific UTC date. The
// UNIQUE constraint at the DB level rejects duplicate submissions for
// the same (meter, date) — re-submitting for an existing date requires
// the Phase 18+ correction flow, NOT a second POST.
//
// Authorization model:
// • OWNER of the meter's parent property can submit a reading.
// • TENANT on an ACTIVE lease for the meter's property can submit.
// • ADMIN can submit.
// • Anyone party to the meter can list its readings.
//
// The pattern for UNIQUE handling is the standard P2002 catch (mirrors
// Phase 13 lease sign + Phase 14 invoice generate + Phase 15 payment
// intent): pre-check via findFirst, then on insert failure re-fetch the
// winning row.

import { Prisma } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';

import { resolvePartiesForMeter } from './meters.service';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface ReadingView {
  id: string;
  meterId: string;
  readingDate: string;
  /** Stringified Decimal to preserve precision over the wire. */
  readingValue: string;
  notes: string | null;
  submittedByUserId: string;
  createdAt: string;
}

export interface ReadingSummaryView {
  id: string;
  meterId: string;
  readingDate: string;
  readingValue: string;
}

export interface ReadingPage {
  items: ReadingSummaryView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row type + mapper
// ──────────────────────────────────────────────────────────────────────

type ReadingRow = {
  id: string;
  meterId: string;
  readingDate: Date;
  readingValue: Prisma.Decimal;
  notes: string | null;
  submittedByUserId: string;
  createdAt: Date;
};

function readingRowToView(r: ReadingRow): ReadingView {
  return {
    id: r.id,
    meterId: r.meterId,
    readingDate: r.readingDate.toISOString().slice(0, 10),
    readingValue: r.readingValue.toString(),
    notes: r.notes,
    submittedByUserId: r.submittedByUserId,
    createdAt: r.createdAt.toISOString(),
  };
}

function readingRowToSummary(r: ReadingRow): ReadingSummaryView {
  return {
    id: r.id,
    meterId: r.meterId,
    readingDate: r.readingDate.toISOString().slice(0, 10),
    readingValue: r.readingValue.toString(),
  };
}

const fullReadingSelect = () =>
  ({
    id: true,
    meterId: true,
    readingDate: true,
    readingValue: true,
    notes: true,
    submittedByUserId: true,
    createdAt: true,
  }) satisfies Prisma.MeterReadingSelect;

const summaryReadingSelect = () =>
  ({
    id: true,
    meterId: true,
    readingDate: true,
    readingValue: true,
  }) satisfies Prisma.MeterReadingSelect;

// ──────────────────────────────────────────────────────────────────────
// createReading — POST /meters/:meterId/readings
// ──────────────────────────────────────────────────────────────────────

export interface CreateReadingInput {
  meterId: string;
  /** UTC date string (YYYY-MM-DD) — coerced to UTC midnight Date by the controller. */
  readingDate: Date;
  /** Decimal as string from the JSON body — preserves precision. */
  readingValue: Prisma.Decimal | string | number;
  notes?: string | null;
}

/**
 * Submit a meter reading. Caller must be a party to the meter
 * (owner of property OR tenant on active lease OR ADMIN).
 *
 * Idempotency: UNIQUE(meter_id, reading_date) at the DB. Pre-check
 * + P2002 catch — same pattern as Phase 14 invoices + Phase 15
 * payments.
 */
export async function createReading(
  callerUserId: string,
  input: CreateReadingInput
): Promise<ReadingView> {
  return await prisma.$transaction(async (tx) => {
    // 1. Meter exists.
    const meter = await tx.propertyMeter.findUnique({
      where: { id: input.meterId },
      select: { id: true, isActive: true },
    });
    if (!meter) throw new NotFoundError('Meter not found');

    // 2. Caller authorization: re-resolve parties inside the tx so a
    // concurrent deactivation (Phase 18+) can't sneak through.
    const parties = await resolvePartiesForMeter(input.meterId);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Meter not found');
    }
    const isParty =
      parties.ownerId === callerUserId ||
      parties.tenantIds.includes(callerUserId);
    if (!isParty) {
      throw new ForbiddenError(
        'NOT_OWNER',
        'Caller is not a party to this meter'
      );
    }

    // 3. Idempotency: existing reading for (meter, date)?
    const existing = await tx.meterReading.findFirst({
      where: {
        meterId: input.meterId,
        readingDate: input.readingDate,
      },
      select: { id: true },
    });
    if (existing) {
      // Surface a 409 (CONFLICT) — Phase 18+ will add a correction flow.
      throw new ConflictError(
        'CONFLICT',
        `A reading already exists for this meter on ${input.readingDate.toISOString().slice(0, 10)}`,
        [
          {
            field: 'readingDate',
            code: 'DUPLICATE',
            message: 'reading already exists for this (meter, date)',
          },
        ]
      );
    }

    // 4. Insert.
    const value =
      typeof input.readingValue === 'string' || typeof input.readingValue === 'number'
        ? new Prisma.Decimal(input.readingValue)
        : input.readingValue;

    let readingId: string;
    try {
      const created = await tx.meterReading.create({
        data: {
          meterId: input.meterId,
          readingDate: input.readingDate,
          readingValue: value,
          notes: input.notes ?? null,
          submittedByUserId: callerUserId,
        },
        select: { id: true },
      });
      readingId = created.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        // Race-loser branch.
        throw new ConflictError(
          'CONFLICT',
          `A reading already exists for this meter on ${input.readingDate.toISOString().slice(0, 10)} (concurrent submission)`,
          [
            {
              field: 'readingDate',
              code: 'DUPLICATE',
              message: 'reading already exists for this (meter, date)',
            },
          ]
        );
      }
      throw e;
    }

    // 5. audit.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: parties.ownerId === callerUserId ? 'OWNER' : 'TENANT',
        action: 'meter.reading_submitted',
        targetEntityType: 'meter_reading',
        targetEntityId: readingId,
        before: Prisma.JsonNull,
        after: {
          meterId: input.meterId,
          readingDate: input.readingDate.toISOString().slice(0, 10),
          readingValue: value.toString(),
          notes: input.notes ?? null,
        },
      },
    });
    

    // 6. Reload.
    const reloaded = await tx.meterReading.findUnique({
      where: { id: readingId },
      select: fullReadingSelect(),
    });
    if (!reloaded) throw new NotFoundError('Reading vanished after create');
    return readingRowToView(reloaded as unknown as ReadingRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// listReadingsForMeter — GET /meters/:meterId/readings
// ──────────────────────────────────────────────────────────────────────

/**
 * Cursor-paginated list of readings for a meter, newest-first. Caller
 * must be a party to the meter.
 *
 * Cursor is an opaque base64url of `<readingDate ISO>|<id>` for
 * stability across identical timestamps (ties broken by id desc).
 *
 * Invalid cursors are silently ignored and treated as `null` (the
 * caller gets the first page).
 */
export async function listReadingsForMeter(
  callerUserId: string,
  meterId: string,
  limit: number,
  cursor: string | null
): Promise<ReadingPage> {
  const parties = await resolvePartiesForMeter(meterId);
  if (parties.ownerId === null && parties.tenantIds.length === 0) {
    throw new NotFoundError('Meter not found');
  }
  const isParty =
    parties.ownerId === callerUserId || parties.tenantIds.includes(callerUserId);
  if (!isParty) {
    throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this meter');
  }

  const cursorDate = cursor ? decodeCursorDate(cursor) : null;
  const cursorId = cursor ? decodeCursorId(cursor) : null;

  const where: Prisma.MeterReadingWhereInput = { meterId };
  if (cursorDate && !Number.isNaN(cursorDate.getTime())) {
    // Cursor pagination: (date < cursor) OR (date = cursor AND id < cursor.id).
    where.OR = [
      { readingDate: { lt: cursorDate } },
      ...(cursorId ? [{ readingDate: cursorDate, id: { lt: cursorId } }] : []),
    ];
  }

  const rows = await prisma.meterReading.findMany({
    where,
    select: summaryReadingSelect(),
    orderBy: [{ readingDate: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(`${last.readingDate.toISOString()}|${last.id}`).toString('base64url')
      : null;

  return {
    items: slice.map((r) => readingRowToSummary(r as unknown as ReadingRow)),
    nextCursor,
  };
}

/**
 * Decode the cursor back into the (date, id) pair. Returns
 * `undefined` for any field that can't be parsed.
 */
function decodeCursorParts(cursor: string): { date?: Date; id?: string } {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    const date = iso ? new Date(iso) : undefined;
    return {
      date: date && !Number.isNaN(date.getTime()) ? date : undefined,
      id: id || undefined,
    };
  } catch {
    return {};
  }
}

function decodeCursorDate(cursor: string): Date | undefined {
  return decodeCursorParts(cursor).date;
}

function decodeCursorId(cursor: string): string | undefined {
  return decodeCursorParts(cursor).id;
}
