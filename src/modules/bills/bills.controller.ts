// src/modules/bills/bills.controller.ts
//
// Phase 16 controllers for /api/v1/bills/*:
//   • POST /generate  — extended Phase 14 endpoint, now also produces
//                       utility bills + BillShares + sets
//                       utility_share_minor on the rent invoice.
//   • GET  /me        — list bills for the caller (TENANT sees their
//                       shares; OWNER sees their leases' bills).
//   • GET  /:id       — bill detail with all shares.
//
// `requireBillParty` middleware handles authz (ADMIN bypass + 404-no-
// leak + 403-NOT_OWNER). Mirrors `requireInvoiceParty` /
// `requirePaymentParty` patterns.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import type { GenerateBillInput, BillIdParams } from './bills.schemas';
import { toGenerateBillServiceInput } from './bills.schemas';
import {
  generateBillsForLease,
  getBill,
  listBillsForCaller,
  resolvePartiesForBill,
} from './bills.service';

// ──────────────────────────────────────────────────────────────────────
// Middleware: bill-party membership
// ──────────────────────────────────────────────────────────────────────

/**
 * ADMIN bypass; otherwise caller must be either the lease owner or a
 * tenant who holds a BillShare on this bill. Surfaces 404 (not 403)
 * when the bill doesn't exist so existence isn't leaked to a non-party
 * who guessed an ID.
 */
export const requireBillParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const id = (req.params as unknown as BillIdParams).id;
    const parties = await resolvePartiesForBill(id);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Bill not found');
    }
    const callerId = req.user.id;
    if (parties.ownerId !== callerId && !parties.tenantIds.includes(callerId)) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this bill');
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ──────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export const generateBillHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as GenerateBillInput;
  const data = await generateBillsForLease(userId, toGenerateBillServiceInput(body));
  res.status(201).json(ok(data, 'Bill generated'));
});

export const listBillsHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const limitRaw = req.query.limit;
  const limit =
    typeof limitRaw === 'string' && limitRaw.length > 0 && !Number.isNaN(Number(limitRaw))
      ? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 100)
      : 20;
  const cursorRaw = req.query.cursor;
  const cursor =
    typeof cursorRaw === 'string' && cursorRaw.length > 0 ? cursorRaw : null;
  const data = await listBillsForCaller(userId, limit, cursor);
  res.status(200).json(ok(data, 'Bills retrieved'));
});

export const getBillHandler: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as BillIdParams;
  const data = await getBill(id);
  res.status(200).json(ok(data, 'Bill retrieved'));
});
