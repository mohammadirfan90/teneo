// src/modules/applications/viewings.controller.ts
//
// Thin handlers + the two-party ownership middleware for
// /api/v1/viewings/:id (per spec §13.2.5).
//
// Kept separate from applications.controller.ts so route files mount
// under different prefixes (/applications vs /viewings) without
// crossing imports.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import type {
  CancelViewingInput,
  ConfirmViewingInput,
  ViewingIdParams,
} from './applications.schemas';
import {
  cancelViewing,
  confirmViewing,
  getViewing,
  resolvePartiesForViewing,
} from './applications.service';

// ──────────────────────────────────────────────────────────────────────
// Middleware: viewing-party membership
// ──────────────────────────────────────────────────────────────────────

/**
 * Allows access if the caller is ADMIN, OR the property owner, OR
 * the tenant named on the viewing. Surfaces 404 (not 403) when the
 * viewing doesn't exist so existence isn't leaked.
 */
export const requireViewingParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const id = (req.params as unknown as ViewingIdParams).id;
    const parties = await resolvePartiesForViewing(id);
    if (parties.ownerId === null && parties.tenantId === null) {
      throw new NotFoundError('Viewing not found');
    }
    const callerId = req.user.id;
    if (parties.ownerId !== callerId && parties.tenantId !== callerId) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this viewing');
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ──────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────

export const getViewingHandler: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as ViewingIdParams;
  const data = await getViewing(id);
  res.status(200).json(ok(data, 'Viewing retrieved'));
});

export const confirmViewingHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as ViewingIdParams;
  const body = req.body as ConfirmViewingInput;
  const data = await confirmViewing(userId, id, body);
  res.status(200).json(ok(data, 'Viewing confirmed'));
});

export const cancelViewingHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as ViewingIdParams;
  const body = req.body as CancelViewingInput;
  const data = await cancelViewing(userId, id, body);
  res.status(200).json(ok(data, 'Viewing cancelled'));
});
