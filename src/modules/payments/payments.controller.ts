// src/modules/payments/payments.controller.ts
//
// Thin handlers + `requirePaymentParty` middleware for
// /api/v1/payments/*. Pattern mirrors invoices.controller.ts.
//
// Webhook handler (`stripeWebhookHandler`) is exported separately so
// the server can mount it on the bare app, BEFORE the authenticated
// rate limiter and BEFORE the body-parser's normal JSON parse (the
// handler reads req.rawBody directly).

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import type { AppRole } from '@/middleware/auth';
import type Stripe from 'stripe';

import type {
  IntentInput,
  PaymentIdParams,
  RefundPaymentInput,
} from './payments.schemas';
import {
  clearWebhookDedup,
  createPaymentIntent,
  getPayment,
  handleChargeRefunded,
  handleIntentCanceled,
  handleIntentFailed,
  handleIntentSucceeded,
  listPaymentsForCaller,
  refundPayment,
  resolvePartiesForPayment,
  verifyAndDedupWebhookEvent,
} from './payments.service';

// ──────────────────────────────────────────────────────────────────────
// Middleware: payment-party membership
// ──────────────────────────────────────────────────────────────────────

/**
 * Allows access if the caller is ADMIN, OR the lease owner, OR any
 * tenant party (primary or co-tenant). Surfaces 404 (not 403) when
 * the payment doesn't exist so existence isn't leaked to a non-party
 * who guessed an ID.
 *
 * Mirrors `requireInvoiceParty` in invoices.controller.ts.
 */
export const requirePaymentParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const id = (req.params as unknown as PaymentIdParams).id;
    const parties = await resolvePartiesForPayment(id);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Payment not found');
    }
    const callerId = req.user.id;
    if (parties.ownerId !== callerId && !parties.tenantIds.includes(callerId)) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this payment');
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ──────────────────────────────────────────────────────────────────────
// Handlers (auth-gated router)
// ──────────────────────────────────────────────────────────────────────

export const intentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as IntentInput;
  const result = await createPaymentIntent(userId, body);
  // 201 Created — a new resource (the PaymentIntent record) was made.
  res.status(201).json(
    ok(
      {
        payment: result.payment,
        clientSecret: result.clientSecret,
      },
      'Payment intent created'
    )
  );
});

export const listPaymentsHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const limitRaw = req.query.limit;
  const limit =
    typeof limitRaw === 'string' && limitRaw.length > 0 && !Number.isNaN(Number(limitRaw))
      ? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 100)
      : 20;
  const cursorRaw = req.query.cursor;
  const cursor =
    typeof cursorRaw === 'string' && cursorRaw.length > 0 ? cursorRaw : null;
  const data = await listPaymentsForCaller(userId, limit, cursor);
  res.status(200).json(ok(data, 'Payments retrieved'));
});

export const getPaymentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = req.params as unknown as PaymentIdParams;
  const data = await getPayment(id);
  res.status(200).json(ok(data, 'Payment retrieved'));
});

export const refundPaymentHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const _roles = req.user!.roles as AppRole[];
  const { id } = req.params as unknown as PaymentIdParams;
  const body = req.body as RefundPaymentInput;
  const result = await refundPayment(userId, id, body);
  res.status(202).json(
    ok(
      {
        payment: result.payment,
        refundId: result.refundId,
        note: 'Refund requested. Status update arrives via webhook.',
      },
      'Refund requested'
    )
  );
});

// ──────────────────────────────────────────────────────────────────────
// Webhook handler — mounted at app.use top-level in server.ts
// ──────────────────────────────────────────────────────────────────────

/**
 * Stripe webhook receiver. NO auth, NO rate limit. Signature-gated only.
 *
 * Mounted BEFORE global `express.json` body-parse would mutate the
 * payload — but we don't actually need that: the global
 * `express.json({ verify })` already captures `req.rawBody` as utf-8
 * (see server.ts:64-72), and we read THAT directly. No per-route
 * `express.raw()` needed.
 */
export const stripeWebhookHandler: RequestHandler = async (req, res, next) => {
  try {
    // 1. Pull raw body + signature.
    const rawBody = (req as { rawBody?: string }).rawBody;
    const signature = req.header('stripe-signature');
    if (!rawBody || rawBody.length === 0) {
      throw new ConflictError(
        'CONFLICT',
        'Webhook requires raw body (express.json verify must capture rawBody)'
      );
    }
    if (!signature) {
      throw new ConflictError('CONFLICT', 'Missing stripe-signature header');
    }

    // 2. Verify signature + check dedup.
    let event: Stripe.Event;
    let deduped = false;
    try {
      const result = await verifyAndDedupWebhookEvent({ rawBody, signature });
      event = result.event;
      deduped = result.deduped;
    } catch (err) {
      // Signature / stale / decode failure — return 400, no retry by Stripe.
      logger.warn({ err: (err as Error).message }, 'stripe_signature_failed');
      res.status(400).json({
        success: false,
        message: 'Invalid webhook signature',
        errors: [{ field: 'stripe-signature', code: 'INVALID', message: (err as Error).message }],
      });
      return;
    }

    if (deduped) {
      // Already processed — acknowledge so Stripe stops retrying.
      res.status(200).json(ok({ received: true, deduped: true }, 'Duplicate event ignored'));
      return;
    }

    // 3. Dispatch by event type. Unknown types → ack 200 so Stripe
    // doesn't retry events we don't care about.
    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await handleIntentSucceeded(event);
          break;
        case 'payment_intent.payment_failed':
          await handleIntentFailed(event);
          break;
        case 'payment_intent.canceled':
          await handleIntentCanceled(event);
          break;
        case 'charge.refunded':
          await handleChargeRefunded(event);
          break;
        default:
          logger.info({ type: event.type, id: event.id }, 'unhandled_stripe_event');
          break;
      }
      res.status(200).json(ok({ received: true, eventType: event.type }, 'Webhook processed'));
    } catch (err) {
      // Transient error (DB blip, etc.) — clear dedup so Stripe's retry
      // can re-enter the handler. Then propagate to error handler so
      // the client sees 500.
      logger.error({ err, eventType: event.type, eventId: event.id }, 'webhook_handler_error');
      await clearWebhookDedup(event.id);
      next(err);
    }
  } catch (err) {
    next(err);
  }
};
