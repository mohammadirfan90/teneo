// src/modules/payments/payments.routes.ts
//
// Routes for /api/v1/payments/* — mounted under /api/v1/payments in
// server.ts.
//
// Phase 15 endpoints:
//   POST  /stripe/intent          TENANT only
//   GET   /me                     TENANT (own payments)
//   GET   /:id                    party-or-admin
//   POST  /:id/refund             ADMIN only
//
// The Stripe webhook (POST /stripe/webhook) is mounted at app.use
// top-level in server.ts — NOT inside this router — so it bypasses
// the per-role rate limiter and requireAuth.

import { Router } from 'express';

import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';

import {
  getPaymentHandler,
  intentHandler,
  listPaymentsHandler,
  refundPaymentHandler,
  requirePaymentParty,
} from './payments.controller';
import {
  intentSchema,
  paymentIdParamsSchema,
  paymentListQuerySchema,
  refundPaymentSchema,
} from './payments.schemas';

export function paymentsRouter(): Router {
  const r = Router();

  // POST /payments/stripe/intent — TENANT creates a PaymentIntent.
  // Order: auth → role → zodValidate(body) → withIdempotency → handler.
  // withIdempotency AFTER zodValidate so the body is parsed into JSON
  // BEFORE the body-hash for the idempotency key is computed.
  r.post(
    '/stripe/intent',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ body: intentSchema }),
    withIdempotency,
    asyncHandler(intentHandler)
  );

  // GET /payments/me — caller sees own payments (TENANT per spec).
  r.get(
    '/me',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ query: paymentListQuerySchema }),
    asyncHandler(listPaymentsHandler)
  );

  // GET /payments/:id — any party or ADMIN.
  r.get(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: paymentIdParamsSchema }),
    requirePaymentParty,
    asyncHandler(getPaymentHandler)
  );

  // POST /payments/:id/refund — ADMIN only.
  r.post(
    '/:id/refund',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ params: paymentIdParamsSchema, body: refundPaymentSchema }),
    withIdempotency,
    asyncHandler(refundPaymentHandler)
  );

  return r;
}
