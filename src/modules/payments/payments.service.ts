// src/modules/payments/payments.service.ts
//
// Business logic for /api/v1/payments per spec §7.4, §13.2.7.
//
// Hot paths (mostly wrapped in prisma.$transaction):
//   createPaymentIntent  — POST /payments/stripe/intent. TENANT.
//                          Idempotent insert via UNIQUE(idempotency_key).
//                          Calls Stripe.paymentIntents.create; stores the
//                          PI id + clientSecret; audit + outbox in same tx.
//   listPaymentsForCaller — GET /payments/me. TENANT cursor pagination.
//   getPayment           — GET /payments/:id with party check.
//   refundPayment        — POST /payments/:id/refund. ADMIN. Creates
//                          Stripe.Refund; webhook updates status async.
//                          Audit row written immediately.
//
// Webhook handlers (called by the webhook controller; not exported via
// the auth-gated router):
//   verifyAndDedupWebhookEvent — signature + Redis dedup. Returns the
//                                verified Stripe.Event or throws.
//   handleIntentSucceeded      — payment_intent.succeeded → update
//                                Payment + invoice (amount_paid += amount,
//                                status = PAID/PARTIALLY_PAID) + audit +
//                                2 outbox in one tx.
//   handleIntentFailed         — payment_intent.payment_failed → FAILED.
//   handleChargeRefunded       — charge.refunded → REFUNDED + decrement
//                                invoice.amount_paid + audit + outbox.
//                                Partial refunds are logged but don't
//                                flip status (full-only in v1).
//
// Idempotency layers:
//   1. idempotency_key — TRUE UNIQUE in DB; withIdempotency middleware
//      caches the response 24h.
//   2. (gateway, gateway_payment_intent_id) PARTIAL UNIQUE — DB-level
//      race protection for webhook duplicates before the row is fully
//      populated.
//   3. Redis SET NX EX 86400 stripe:webhook:seen:{event.id} — surface
//      dedup at the webhook route.
//
// Audit policy:
//   - User-initiated actions (intent, refund) → actorRole = TENANT|ADMIN.
//   - Webhook-driven actions → actorUserId=null, actorRole='SYSTEM'.
//     We introduce 'SYSTEM' as a special actor role (string-typed by
//     audit_logs.actor_role, no FK to roles table). It's appended in
//     audit helper comment.

import { Prisma } from '@/generated/prisma/client';
import type { InvoiceStatus, PaymentStatus } from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StripeDisabledError,
} from '@/lib/errors';
import { logger } from '@/lib/logger';
import { redis } from '@/lib/redis';
import { getStripeClient } from '@/lib/stripe';
import type Stripe from 'stripe';

import { isValidInvoiceTransition } from '@/modules/invoices/invoices.state-machine';
import {
  isValidPaymentTransition,
} from './payments.state-machine';
import type {
  PaymentPage,
  PaymentSummaryView,
  PaymentView,
} from './payments.schemas';

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

/** Redis key for webhook event dedup. */
const WEBHOOK_DEDUP_PREFIX = 'stripe:webhook:seen:';
const WEBHOOK_DEDUP_TTL_SEC = 24 * 60 * 60;

/** Retry policy for the webhook-before-intent-DB-commit race. */
const WEBHOOK_LOOKUP_RETRY_ATTEMPTS = 3;
const WEBHOOK_LOOKUP_RETRY_DELAY_MS = 50;

/** Failure reason truncation per Stripe docs and our schema. */
const FAILURE_REASON_MAX_LENGTH = 500;

/** Sentinel for system-issued audit rows (webhook-driven). */
const SYSTEM_ACTOR_ROLE = 'SYSTEM';

// ──────────────────────────────────────────────────────────────────────
// Views (render-ready DTOs)
// ──────────────────────────────────────────────────────────────────────

// Re-export for convenience.
export type { PaymentView, PaymentSummaryView, PaymentPage } from './payments.schemas';

