// src/modules/bills/readings.controller.ts
//
// Phase 16: thin handlers for /api/v1/meters/:meterId/readings.

import type { RequestHandler, } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import { resolvePartiesForMeter } from './meters.service';
import {
  type CreateReadingInput,
  type MeterIdParams,
  toCreateReadingServiceInput,
} from './readings.schemas';
import { createReading, listReadingsForMeter } from './readings.service';

/**
 * `requireMeterParty` middleware — caller must be a party to the
 * meter (owner of property OR tenant on active lease OR ADMIN).
 * 404 if meter doesn't exist (no existence leak).
 */
export const requireMeterParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const { meterId } = req.params as unknown as MeterIdParams;
    const parties = await resolvePartiesForMeter(meterId);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Meter not found');
    }
    const isParty =
      parties.ownerId === req.user.id ||
      parties.tenantIds.includes(req.user.id);
    if (!isParty) {
      throw new ForbiddenError(
        'NOT_OWNER',
        'Caller is not a party to this meter'
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const createReadingHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { meterId } = req.params as unknown as MeterIdParams;
  const body = req.body as CreateReadingInput;
  const serviceInput = toCreateReadingServiceInput(meterId, body);
  const data = await createReading(userId, {
    meterId: serviceInput.meterId,
    readingDate: serviceInput.readingDate,
    readingValue: serviceInput.readingValue,
    notes: serviceInput.notes,
  });
  res.status(201).json(ok(data, 'Reading created'));
});

export const listReadingsHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { meterId } = req.params as unknown as MeterIdParams;
  const limitRaw = req.query.limit;
  const limit =
    typeof limitRaw === 'string' && limitRaw.length > 0 && !Number.isNaN(Number(limitRaw))
      ? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 100)
      : 20;
  const cursorRaw = req.query.cursor;
  const cursor =
    typeof cursorRaw === 'string' && cursorRaw.length > 0 ? cursorRaw : null;
  const data = await listReadingsForMeter(userId, meterId, limit, cursor);
  res.status(200).json(ok(data, 'Readings retrieved'));
});
