// src/modules/invoices/invoices.service.ts
//
// Business logic for /api/v1/invoices per spec §13.2.6, §5.2, §7.9.
//
// Hot paths (all guarded by `prisma.$transaction`):
//   generateInvoiceForLease  — POST /bills/generate facade entrypoint.
//                              Loads lease, validates state, idempotent
//                              insert (UNIQUE(lease_id, period_start)),
//                              computes prorated rent + late fee, writes
//                              audit + 2 outbox events.
//   listInvoicesForCaller    — GET /invoices/me cursor pagination.
//   getInvoice               — GET /invoices/:id with party check.
//   waiveInvoice             — POST /invoices/:id/waive (ADMIN).
//   disputeInvoice           — POST /invoices/:id/dispute (party).
//
// All transitions emit audit + outbox rows in the same tx (pattern
// from Phase 12 applications.service.ts + Phase 13 leases.service.ts).
//
// Pure helpers (prorate, total, late fee) live in rent-calculator.ts
// and are unit-testable in isolation.

import { Prisma } from '@/generated/prisma/client';
import type { InvoiceStatus } from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';

import {
  calculateLateFee,
  monthlyTotal,
  proratedRent,
  type LateFeePolicy,
} from './rent-calculator';
import { isValidInvoiceTransition } from './invoices.state-machine';

// ──────────────────────────────────────────────────────────────────────
// Views (render-ready DTOs)
// ──────────────────────────────────────────────────────────────────────