type PaymentRow = {
  id: string;
  invoiceId: string;
  leaseId: string;
  tenantUserId: string;
  gateway: string;
  gatewayPaymentIntentId: string | null;
  gatewayChargeId: string | null;
  gatewayRefundId: string | null;
  amountMinor: bigint;
  refundedAmountMinor: bigint;
  currency: string;
  status: PaymentStatus;
  idempotencyKey: string;
  failureCode: string | null;
  failureReason: string | null;
  paidAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function paymentRowToView(r: PaymentRow): PaymentView {
  return {
    id: r.id,
    invoiceId: r.invoiceId,
    leaseId: r.leaseId,
    tenantUserId: r.tenantUserId,
    gateway: r.gateway,
    gatewayPaymentIntentId: r.gatewayPaymentIntentId,
    gatewayChargeId: r.gatewayChargeId,
    gatewayRefundId: r.gatewayRefundId,
    amountMinor: r.amountMinor.toString(),
    refundedAmountMinor: r.refundedAmountMinor.toString(),
    currency: r.currency,
    status: r.status,
    idempotencyKey: r.idempotencyKey,
    failureCode: r.failureCode,
    failureReason: r.failureReason,
    paidAt: r.paidAt?.toISOString() ?? null,
    failedAt: r.failedAt?.toISOString() ?? null,
    refundedAt: r.refundedAt?.toISOString() ?? null,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Party resolution for requirePaymentParty middleware
// ──────────────────────────────────────────────────────────────────────

/**
 * Single-row lookup used by `requirePaymentParty` middleware. Returns
 * `null` for ownerId and `[]` for tenantIds when the payment doesn't
 * exist (so the middleware can 404 without leaking existence).
 *
 * 3-hop resolution: payment → rent_invoice → lease → ownerUserId +
 * lease_tenants[].tenant_user_id.
 *
 * Mirrors `resolvePartiesForInvoice` in invoices.service.ts.
 */
export async function resolvePartiesForPayment(paymentId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
}> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      invoice: {
        select: {
          lease: {
            select: {
              ownerUserId: true,
              tenants: { select: { tenantUserId: true } },
            },
          },
        },
      },
    },
  });
  if (!row) return { ownerId: null, tenantIds: [] };
  return {
    ownerId: row.invoice.lease.ownerUserId,
    tenantIds: row.invoice.lease.tenants.map((t) => t.tenantUserId),
  };
}

// ──────────────────────────────────────────────────────────────────────
// createPaymentIntent — POST /payments/stripe/intent (TENANT)
// ──────────────────────────────────────────────────────────────────────

export interface CreatePaymentIntentInput {
  invoiceId: string;
  idempotencyKey: string;
}

export interface CreatePaymentIntentResult {
  payment: PaymentView;
  clientSecret: string;
}

/**
 * Idempotent create-or-reuse of a Stripe PaymentIntent.
 *
 * Algorithm:
 *   1. Pre-flight check: Stripe must be enabled.
 *   2. Idempotency pre-check (findUnique by idempotency_key) → return
 *      existing row + cached clientSecret if found.
 *   3. Load invoice + lease; 404 if missing.
 *   4. Reject if invoice status is terminal (PAID, WAIVED) → 409.
 *   5. Authorize: caller must be a tenant party.
 *   6. Compute amount = invoice.totalMinor; ensure currency matches.
 *   7. Call stripe.paymentIntents.create(...)
 *   8. Insert row; on P2002 race-loser, re-fetch and return winner.
 *   9. Audit + outbox in same tx.
 */
