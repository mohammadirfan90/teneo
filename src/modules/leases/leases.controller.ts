// src/modules/leases/leases.controller.ts
//
// Thin handlers + `requireLeaseParty` middleware for /api/v1/leases/*.
// Pattern mirrors viewings.controller.ts: middleware lives in the
// controller file, route file mounts with the standard `requireAuth +
// requireRole + zodValidate + requireLeaseParty` stack.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import type {
  AmendmentIdParams,
  ConfirmMoveInInput,
  LeaseIdParams,
  ProposeAmendmentInput,
  SignAmendmentInput,
  SignLeaseInput,
  TerminateLeaseInput,
} from './leases.schemas';
import {
  confirmMoveIn,
  getLease,
  getLeaseDocument,
  listLeasesForCaller,
  proposeAmendment,
  resolvePartiesForLease,
  signAmendment,
  signLease,
  terminateLease,
} from './leases.service';

// ──────────────────────────────────────────────────────────────────────
// Middleware: lease-party membership
// ──────────────────────────────────────────────────────────────────────

/**
 * Allows access if the caller is ADMIN, OR the property owner, OR
 * any tenant party (primary or co-tenant) on the lease. Surfaces
 * 404 (not 403) when the lease doesn't exist so existence isn't
 * leaked to a non-party who guessed an ID.
 */
export const requireLeaseParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const id = (req.params as unknown as LeaseIdParams).id;
    const parties = await resolvePartiesForLease(id);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Lease not found');
    }
    const callerId = req.user.id;
    if (parties.ownerId !== callerId && !parties.tenantIds.includes(callerId)) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this lease');
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ──────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────

export const listLeasesHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  // Default limit 20 — keep parity with applications.list query.
  const limit = 20;
  const data = await listLeasesForCaller(userId, limit);
  res.status(200).json(ok(data, 'Leases retrieved'));
});

export const getLeaseHandler: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as LeaseIdParams;
  const data = await getLease(id);
  res.status(200).json(ok(data, 'Lease retrieved'));
});

export const signLeaseHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as LeaseIdParams;
  const body = req.body as SignLeaseInput;
  const data = await signLease(userId, id, body, {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  });
  res.status(200).json(ok(data, 'Lease signed'));
});

export const confirmMoveInHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as LeaseIdParams;
  const body = req.body as ConfirmMoveInInput;
  const data = await confirmMoveIn(userId, id, body);
  res.status(200).json(ok(data, 'Move-in confirmed'));
});

export const terminateLeaseHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as LeaseIdParams;
  const body = req.body as TerminateLeaseInput;
  const data = await terminateLease(userId, id, body);
  res.status(200).json(ok(data, 'Lease terminated'));
});

export const getLeaseDocumentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as LeaseIdParams;
  const data = await getLeaseDocument(id);
  res.status(200).json(ok(data, 'Signed document URL generated'));
});

export const proposeAmendmentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as LeaseIdParams;
  const body = req.body as ProposeAmendmentInput;
  const data = await proposeAmendment(userId, id, body);
  res.status(201).json(ok(data, 'Amendment proposed'));
});

export const signAmendmentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id, aid } = req.params as unknown as AmendmentIdParams;
  const body = req.body as SignAmendmentInput;
  const data = await signAmendment(userId, id, aid, body);
  res.status(200).json(ok(data, 'Amendment signed'));
});
