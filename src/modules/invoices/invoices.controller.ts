// src/modules/invoices/invoices.controller.ts
//
// Thin handlers + `requireInvoiceParty` middleware for
// /api/v1/invoices/*. Pattern mirrors leases.controller.ts.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import type { AppRole } from '@/middleware/auth';
import type {
  DisputeInvoiceInput,
  InvoiceIdParams,
  WaiveInvoiceInput,
} from './invoices.schemas';
import {
  disputeInvoice,
  generateInvoiceForLease,
  getInvoice,
  listInvoicesForCaller,
  resolvePartiesForInvoice,
  waiveInvoice,
} from './invoices.service';

// ──────────────────────────────────────────────────────────────────────
// Middleware: invoice-party membership
// ──────────────────────────────────────────────────────────────────────

/**
 * Allows access if the caller is ADMIN, OR the lease owner, OR
 * any tenant party (primary or co-tenant). Surfaces 404 (not 403)
 * when the invoice doesn't exist so existence isn't leaked to a
 * non-party who guessed an ID.
 */
export const requireInvoiceParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const id = (req.params as unknown as InvoiceIdParams).id;
    const parties = await resolvePartiesForInvoice(id);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Invoice not found');
    }
    const callerId = req.user.id;
    if (parties.ownerId !== callerId && !parties.tenantIds.includes(callerId)) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this invoice');
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

export const listInvoicesHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const limit = 20;
  const cursorRaw = req.query.cursor;
  const cursor =
    typeof cursorRaw === 'string' && cursorRaw.length > 0 ? cursorRaw : null;
  const data = await listInvoicesForCaller(userId, limit, cursor);
  res.status(200).json(ok(data, 'Invoices retrieved'));
});

export const getInvoiceHandler: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as InvoiceIdParams;
  const data = await getInvoice(id);
  res.status(200).json(ok(data, 'Invoice retrieved'));
});

export const waiveInvoiceHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as InvoiceIdParams;
  const body = req.body as WaiveInvoiceInput;
  const data = await waiveInvoice(userId, id, body);
  res.status(200).json(ok(data, 'Invoice waived'));
});

export const disputeInvoiceHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles as AppRole[];
  const { id } = req.params as unknown as InvoiceIdParams;
  const body = req.body as DisputeInvoiceInput;
  const data = await disputeInvoice(userId, roles, id, body);
  res.status(200).json(ok(data, 'Invoice disputed'));
});

// Re-export the bills handler so the bills router (or any other
// facade route) can mount POST /bills/generate via the same logic.
export { generateInvoiceForLease };
