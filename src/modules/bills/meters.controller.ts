// src/modules/bills/meters.controller.ts
//
// Phase 16: thin handlers for /api/v1/properties/:propertyId/meters.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import { prisma } from '@/lib/db';

import type { CreateMeterInput, PropertyIdParams } from './meters.schemas';
import { createMeter, listMetersForProperty, type CreateMeterInput as CreateMeterServiceInput } from './meters.service';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * `requirePropertyOwner` middleware — caller must be the owner of the
 * property (or ADMIN, which the route's requireRole gate already
 * handled). Returns 404 if the property doesn't exist (no existence
 * leak). Used by both meter create + list.
 */
export const requirePropertyOwner: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) throw new UnauthorizedError('Authentication required');
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const { propertyId } = req.params as unknown as PropertyIdParams;
    const row = await prisma.property.findUnique({
      where: { id: propertyId },
      select: { ownerUserId: true },
    });
    if (!row) throw new NotFoundError('Property not found');
    if (row.ownerUserId !== req.user.id) {
      throw new ForbiddenError(
        'NOT_OWNER',
        'Caller is not the owner of this property'
      );
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const createMeterHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as CreateMeterInput;
  const { propertyId } = req.params as unknown as PropertyIdParams;
  const serviceInput: CreateMeterServiceInput = {
    propertyId,
    utilityType: body.utilityType,
    label: body.label,
    ratePerUnitMinor: body.ratePerUnitMinor,
    currency: body.currency,
    unitLabel: body.unitLabel,
  };
  const data = await createMeter(userId, serviceInput);
  res.status(201).json(ok(data, 'Meter created'));
});

export const listMetersHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const isAdmin = req.user!.roles.includes('ADMIN');
  const { propertyId } = req.params as unknown as PropertyIdParams;
  const data = await listMetersForProperty(userId, propertyId, isAdmin);
  res.status(200).json(ok(data, 'Meters retrieved'));
});