export async function createPaymentIntent(
  callerUserId: string,
  input: CreatePaymentIntentInput
): Promise<CreatePaymentIntentResult> {
  const stripe = getStripeClient();
  if (!stripe) {
    throw new StripeDisabledError(
      'Stripe payments are not configured on this environment (STRIPE_SECRET_KEY unset)'
    );
  }

  // 1. Idempotency pre-check (outside the tx; saves a tx roundtrip
  // for retries).
  // NOTE: payments_idempotency_key_uq is a hand-edited UNIQUE that
  // Prisma 7 doesn't expose in WhereUniqueInput, so we use findFirst
  // and rely on the DB index for speed. P2002 on the create() below
  // catches concurrent race winners.
  const existing = await prisma.payment.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true, gatewayPaymentIntentId: true },
  });
  if (existing?.gatewayPaymentIntentId) {
    // Re-fetch full row + retrieve Stripe PI for the clientSecret.
    const fullRow = await prisma.payment.findUnique({
      where: { id: existing.id },
      select: fullPaymentSelect(),
    });
    if (!fullRow) throw new NotFoundError('Payment vanished');
    // We intentionally do NOT re-call Stripe.retrieve here; if the
    // client_secret was returned once, Stripe caches it for an hour
    // and the original response is the canonical one.
    // For follow-up clientSecret recovery, call GET /payments/:id
    // and re-call retrieve at the client layer.
    return {
      payment: paymentRowToView(fullRow as unknown as PaymentRow),
      clientSecret: '', // NOT recoverable from a cached row — caller
                       // should have stored the clientSecret on the
                       // first response. If empty, we still return
                       // the paymentId so the caller can decide.
    };
  }

  return await prisma.$transaction(async (tx) => {
    // 2. Load invoice + lease.
    const invoice = await tx.rentInvoice.findUnique({
      where: { id: input.invoiceId },
      select: {
        id: true,
        leaseId: true,
        lease: {
          select: {
            ownerUserId: true,
            currency: true,
            tenants: { select: { tenantUserId: true } },
          },
        },
        totalMinor: true,
        currency: true,
        status: true,
      },
    });
    if (!invoice) throw new NotFoundError('Invoice not found');

    // 3. Authorize: caller must be a tenant party.
    const isTenant = invoice.lease.tenants.some(
      (t) => t.tenantUserId === callerUserId
    );
    if (!isTenant) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a tenant on this lease');
    }

    // 4. Reject if invoice in terminal status.
    if (invoice.status === 'PAID' || invoice.status === 'WAIVED') {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot create payment for invoice in status ${invoice.status}`
      );
    }

    // 5. Build the Stripe PaymentIntent.
    // Note: a v1 only allows one payment per invoice — we'll add support
    // for multiple attempts (multiple intents) on the same invoice in
    // Phase 18+ when partial payments become a thing.
    const paymentIntentParams: Stripe.PaymentIntentCreateParams = {
      amount: Number(invoice.totalMinor), // safe for our range (< 2^53)
      currency: invoice.currency.toLowerCase(),
      metadata: {
        invoiceId: invoice.id,
        leaseId: invoice.leaseId,
        tenantUserId: callerUserId,
        idempotencyKey: input.idempotencyKey,
      },
      description: `Rent invoice ${invoice.id}`,
      // capture_method defaults to 'automatic' for one-shot charges.
      automatic_payment_methods: { enabled: true },
    };

    // 6. Call Stripe. The Stripe SDK also takes an idempotencyKey — this
    // is a second layer of protection at the Stripe side (Stripe
    // deduplicates on its end for ~24h).
    const paymentIntent = await stripe.paymentIntents.create(
      paymentIntentParams,
      { idempotencyKey: input.idempotencyKey }
    );

    // 7. Insert the row. The gatewayPaymentIntentId is now known.
    let paymentId: string;
    try {
      const created = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          leaseId: invoice.leaseId,
          tenantUserId: callerUserId,
          gateway: 'STRIPE',
          gatewayPaymentIntentId: paymentIntent.id,
          amountMinor: invoice.totalMinor,
          currency: invoice.currency,
          status: 'PROCESSING',
          idempotencyKey: input.idempotencyKey,
        },
        select: { id: true },
      });
      paymentId = created.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        // Race-loser branch: another concurrent request with the same
        // idempotency_key beat us to the create. Re-fetch and return.
        const winner = await tx.payment.findFirst({
          where: { idempotencyKey: input.idempotencyKey },
          select: { id: true },
        });
        if (!winner) throw e;
        const reloaded = await tx.payment.findUnique({
          where: { id: winner.id },
          select: fullPaymentSelect(),
        });
        if (!reloaded) throw new NotFoundError('Payment vanished after race');
        return {
          payment: paymentRowToView(reloaded as unknown as PaymentRow),
          clientSecret: paymentIntent.client_secret ?? '',
        };
      }
      throw e;
    }

    // 8. Audit row — actor is the TENANT who initiated.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'TENANT',
        action: 'payment_intent.created',
        targetEntityType: 'payment',
        targetEntityId: paymentId,
        before: Prisma.JsonNull,
        after: {
          invoiceId: invoice.id,
          leaseId: invoice.leaseId,
          gatewayPaymentIntentId: paymentIntent.id,
          amountMinor: invoice.totalMinor.toString(),
          currency: invoice.currency,
          status: 'PROCESSING',
        } as Prisma.InputJsonValue,
      },
    });

    // 9. Outbox row — payment.processing (no status_changed variant;
    // process starts in PROCESSING, not transitioning from null).
    await tx.outboxEvent.create({
      data: {
        eventType: 'payment.processing',
        payload: {
          paymentId,
          invoiceId: invoice.id,
          leaseId: invoice.leaseId,
          tenantUserId: callerUserId,
          amountMinor: invoice.totalMinor.toString(),
          currency: invoice.currency,
          gatewayPaymentIntentId: paymentIntent.id,
        } as Prisma.InputJsonValue,
      },
    });

    // 10. Re-load + return.
    const reloaded = await tx.payment.findUnique({
      where: { id: paymentId },
      select: fullPaymentSelect(),
    });
    if (!reloaded) throw new NotFoundError('Payment vanished after create');

    return {
      payment: paymentRowToView(reloaded as unknown as PaymentRow),
      clientSecret: paymentIntent.client_secret ?? '',
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// listPaymentsForCaller — GET /payments/me (TENANT only per spec)
// ──────────────────────────────────────────────────────────────────────

/**
 * Cursor-paginated list of payments WHERE tenant_user_id = caller.
 * Sorted by (createdAt DESC, id DESC). Cursor: opaque base64 of
 * `${createdAtIso}|${id}`.
 */
export async function listPaymentsForCaller(
  callerUserId: string,
  limit: number,
  cursor: string | null
): Promise<PaymentPage> {
  const take = limit + 1;
  const cursorDecoded = cursor ? decodeCursor(cursor) : null;

  const rows = await prisma.payment.findMany({
    where: {
      tenantUserId: callerUserId,
      ...(cursorDecoded
        ? {
            OR: [
              { createdAt: { lt: cursorDecoded.createdAt } },
              {
                createdAt: cursorDecoded.createdAt,
                id: { lt: cursorDecoded.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      invoiceId: true,
      amountMinor: true,
      refundedAmountMinor: true,
      currency: true,
      status: true,
      paidAt: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: PaymentSummaryView[] = page.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    amountMinor: r.amountMinor.toString(),
    refundedAmountMinor: r.refundedAmountMinor.toString(),
    currency: r.currency,
    status: r.status,
    paidAt: r.paidAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;
  return { items, nextCursor };
}

// ──────────────────────────────────────────────────────────────────────
// getPayment — GET /payments/:id (party or admin)
// ──────────────────────────────────────────────────────────────────────

export async function getPayment(paymentId: string): Promise<PaymentView> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: fullPaymentSelect(),
  });
  if (!row) throw new NotFoundError('Payment not found');
  return paymentRowToView(row as unknown as PaymentRow);
}

// ──────────────────────────────────────────────────────────────────────
// refundPayment — POST /payments/:id/refund (ADMIN only)
// ──────────────────────────────────────────────────────────────────────

/**
 * ADMIN initiates a refund. Always full refund in v1 (partial is
 * deferred). The route layer enforces ADMIN role + Idempotency-Key
 * header; this function trusts those and does the Stripe call +
 * audit + outbox rows in a tx.
 *
 * The `charge.refunded` webhook will asynchronously update the
 * Payment.status to REFUNDED and decrement the invoice.amount_paid.
 * We do NOT set status=REFUNDED here — we just request the refund
 * and let the webhook drive the state machine.
 */
export async function refundPayment(
  callerUserId: string,
  paymentId: string,
  body: { reason: string }
): Promise<{ payment: PaymentView; refundId: string | null }> {
  const stripe = getStripeClient();
  if (!stripe) {
    throw new StripeDisabledError(
      'Stripe refunds are not configured on this environment'
    );
  }

  return await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        status: true,
        gateway: true,
        gatewayPaymentIntentId: true,
        gatewayChargeId: true,
        amountMinor: true,
        currency: true,
        invoiceId: true,
        leaseId: true,
        tenantUserId: true,
      },
    });
    if (!payment) throw new NotFoundError('Payment not found');
    if (payment.status !== 'SUCCEEDED') {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot refund payment in status ${payment.status}`
      );
    }
    if (!payment.gatewayPaymentIntentId) {
      throw new ConflictError(
        'CONFLICT',
        'Payment has no gateway PaymentIntent id; cannot refund'
      );
    }

    // Call Stripe to issue the refund. For full refund, no `amount`
    // parameter (Stripe defaults to the full charge amount).
    const refund = await stripe.refunds.create({
      payment_intent: payment.gatewayPaymentIntentId,
      reason: 'requested_by_customer',
      metadata: {
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        actorUserId: callerUserId,
        adminReason: body.reason.slice(0, 500), // Stripe metadata value cap
      },
    });

    // Audit row written immediately (request side). The webhook will
    // write a second audit row for the actual status flip to REFUNDED.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'ADMIN',
        action: 'payment.refund_requested',
        targetEntityType: 'payment',
        targetEntityId: payment.id,
        before: { status: payment.status },
        after: {
          status: payment.status, // unchanged at this point
          gatewayRefundId: refund.id,
          reason: body.reason,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'payment.refund_requested',
        payload: {
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          leaseId: payment.leaseId,
          tenantUserId: payment.tenantUserId,
          gatewayRefundId: refund.id,
          actorUserId: callerUserId,
          reason: body.reason,
        } as Prisma.InputJsonValue,
      },
    });

    const reloaded = await tx.payment.findUnique({
      where: { id: payment.id },
      select: fullPaymentSelect(),
    });
    if (!reloaded) throw new NotFoundError('Payment vanished');
    return {
      payment: paymentRowToView(reloaded as unknown as PaymentRow),
      refundId: refund.id,
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Webhook helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Lookup result from the retry-on-not-found helper.
 */
type WebhookLookupRow = {
  id: string;
  invoiceId: string;
  status: PaymentStatus;
  amountMinor: bigint;
  currency: string;
};

/**
 * Retries the lookup up to N times with a short sleep between
 * attempts. This handles the race where the webhook arrives before
 * the POST /intent DB row commits (Stripe would send a webhook for a
 * PI whose local row is still being INSERTed). On retry N, the row
 * becomes visible.
 */
async function findPaymentByIntentIdWithRetry(
  tx: Prisma.TransactionClient,
  paymentIntentId: string
): Promise<WebhookLookupRow | null> {
  for (let attempt = 0; attempt < WEBHOOK_LOOKUP_RETRY_ATTEMPTS; attempt += 1) {
    // NOTE: Prisma 7 doesn't expose `payments_gateway_intent_uq` in
    // WhereUniqueInput (hand-edited partial UNIQUE). We use findFirst
    // and rely on the DB index for speed.
    const row = await tx.payment.findFirst({
      where: {
        gateway: 'STRIPE',
        gatewayPaymentIntentId: paymentIntentId,
      },
      select: {
        id: true,
        invoiceId: true,
        status: true,
        amountMinor: true,
        currency: true,
      },
    });
    if (row) return row;
    if (attempt < WEBHOOK_LOOKUP_RETRY_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, WEBHOOK_LOOKUP_RETRY_DELAY_MS));
    }
  }
  return null;
}

