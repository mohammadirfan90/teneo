// src/modules/bills/bills.controller.ts
//
// Phase 14: thin handler. All real work lives in invoices.service.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ok } from '@/lib/envelope';

import type { GenerateBillInput } from './bills.schemas';
import { toGenerateBillServiceInput } from './bills.schemas';
import { generateInvoiceForLease } from '../invoices/invoices.service';

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
  const data = await generateInvoiceForLease(userId, toGenerateBillServiceInput(body));
  res.status(201).json(ok(data, 'Bill generated'));
});