export interface InvoiceView {
  id: string;
  leaseId: string;
  periodStart: string;
  periodEnd: string;
  baseRentMinor: string;
  utilityShareMinor: string;
  lateFeeMinor: string;
  totalMinor: string;
  amountPaidMinor: string;
  currency: string;
  status: InvoiceStatus;
  dueDate: string;
  version: number;
  generatedAt: string;
  disputedAt: string | null;
  disputedByUserId: string | null;
  disputeReason: string | null;
  waivedAt: string | null;
  waivedByUserId: string | null;
  waiveReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceSummaryView {
  id: string;
  leaseId: string;
  periodStart: string;
  periodEnd: string;
  totalMinor: string;
  amountPaidMinor: string;
  currency: string;
  status: InvoiceStatus;
  dueDate: string;
}

export interface InvoicePage {
  items: InvoiceSummaryView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row type + mapper
// ──────────────────────────────────────────────────────────────────────

type InvoiceRow = {
  id: string;
  leaseId: string;
  periodStart: Date;
  periodEnd: Date;
  baseRentMinor: bigint;
  utilityShareMinor: bigint;
  lateFeeMinor: bigint;
  totalMinor: bigint;
  amountPaidMinor: bigint;
  currency: string;
  status: InvoiceStatus;
  dueDate: Date;
  version: number;
  generatedAt: Date;
  disputedAt: Date | null;
  disputedByUserId: string | null;
  disputeReason: string | null;
  waivedAt: Date | null;
  waivedByUserId: string | null;
  waiveReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function invoiceRowToView(r: InvoiceRow): InvoiceView {
  return {
    id: r.id,
    leaseId: r.leaseId,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    baseRentMinor: r.baseRentMinor.toString(),
    utilityShareMinor: r.utilityShareMinor.toString(),
    lateFeeMinor: r.lateFeeMinor.toString(),
    totalMinor: r.totalMinor.toString(),
    amountPaidMinor: r.amountPaidMinor.toString(),
    currency: r.currency,
    status: r.status,
    dueDate: r.dueDate.toISOString(),
    version: r.version,
    generatedAt: r.generatedAt.toISOString(),
    disputedAt: r.disputedAt?.toISOString() ?? null,
    disputedByUserId: r.disputedByUserId,
    disputeReason: r.disputeReason,
    waivedAt: r.waivedAt?.toISOString() ?? null,
    waivedByUserId: r.waivedByUserId,
    waiveReason: r.waiveReason,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Party resolution for requireInvoiceParty middleware
// ──────────────────────────────────────────────────────────────────────

/**
 * Single-row lookup used by `requireInvoiceParty` middleware. Returns
 * `null` for ownerId and `[]` for tenantIds when the invoice doesn't
 * exist (so the middleware can 404 without leaking existence).
 *
 * Mirrors `resolvePartiesForLease` in leases.service.ts.
 */
export async function resolvePartiesForInvoice(invoiceId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
}> {
  const row = await prisma.rentInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      lease: {
        select: {
          ownerUserId: true,
          tenants: { select: { tenantUserId: true } },
        },
      },
    },
  });
  if (!row) return { ownerId: null, tenantIds: [] };
  return {
    ownerId: row.lease.ownerUserId,
    tenantIds: row.lease.tenants.map((t) => t.tenantUserId),
  };
}

// ──────────────────────────────────────────────────────────────────────
// generateInvoiceForLease — POST /bills/generate
// ──────────────────────────────────────────────────────────────────────

export interface GenerateInvoiceInput {
  leaseId: string;
  /** UTC date (start of day) — first day of the billing period. */
  periodStart: Date;
  /** UTC date (start of day) — last day of the billing period (inclusive). */
  periodEnd: Date;
  /** Optional override; default = today (UTC start of day). */
  today?: Date;
}

/**
 * Generate (or re-fetch) a rent invoice for the given lease + period.
 *
 * Algorithm (mirrors Phase 13 signLease idempotency):
 *   1. Load lease + tenants → 404 if missing.
 *   2. Validate state: lease.status must be ACTIVE.
 *   3. Validate period: periodStart <= periodEnd, both within
 *      [lease.startDate, lease.endDate] window.
 *   4. Idempotency: select existing invoice for (leaseId, periodStart).
 *      If found → return existing view (no-op, no audit, no outbox).
 *   5. Compute baseRentMinor (prorate for first-period mid-month start).
 *   6. Compute lateFeeMinor (JSONB policy; null policy → 0).
 *   7. Compute totalMinor = baseRentMinor + utilityShareMinor +
 *      lateFeeMinor.
 *   8. Compute dueDate = periodEnd + 5 calendar days.
 *   9. Insert row; on P2002 (UNIQUE race), re-fetch and return winner.
 *  10. Audit + 2 outbox events (invoice.generated + status_changed).
 *  11. Re-load + return view.
 */
export async function generateInvoiceForLease(
  callerUserId: string,
  input: GenerateInvoiceInput
): Promise<InvoiceView> {
  // Pre-validate inputs (no DB).
  if (input.periodEnd.getTime() < input.periodStart.getTime()) {
    throw new ConflictError('CONFLICT', 'periodEnd must be on or after periodStart', [
      { field: 'periodEnd', code: 'INVALID', message: 'must be >= periodStart' },
    ]);
  }

  return await prisma.$transaction(async (tx) => {
    return generateInvoiceCoreInTx(tx, callerUserId, input);
  });
}

/**
 * Phase 16 hook. Runs the Phase 14 generation logic inside an
 * existing transaction so the caller can layer additional writes
 * (utility bills + BillShares) atomically on top of the invoice.
 *
 * Mirrors the body of `generateInvoiceForLease` above. If those
 * invariants change, this function must be updated.
 */
export async function generateInvoiceCoreInTx(
  tx: Prisma.TransactionClient,
  callerUserId: string,
  input: GenerateInvoiceInput
): Promise<InvoiceView> {
    const lease = await tx.lease.findUnique({
      where: { id: input.leaseId },
      select: {
        id: true,
        ownerUserId: true,
        primaryTenantUserId: true,
        startDate: true,
        endDate: true,
        rentMinor: true,
        currency: true,
        lateFeePolicy: true,
        status: true,
        tenants: { select: { tenantUserId: true } },
      },
    });
    if (!lease) throw new NotFoundError('Lease not found');

    // 2. Caller authorization: OWNER (party) only — ADMIN can't generate
    // (admin is for dispute resolution + waive, not normal flow).
    if (lease.ownerUserId !== callerUserId) {
      throw new ForbiddenError('NOT_OWNER', 'Only the lease owner may generate invoices');
    }
    if (lease.status !== 'ACTIVE') {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot generate invoice for lease in status ${lease.status}`
      );
    }

    // 3. Period window check.
    const periodStartMs = input.periodStart.getTime();
    const periodEndMs = input.periodEnd.getTime();
    const leaseStartMs = lease.startDate.getTime();
    const leaseEndMs = lease.endDate.getTime();
    if (periodStartMs < leaseStartMs || periodEndMs > leaseEndMs) {
      throw new ConflictError('CONFLICT', 'Period is outside the lease window', [
        { field: 'periodStart', code: 'OUT_OF_RANGE', message: 'before lease startDate' },
        { field: 'periodEnd', code: 'OUT_OF_RANGE', message: 'after lease endDate' },
      ]);
    }

    // 4. Idempotency: existing row for (lease, periodStart)?
    // Note: UNIQUE(lease_id, period_start) is hand-edited in the
    // migration SQL (Prisma doesn't expose it as a compound unique
    // in the TypeScript types), so we use findFirst and rely on
    // the catch-P2002 branch below to handle concurrent inserts.
    const existing = await tx.rentInvoice.findFirst({
      where: {
        leaseId: input.leaseId,
        periodStart: input.periodStart,
      },
      select: { id: true },
    });
    if (existing) {
      // Return existing row view — caller sees the same shape as a fresh
      // create. No audit, no outbox (this is the no-op idempotent branch).
      const reloaded = await tx.rentInvoice.findUnique({
        where: { id: existing.id },
        select: fullInvoiceSelect(),
      });
      if (!reloaded) throw new NotFoundError('Invoice vanished mid-transaction');
      return invoiceRowToView(reloaded as unknown as InvoiceRow);
    }

    // 5. Compute baseRentMinor — prorate for first-period mid-month start.
    const today = input.today ?? new Date();
    today.setUTCHours(0, 0, 0, 0);
    const daysInMonth = daysInPeriodMonth(input.periodStart);
    const endOfMonth = endOfPeriodMonth(input.periodStart);
    let baseRentMinor = lease.rentMinor;
    const isFirstPeriod =
      lease.startDate.getUTCFullYear() === input.periodStart.getUTCFullYear() &&
      lease.startDate.getUTCMonth() === input.periodStart.getUTCMonth();
    if (isFirstPeriod && lease.startDate.getUTCDate() !== 1) {
      baseRentMinor = proratedRent({
        baseRentMinor: lease.rentMinor,
        startDate: lease.startDate,
        endOfMonth,
        daysInMonth,
      });
    }

    // 6. Late fee.
    const utilityShareMinor = 0n; // Phase 16 will populate.
    const outstanding = baseRentMinor + utilityShareMinor;
    const policy = parseLateFeePolicy(lease.lateFeePolicy);
    const lateFeeMinor = calculateLateFee({
      outstandingMinor: outstanding,
      policy,
      today,
      dueDate: input.periodEnd,
    });

    // 7. Total.
    const totalMinor = monthlyTotal({ rentMinor: baseRentMinor, utilityShareMinor, lateFeeMinor });

    // 8. Due date.
    const dueDate = new Date(input.periodEnd);
    dueDate.setUTCDate(dueDate.getUTCDate() + 5);

    // 9. Insert.
    let invoiceId: string;
    try {
      const created = await tx.rentInvoice.create({
        data: {
          leaseId: input.leaseId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          baseRentMinor,
          utilityShareMinor,
          lateFeeMinor,
          totalMinor,
          currency: lease.currency,
          status: 'DUE',
          dueDate,
        },
        select: { id: true },
      });
      invoiceId = created.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        // Race-loser branch — another tx inserted between our pre-check
        // and this insert. Re-fetch and return the winner. (Same shape
        // as the existing-row pre-check above.)
        const winner = await tx.rentInvoice.findFirst({
          where: {
            leaseId: input.leaseId,
            periodStart: input.periodStart,
          },
          select: { id: true },
        });
        if (!winner) throw e;
        const reloaded = await tx.rentInvoice.findUnique({
          where: { id: winner.id },
          select: fullInvoiceSelect(),
        });
        if (!reloaded) throw new NotFoundError('Invoice vanished mid-transaction');
        return invoiceRowToView(reloaded as unknown as InvoiceRow);
      }
      throw e;
    }

    // 10. Audit + outbox.
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'OWNER',
        action: 'invoice.generated',
        targetEntityType: 'rent_invoice',
        targetEntityId: invoiceId,
        before: Prisma.JsonNull,
        after: {
          leaseId: input.leaseId,
          periodStart: input.periodStart.toISOString(),
          periodEnd: input.periodEnd.toISOString(),
          baseRentMinor: baseRentMinor.toString(),
          utilityShareMinor: utilityShareMinor.toString(),
          lateFeeMinor: lateFeeMinor.toString(),
          totalMinor: totalMinor.toString(),
          currency: lease.currency,
          dueDate: dueDate.toISOString(),
          status: 'DUE',
        },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.generated',
        payload: {
          invoiceId,
          leaseId: input.leaseId,
          tenantUserIds: lease.tenants.map((t) => t.tenantUserId),
          ownerUserId: lease.ownerUserId,
          periodStart: input.periodStart.toISOString(),
          periodEnd: input.periodEnd.toISOString(),
          totalMinor: totalMinor.toString(),
          currency: lease.currency,
          dueDate: dueDate.toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.status_changed',
        payload: {
          invoiceId,
          leaseId: input.leaseId,
          from: null,
          to: 'DUE',
          actorUserId: callerUserId,
        } as Prisma.InputJsonValue,
      },
    });

    // 11. Reload for view.
    const reloaded = await tx.rentInvoice.findUnique({
      where: { id: invoiceId },
      select: fullInvoiceSelect(),
    });
    if (!reloaded) throw new NotFoundError('Invoice vanished after create');
    return invoiceRowToView(reloaded as unknown as InvoiceRow);
  }

// ──────────────────────────────────────────────────────────────────────
// listInvoicesForCaller — GET /invoices/me
// ──────────────────────────────────────────────────────────────────────

/**
 * Cursor-paginated list of invoices where the caller is either the
 * owner or a tenant party. OWNER and ADMIN see all invoices for their
 * leases; TENANT sees only those on leases where they appear in
 * lease_tenants.
 *
 * Sort: newest first by generatedAt, then by id for stable cursors.
 * Cursor format: opaque base64 of `${generatedAtIso}|${id}`.
 */
export async function listInvoicesForCaller(
  callerUserId: string,
  limit: number,
  cursor: string | null
): Promise<InvoicePage> {
  const take = limit + 1;
  const cursorDecoded = cursor ? decodeCursor(cursor) : null;

  const rows = await prisma.rentInvoice.findMany({
    where: {
      OR: [
        { lease: { ownerUserId: callerUserId } },
        { lease: { tenants: { some: { tenantUserId: callerUserId } } } },
      ],
      ...(cursorDecoded
        ? {
            OR: [
              { generatedAt: { lt: cursorDecoded.generatedAt } },
              {
                generatedAt: cursorDecoded.generatedAt,
                id: { lt: cursorDecoded.id },
              },
            ],
          }
        : {}),
    },
    orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
    take,
    select: {
      id: true,
      leaseId: true,
      periodStart: true,
      periodEnd: true,
      totalMinor: true,
      amountPaidMinor: true,
      currency: true,
      status: true,
      dueDate: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: InvoiceSummaryView[] = page.map((r) => ({
    id: r.id,
    leaseId: r.leaseId,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    totalMinor: r.totalMinor.toString(),
    amountPaidMinor: r.amountPaidMinor.toString(),
    currency: r.currency,
    status: r.status,
    dueDate: r.dueDate.toISOString(),
  }));
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ generatedAt: last.dueDate, id: last.id }) : null;
  return { items, nextCursor };
}

// ──────────────────────────────────────────────────────────────────────
// getInvoice — GET /invoices/:id
// ──────────────────────────────────────────────────────────────────────

export async function getInvoice(invoiceId: string): Promise<InvoiceView> {
  const row = await prisma.rentInvoice.findUnique({
    where: { id: invoiceId },
    select: fullInvoiceSelect(),
  });
  if (!row) throw new NotFoundError('Invoice not found');
  return invoiceRowToView(row as unknown as InvoiceRow);
}

// ──────────────────────────────────────────────────────────────────────
// waiveInvoice — POST /invoices/:id/waive (ADMIN only)
// ──────────────────────────────────────────────────────────────────────

/**
 * ADMIN transitions the invoice to WAIVED. Audit + outbox + state-
 * machine guard. Idempotency: caller provides Idempotency-Key header
 * (handled in the route layer), so this function trusts the request
 * and does not second-guess.
 */
export async function waiveInvoice(
  callerUserId: string,
  invoiceId: string,
  body: { reason: string }
): Promise<InvoiceView> {
  return await prisma.$transaction(async (tx) => {
    const invoice = await tx.rentInvoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, status: true },
    });
    if (!invoice) throw new NotFoundError('Invoice not found');
    if (!isValidInvoiceTransition(invoice.status, 'WAIVED')) {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot waive invoice in status ${invoice.status}`
      );
    }
    const now = new Date();
    await tx.rentInvoice.update({
      where: { id: invoiceId },
      data: {
        status: 'WAIVED',
        waivedAt: now,
        waivedByUserId: callerUserId,
        waiveReason: body.reason,
        version: { increment: 1 },
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: 'ADMIN',
        action: 'invoice.waived',
        targetEntityType: 'rent_invoice',
        targetEntityId: invoiceId,
        before: { status: invoice.status },
        after: { status: 'WAIVED', waiveReason: body.reason, waivedAt: now.toISOString() },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.waived',
        payload: {
          invoiceId,
          from: invoice.status,
          to: 'WAIVED',
          actorUserId: callerUserId,
          reason: body.reason,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.status_changed',
        payload: {
          invoiceId,
          from: invoice.status,
          to: 'WAIVED',
          actorUserId: callerUserId,
        } as Prisma.InputJsonValue,
      },
    });
    const reloaded = await tx.rentInvoice.findUnique({
      where: { id: invoiceId },
      select: fullInvoiceSelect(),
    });
    if (!reloaded) throw new NotFoundError('Invoice vanished after waive');
    return invoiceRowToView(reloaded as unknown as InvoiceRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// disputeInvoice — POST /invoices/:id/dispute (party: TENANT or OWNER)
// ──────────────────────────────────────────────────────────────────────

export async function disputeInvoice(
  callerUserId: string,
  callerRoles: ('TENANT' | 'OWNER' | 'ADMIN')[],
  invoiceId: string,
  body: { reason: string }
): Promise<InvoiceView> {
  return await prisma.$transaction(async (tx) => {
    const invoice = await tx.rentInvoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        lease: {
          select: {
            ownerUserId: true,
            tenants: { select: { tenantUserId: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundError('Invoice not found');

    // Caller must be a party (or ADMIN — but the route layer's
    // requireRole blocks ADMIN, so this is belt-and-braces).
    const isOwner = invoice.lease.ownerUserId === callerUserId;
    const isTenant = invoice.lease.tenants.some(
      (t) => t.tenantUserId === callerUserId
    );
    const isAdmin = callerRoles.includes('ADMIN');
    if (!isOwner && !isTenant && !isAdmin) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this invoice');
    }

    if (!isValidInvoiceTransition(invoice.status, 'DISPUTED')) {
      throw new ConflictError(
        'STATE_MACHINE',
        `Cannot dispute invoice in status ${invoice.status}`
      );
    }
    const now = new Date();
    await tx.rentInvoice.update({
      where: { id: invoiceId },
      data: {
        status: 'DISPUTED',
        disputedAt: now,
        disputedByUserId: callerUserId,
        disputeReason: body.reason,
        version: { increment: 1 },
      },
    });
    const callerActorRole = isOwner ? 'OWNER' : isTenant ? 'TENANT' : 'ADMIN';
    await tx.auditLog.create({
      data: {
        actorUserId: callerUserId,
        actorRole: callerActorRole,
        action: 'invoice.disputed',
        targetEntityType: 'rent_invoice',
        targetEntityId: invoiceId,
        before: { status: invoice.status },
        after: { status: 'DISPUTED', disputeReason: body.reason, disputedAt: now.toISOString() },
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.disputed',
        payload: {
          invoiceId,
          from: invoice.status,
          to: 'DISPUTED',
          actorUserId: callerUserId,
          actorRole: callerActorRole,
          reason: body.reason,
        } as Prisma.InputJsonValue,
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventType: 'invoice.status_changed',
        payload: {
          invoiceId,
          from: invoice.status,
          to: 'DISPUTED',
          actorUserId: callerUserId,
        } as Prisma.InputJsonValue,
      },
    });
    const reloaded = await tx.rentInvoice.findUnique({
      where: { id: invoiceId },
      select: fullInvoiceSelect(),
    });
    if (!reloaded) throw new NotFoundError('Invoice vanished after dispute');
    return invoiceRowToView(reloaded as unknown as InvoiceRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (select clause, cursor codec, period math, policy parse)
// ──────────────────────────────────────────────────────────────────────

function fullInvoiceSelect() {
  return {
    id: true,
    leaseId: true,
    periodStart: true,
    periodEnd: true,
    baseRentMinor: true,
    utilityShareMinor: true,
    lateFeeMinor: true,
    totalMinor: true,
    amountPaidMinor: true,
    currency: true,
    status: true,
    dueDate: true,
    version: true,
    generatedAt: true,
    disputedAt: true,
    disputedByUserId: true,
    disputeReason: true,
    waivedAt: true,
    waivedByUserId: true,
    waiveReason: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

function encodeCursor(c: { generatedAt: Date; id: string }): string {
  return Buffer.from(`${c.generatedAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(s: string): { generatedAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return { generatedAt: d, id };
  } catch {
    return null;
  }
}

/** Days in the calendar month containing `d` (UTC). */
function daysInPeriodMonth(d: Date): number {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Last day (23:59:59.999 UTC) of the calendar month containing `d`. */
function endOfPeriodMonth(d: Date): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, last, 23, 59, 59, 999));
}

/**
 * Parse leases.lateFeePolicy (JSONB) into the typed shape used by
 * rent-calculator. Returns null for null input or malformed JSON so
 * the calculator can treat it as "no policy".
 */
function parseLateFeePolicy(raw: Prisma.JsonValue | null): LateFeePolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const graceDays =
    typeof obj.graceDays === 'number' ? obj.graceDays : Number(obj.graceDays ?? 0);
  const mode = obj.mode === 'PERCENT' || obj.mode === 'FIXED' ? obj.mode : null;
  const value =
    typeof obj.value === 'number' ? obj.value : Number(obj.value ?? 0);
  if (!mode || !Number.isFinite(graceDays) || !Number.isFinite(value)) return null;
  return { graceDays, mode, value };
}