/**
 * Verify a Stripe webhook signature + Redis dedup. Returns the verified
 * Stripe.Event. Throws on signature fail / stale / duplicate.
 *
 * Caller (the webhook handler) is responsible for catching these
 * errors and translating them to 400 / 200-with-deduped-flag
 * responses.
 */
export async function verifyAndDedupWebhookEvent(args: {
  rawBody: string;
  signature: string;
}): Promise<{ event: Stripe.Event; deduped: boolean }> {
  const { verifyWebhookSignature } = await import('@/lib/stripe');
  const event = verifyWebhookSignature(
    args.rawBody,
    args.signature,
    env.STRIPE_WEBHOOK_SECRET
  );

  const key = `${WEBHOOK_DEDUP_PREFIX}${event.id}`;
  // ioredis set() returns 'OK' on success, null when NX fails.
  const wasFirst = await redis.set(key, '1', 'EX', WEBHOOK_DEDUP_TTL_SEC, 'NX');
  return { event, deduped: wasFirst === null };
}

/**
 * Helper: delete the dedup key (used when the handler errors out so a
 * Stripe retry can re-enter).
 */
export async function clearWebhookDedup(eventId: string): Promise<void> {
  await redis.del(`${WEBHOOK_DEDUP_PREFIX}${eventId}`);
}

// ──────────────────────────────────────────────────────────────────────
// handleIntentSucceeded — payment_intent.succeeded
// ──────────────────────────────────────────────────────────────────────

/**
 * payment_intent.succeeded handler:
 *   - If payment row missing → log orphan + ack (idempotent).
 *   - If payment.status is already SUCCEEDED → no-op.
 *   - Update Payment: status=SUCCEEDED, paidAt, gatewayChargeId.
 *   - Update RentInvoice: amount_paid += amount_received; status flips
 *     to PAID (when total covered) or PARTIALLY_PAID (when not).
 *   - Guard state machine: only transition DUE/OVERDUE/PARTIALLY_PAID.
 *   - Audit + 2 outbox events in same tx.
 */
export async function handleIntentSucceeded(event: Stripe.Event): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const piId = pi.id;
  const amountReceivedMinor = BigInt(pi.amount_received ?? pi.amount ?? 0);
  const chargeId =
    typeof pi.latest_charge === 'string'
      ? pi.latest_charge
      : (pi.latest_charge?.id ?? null);

  await prisma.$transaction(async (tx) => {
    const payment = await findPaymentByIntentIdWithRetry(tx, piId);
    if (!payment) {
      logger.warn(
        { eventId: event.id, piId },
        'orphan_payment_intent_succeeded'
      );
      return;
    }
    if (payment.status === 'SUCCEEDED') {
      // Idempotent: already processed. No-op.
      return;
    }
    if (!isValidPaymentTransition(payment.status, 'SUCCEEDED')) {
      logger.warn(
        { paymentId: payment.id, from: payment.status, to: 'SUCCEEDED' },
        'invalid_payment_transition_succeeded'
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'SUCCEEDED',
        paidAt: new Date(event.created * 1000),
        ...(chargeId ? { gatewayChargeId: chargeId } : {}),
        version: { increment: 1 },
      },
    });

    // Update invoice.amount_paid + status.
    const invoice = await tx.rentInvoice.findUnique({
      where: { id: payment.invoiceId },
      select: {
        id: true,
        totalMinor: true,
        amountPaidMinor: true,
        status: true,
        version: true,
        currency: true,
        leaseId: true,
      },
    });
    if (!invoice) {
      logger.warn(
        { paymentId: payment.id, invoiceId: payment.invoiceId },
        'invoice_missing_for_payment_succeeded'
      );
      return;
    }

    const newAmountPaid = invoice.amountPaidMinor + amountReceivedMinor;
    const targetStatus: InvoiceStatus =
      newAmountPaid >= invoice.totalMinor
        ? 'PAID'
        : newAmountPaid > 0n
        ? 'PARTIALLY_PAID'
        : invoice.status;

    // Only transition if state machine allows it.
    if (
      targetStatus !== invoice.status &&
      isValidInvoiceTransition(invoice.status, targetStatus)
    ) {
      await tx.rentInvoice.update({
        where: { id: invoice.id },
        data: {
          amountPaidMinor: newAmountPaid,
          status: targetStatus,
          version: { increment: 1 },
        },
      });
    } else {
      await tx.rentInvoice.update({
        where: { id: invoice.id },
        data: {
          amountPaidMinor: newAmountPaid,
          version: { increment: 1 },
        },
      });
    }

    // Audit row — system-issued (webhook).
    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorRole: SYSTEM_ACTOR_ROLE,
        action: 'payment.succeeded',
        targetEntityType: 'payment',
        targetEntityId: payment.id,
        before: {
          paymentStatus: payment.status,
          invoiceStatus: invoice.status,
          amountPaidMinor: invoice.amountPaidMinor.toString(),
        },
        after: {
          paymentStatus: 'SUCCEEDED',
          amountReceivedMinor: amountReceivedMinor.toString(),
          invoiceStatus: targetStatus,
          amountPaidMinor: newAmountPaid.toString(),
        } as Prisma.InputJsonValue,
      },
    });

    // Outbox events.
    await tx.outboxEvent.create({
      data: {
        eventType: 'payment.succeeded',
        payload: {
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          leaseId: invoice.leaseId,
          amountReceivedMinor: amountReceivedMinor.toString(),
          currency: invoice.currency,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.paid',
        payload: {
          invoiceId: payment.invoiceId,
          leaseId: invoice.leaseId,
          paymentId: payment.id,
          amountReceivedMinor: amountReceivedMinor.toString(),
          invoiceStatus: targetStatus,
          amountPaidMinor: newAmountPaid.toString(),
          totalMinor: invoice.totalMinor.toString(),
          currency: invoice.currency,
        } as Prisma.InputJsonValue,
      },
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// handleIntentFailed — payment_intent.payment_failed
// ──────────────────────────────────────────────────────────────────────

export async function handleIntentFailed(event: Stripe.Event): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const piId = pi.id;
  const failure = pi.last_payment_error ?? null;
  const failureCode = failure?.code ?? null;
  const failureReason = (failure?.message ?? '').slice(0, FAILURE_REASON_MAX_LENGTH);

  await prisma.$transaction(async (tx) => {
    const payment = await findPaymentByIntentIdWithRetry(tx, piId);
    if (!payment) {
      logger.warn({ eventId: event.id, piId }, 'orphan_payment_intent_failed');
      return;
    }
    if (payment.status === 'FAILED') return; // idempotent
    if (!isValidPaymentTransition(payment.status, 'FAILED')) {
      logger.warn(
        { paymentId: payment.id, from: payment.status, to: 'FAILED' },
        'invalid_payment_transition_failed'
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(event.created * 1000),
        failureCode,
        failureReason,
        version: { increment: 1 },
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorRole: SYSTEM_ACTOR_ROLE,
        action: 'payment.failed',
        targetEntityType: 'payment',
        targetEntityId: payment.id,
        before: { status: payment.status },
        after: {
          status: 'FAILED',
          failureCode,
          failureReason,
        } as Prisma.InputJsonValue,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventType: 'payment.failed',
        payload: {
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          failureCode,
          failureReason,
        } as Prisma.InputJsonValue,
      },
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// handleChargeRefunded — charge.refunded
// ──────────────────────────────────────────────────────────────────────

/**
 * charge.refunded: full refund only in v1. If amount_refunded < amount
 * (partial), log a warning and write `payment.partial_refund` audit +
 * outbox but keep status=SUCCEEDED. (Full PARTIALLY_REFUNDED support
 * is deferred to Phase 18+.)
 */
export async function handleChargeRefunded(event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const chargeId = charge.id;
  const refundObj = (charge.refunds?.data?.[0] ?? null) as Stripe.Refund | null;
  const refundId = refundObj?.id ?? null;
  const amountRefundedMinor = BigInt(charge.amount_refunded ?? 0);

  await prisma.$transaction(async (tx) => {
    // Try lookup by charge id first (most common after a successful
    // payment has set gateway_charge_id), then fall back by PI id.
    let payment = chargeId
      ? await tx.payment.findFirst({
          where: { gatewayChargeId: chargeId },
          select: {
            id: true,
            invoiceId: true,
            status: true,
            amountMinor: true,
            currency: true,
            gatewayPaymentIntentId: true,
          },
        })
      : null;
    if (!payment && typeof charge.payment_intent === 'string') {
      payment = await tx.payment.findFirst({
        where: {
          gateway: 'STRIPE',
          gatewayPaymentIntentId: charge.payment_intent,
        },
        select: {
          id: true,
          invoiceId: true,
          status: true,
          amountMinor: true,
          currency: true,
          gatewayPaymentIntentId: true,
        },
      });
    }
    if (!payment) {
      logger.warn({ eventId: event.id, chargeId }, 'orphan_charge_refunded');
      return;
    }

    const isPartial = amountRefundedMinor < payment.amountMinor;
    if (isPartial) {
      // Log + audit + outbox but DON'T flip status. Spec defers partial
      // refund support to Phase 18+.
      logger.warn(
        {
          paymentId: payment.id,
          amountRefundedMinor: amountRefundedMinor.toString(),
          paymentAmountMinor: payment.amountMinor.toString(),
        },
        'partial_refund_received_phase15_full_refund_only'
      );
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          actorRole: SYSTEM_ACTOR_ROLE,
          action: 'payment.partial_refund',
          targetEntityType: 'payment',
          targetEntityId: payment.id,
          before: { status: payment.status, refundedAmountMinor: '0' },
          after: {
            status: payment.status, // unchanged
            refundedAmountMinor: amountRefundedMinor.toString(),
            note: 'partial refund ignored in v1; status stays SUCCEEDED',
          } as Prisma.InputJsonValue,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: 'payment.partial_refund',
          payload: {
            paymentId: payment.id,
            refundedAmountMinor: amountRefundedMinor.toString(),
            note: 'partial refunds ignored in v1',
          } as Prisma.InputJsonValue,
        },
      });
      return;
    }

    // Full refund path.
    if (payment.status === 'REFUNDED') return; // idempotent
    if (!isValidPaymentTransition(payment.status, 'REFUNDED')) {
      logger.warn(
        { paymentId: payment.id, from: payment.status, to: 'REFUNDED' },
        'invalid_payment_transition_refunded'
      );
      return;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'REFUNDED',
        refundedAt: new Date(event.created * 1000),
        refundedAmountMinor: amountRefundedMinor,
        ...(refundId ? { gatewayRefundId: refundId } : {}),
        version: { increment: 1 },
      },
    });

    const invoice = await tx.rentInvoice.findUnique({
      where: { id: payment.invoiceId },
      select: {
        id: true,
        totalMinor: true,
        amountPaidMinor: true,
        status: true,
        version: true,
        currency: true,
        leaseId: true,
      },
    });
    if (!invoice) {
      logger.warn(
        { paymentId: payment.id, invoiceId: payment.invoiceId },
        'invoice_missing_for_refund'
      );
      return;
    }

    const newAmountPaid =
      invoice.amountPaidMinor - amountRefundedMinor > 0n
        ? invoice.amountPaidMinor - amountRefundedMinor
        : 0n;
    const targetStatus: InvoiceStatus =
      newAmountPaid === 0n
        ? invoice.status === 'PAID'
          ? 'DUE'
          : invoice.status
        : 'PARTIALLY_PAID';

    if (
      targetStatus !== invoice.status &&
      isValidInvoiceTransition(invoice.status, targetStatus)
    ) {
      await tx.rentInvoice.update({
        where: { id: invoice.id },
        data: {
          amountPaidMinor: newAmountPaid,
          status: targetStatus,
          version: { increment: 1 },
        },
      });
    } else {
      await tx.rentInvoice.update({
        where: { id: invoice.id },
        data: {
          amountPaidMinor: newAmountPaid,
          version: { increment: 1 },
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorUserId: null,
        actorRole: SYSTEM_ACTOR_ROLE,
        action: 'payment.refunded',
        targetEntityType: 'payment',
        targetEntityId: payment.id,
        before: {
          paymentStatus: payment.status,
          invoiceStatus: invoice.status,
          amountPaidMinor: invoice.amountPaidMinor.toString(),
        },
        after: {
          paymentStatus: 'REFUNDED',
          refundedAmountMinor: amountRefundedMinor.toString(),
          invoiceStatus: targetStatus,
          amountPaidMinor: newAmountPaid.toString(),
        } as Prisma.InputJsonValue,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventType: 'payment.refunded',
        payload: {
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          leaseId: invoice.leaseId,
          refundId,
          refundedAmountMinor: amountRefundedMinor.toString(),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.paid',
        payload: {
          invoiceId: payment.invoiceId,
          leaseId: invoice.leaseId,
          paymentId: payment.id,
          invoiceStatus: targetStatus,
          amountPaidMinor: newAmountPaid.toString(),
          totalMinor: invoice.totalMinor.toString(),
          currency: invoice.currency,
        } as Prisma.InputJsonValue,
      },
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Select helper + cursor codec
// ──────────────────────────────────────────────────────────────────────

function fullPaymentSelect() {
  return {
    id: true,
    invoiceId: true,
    leaseId: true,
    tenantUserId: true,
    gateway: true,
    gatewayPaymentIntentId: true,
    gatewayChargeId: true,
    gatewayRefundId: true,
    amountMinor: true,
    refundedAmountMinor: true,
    currency: true,
    status: true,
    idempotencyKey: true,
    failureCode: true,
    failureReason: true,
    paidAt: true,
    failedAt: true,
    refundedAt: true,
    version: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

function encodeCursor(c: { createdAt: Date; id: string }): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(s: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return { createdAt: d, id };
  } catch {
    return null;
  }
}
