// src/modules/bills/bills.service.ts
//
// Phase 16: utility meter bill generation + retrieval. Replaces the
// Phase 14 thin facade.
//
// Hot paths:
// generateBillsForLease — Extends POST /bills/generate. Wraps
// Phase 14's generateInvoiceForLease
// to ALSO compute per-utility
// consumption, split per
// lease.utilitySplitMode, persist
// UtilityBill + BillShare rows, and
// set rent_invoices.utility_share_minor
// to Σ shares for the invoice's lease
// tenants.
// listBillsForCaller — GET /bills/me (TENANT) and OWNER
// views. Cursor pagination.
// getBill — GET /bills/:id with party check.
// resolvePartiesForBill — Owner + BillShare tenants.
//
// Split-mode logic lives in ./bill-splitter.ts (pure, tested in
// scripts/verify-p16-splitter.ts). This file only handles DB I/O,
// transactional boundaries, and authorization.

import { Prisma } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';

import {
  generateInvoiceCoreInTx,
} from '../invoices/invoices.service';
import { monthlyTotal } from '../invoices/rent-calculator';
import {
  splitCustom,
  splitEqual,
  splitProportional,
} from './bill-splitter';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface UtilityBillView {
  id: string;
  leaseId: string;
  meterId: string;
  periodStart: string;
  periodEnd: string;
  previousReadingValue: string;
  currentReadingValue: string;
  consumptionUnits: string;
  totalAmountMinor: string;
  currency: string;
  generatedAt: string;
  superseded: boolean;
}

export interface BillShareView {
  id: string;
  billId: string;
  tenantUserId: string;
  shareMinor: string;
  splitMode: string;
  weightUsed: string | null;
  createdAt: string;
}

export interface GenerateBillsResult {
  invoice: import('../invoices/invoices.service').InvoiceView;
  bills: UtilityBillView[];
  shares: BillShareView[];
}

export interface BillSummaryView {
  id: string;
  leaseId: string;
  meterId: string;
  meterUtilityType: string;
  meterLabel: string;
  periodStart: string;
  periodEnd: string;
  totalAmountMinor: string;
  currency: string;
  generatedAt: string;
  superseded: boolean;
}

export interface BillPage {
  items: BillSummaryView[];
  nextCursor: string | null;
}

export interface BillDetailView {
  bill: UtilityBillView;
  shares: BillShareView[];
}

// ──────────────────────────────────────────────────────────────────────
// Internal row types + mappers
// ──────────────────────────────────────────────────────────────────────

type UtilityBillRow = {
  id: string;
  leaseId: string;
  meterId: string;
  periodStart: Date;
  periodEnd: Date;
  previousReadingValue: Prisma.Decimal;
  currentReadingValue: Prisma.Decimal;
  consumptionUnits: Prisma.Decimal;
  totalAmountMinor: bigint;
  currency: string;
  generatedAt: Date;
  superseded: boolean;
  supersededAt: Date | null;
};

type BillShareRow = {
  id: string;
  billId: string;
  tenantUserId: string;
  shareMinor: bigint;
  splitMode: string;
  weightUsed: Prisma.Decimal | null;
  createdAt: Date;
};

function billRowToView(r: UtilityBillRow): UtilityBillView {
  return {
    id: r.id,
    leaseId: r.leaseId,
    meterId: r.meterId,
    periodStart: r.periodStart.toISOString().slice(0, 10),
    periodEnd: r.periodEnd.toISOString().slice(0, 10),
    previousReadingValue: r.previousReadingValue.toString(),
    currentReadingValue: r.currentReadingValue.toString(),
    consumptionUnits: r.consumptionUnits.toString(),
    totalAmountMinor: r.totalAmountMinor.toString(),
    currency: r.currency,
    generatedAt: r.generatedAt.toISOString(),
    superseded: r.superseded,
  };
}

function shareRowToView(r: BillShareRow): BillShareView {
  return {
    id: r.id,
    billId: r.billId,
    tenantUserId: r.tenantUserId,
    shareMinor: r.shareMinor.toString(),
    splitMode: r.splitMode,
    weightUsed: r.weightUsed ? r.weightUsed.toString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

const fullBillSelect = () =>
  ({
    id: true,
    leaseId: true,
    meterId: true,
    periodStart: true,
    periodEnd: true,
    previousReadingValue: true,
    currentReadingValue: true,
    consumptionUnits: true,
    totalAmountMinor: true,
    currency: true,
    generatedAt: true,
    superseded: true,
    supersededAt: true,
  }) satisfies Prisma.UtilityBillSelect;

const fullShareSelect = () =>
  ({
    id: true,
    billId: true,
    tenantUserId: true,
    shareMinor: true,
    splitMode: true,
    weightUsed: true,
    createdAt: true,
  }) satisfies Prisma.BillShareSelect;

// ──────────────────────────────────────────────────────────────────────
// Party resolution
// ──────────────────────────────────────────────────────────────────────

/**
 * Lookup used by `requireBillParty` middleware. Returns
 * `ownerId: null` and `tenantIds: []` when the bill doesn't exist so
 * the middleware can 404 without leaking existence.
 *
 * `tenantIds` is the union of all tenants who hold a BillShare for
 * this bill (not just lease tenants — protects against post-lease
 * bill queries).
 */
export async function resolvePartiesForBill(billId: string): Promise<{
  ownerId: string | null;
  tenantIds: string[];
}> {
  const row = await prisma.utilityBill.findUnique({
    where: { id: billId },
    select: {
      lease: {
        select: {
          ownerUserId: true,
        },
      },
      shares: {
        select: { tenantUserId: true },
      },
    },
  });
  if (!row) return { ownerId: null, tenantIds: [] };
  return {
    ownerId: row.lease.ownerUserId,
    tenantIds: [...new Set(row.shares.map((s) => s.tenantUserId))],
  };
}

// ──────────────────────────────────────────────────────────────────────
// generateBillsForLease — extended POST /bills/generate
// ──────────────────────────────────────────────────────────────────────

export interface GenerateBillsInput {
  leaseId: string;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Generate (or fetch existing) rent invoice, then on top of it compute
 * utility bills for every active meter on the property + persist
 * BillShare rows + update rent_invoices.utility_share_minor.
 *
 * The whole operation runs in ONE `prisma.$transaction` so the rent
 * invoice + utility bills + shares + audit are atomic.
 *
 * Algorithm:
 *   1. Re-use Phase 14's generateInvoiceForLease to create the rent
 *      invoice. If one already exists for (lease, periodStart), the
 *      Phase 14 helper returns the existing row WITHOUT writing audit
 *       Phase 16 also skips utility-bill
 *      generation (idempotency: regenerating utility bills for an
 *      already-issued invoice would double-count).
 *   2. Load the property + its active meters (via rooms → leases).
 *   3. For each meter: find the previous reading (the latest reading
 *      with date < periodStart) and a current reading (date <=
 *      periodEnd). If neither exists, skip the meter.
 *   4. Compute consumption = current - previous. Compute total = round(
 *      consumption × ratePerUnitMinor / 10^precision). Use
 *      largest-remainder split for cents → BillShare rows.
 *   5. Persist UtilityBill + BillShare rows.
 *   6. UPDATE rent_invoice.utility_share_minor = Σ shares.
 *   7. audit events per bill (utility_bill.generated +
 *      bill_shares.persisted).
 *
 * NOTE: existing-bills-but-new-readings case is handled by the
 * `superseded=true` flag — a regenerate with new readings creates a
 * new UtilityBill row and flips the prior one. For v1 we mark the
 * old bill as superseded but keep it in DB (audit trail).
 */
export async function generateBillsForLease(
  callerUserId: string,
  input: GenerateBillsInput
): Promise<GenerateBillsResult> {
  if (input.periodEnd.getTime() < input.periodStart.getTime()) {
    throw new ConflictError('CONFLICT', 'periodEnd must be on or after periodStart', [
      { field: 'periodEnd', code: 'INVALID', message: 'must be >= periodStart' },
    ]);
  }

  return await prisma.$transaction(async (tx) => {
    // ── Phase 14 step: generate / fetch rent invoice ────────────────
    // We invoke the Phase 14 core inside OUR tx so the invoice +
    // utility bills + shares + audit are atomic.
    const invoiceView = await generateInvoiceCoreInTx(tx, callerUserId, {
      leaseId: input.leaseId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });

    // Idempotency: if the invoice was pre-existing (Phase 14 returned
    // the existing row view), skip Phase 16 work — utility bills were
    // already computed for it on the previous run.
    if (invoiceView.utilityShareMinor !== '0' || invoiceView.baseRentMinor === '0') {
      // Either utilityShare was already populated (regen on a bill
      // that already had utility work done) or there's nothing to do
      // (no rent base). In both cases we re-fetch existing bills +
      // shares to return a coherent response.
      const existingBills = await tx.utilityBill.findMany({
        where: {
          leaseId: input.leaseId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          superseded: false,
        },
        select: fullBillSelect(),
        orderBy: { generatedAt: 'asc' },
      });
      const billIds = existingBills.map((b) => b.id);
      const existingShares =
        billIds.length === 0
          ? []
          : await tx.billShare.findMany({
              where: { billId: { in: billIds } },
              select: fullShareSelect(),
              orderBy: { createdAt: 'asc' },
            });
      return {
        invoice: invoiceView,
        bills: existingBills.map((r) => billRowToView(r as unknown as UtilityBillRow)),
        shares: existingShares.map((r) => shareRowToView(r as unknown as BillShareRow)),
      };
    }

    // ── Phase 16 step: load lease + property + meters ───────────────
    const lease = await tx.lease.findUnique({
      where: { id: input.leaseId },
      select: {
        id: true,
        ownerUserId: true,
        currency: true,
        utilitySplitMode: true,
        utilitySplitCustomPercents: true,
        roomId: true,
        tenants: {
          select: { tenantUserId: true, liabilityShare: true },
        },
      },
    });
    if (!lease) throw new NotFoundError('Lease vanished mid-transaction');

    if (lease.tenants.length === 0) {
      // No tenants → no shares to create. Just return the empty result.
      return { invoice: invoiceView, bills: [], shares: [] };
    }

    // Fetch the room → property → active meters chain in 2 hops.
    const room = await tx.room.findUnique({
      where: { id: lease.roomId },
      select: { propertyId: true },
    });
    if (!room) throw new NotFoundError('Room vanished mid-transaction');
    const property = await tx.property.findUnique({
      where: { id: room.propertyId },
      select: {
        id: true,
        meters: {
          where: { isActive: true },
          select: {
            id: true,
            utilityType: true,
            label: true,
            ratePerUnitMinor: true,
            currency: true,
            unitLabel: true,
          },
        },
      },
    });
    if (!property) throw new NotFoundError('Property vanished mid-transaction');
    const meters = property.meters;

    // ── Phase 16 step: for each meter, compute + persist bill ───────
    const allBills: UtilityBillRow[] = [];
    const allShares: BillShareRow[] = [];

    for (const meter of meters) {
      // Find the previous reading (latest on/before periodStart).
      const previousReading = await tx.meterReading.findFirst({
        where: {
          meterId: meter.id,
          readingDate: { lte: input.periodStart },
        },
        select: { readingDate: true, readingValue: true },
        orderBy: { readingDate: 'desc' },
      });
      // Find the current reading (latest on/before periodEnd).
      const currentReading = await tx.meterReading.findFirst({
        where: {
          meterId: meter.id,
          readingDate: { lte: input.periodEnd },
        },
        select: { readingDate: true, readingValue: true },
        orderBy: { readingDate: 'desc' },
      });

      // Skip meters without BOTH a previous and current reading inside
      // the period. We can't compute consumption without two points.
      if (!previousReading || !currentReading) continue;
      // Skip if previous == current (no consumption).
      if (previousReading.readingValue.equals(currentReading.readingValue)) continue;

      // Compute consumption in raw Decimal precision.
      const consumptionDecimal = currentReading.readingValue.minus(
        previousReading.readingValue
      );
      // Compute total: consumption × ratePerUnitMinor. The Decimal
      // can have up to 4 fractional digits; rate is BigInt cents/unit.
      // We need total in BigInt cents, so: total_minor = round(
      // consumption × rate). Use Decimal.toFixed(0, rounding mode).
      const totalDecimal = consumptionDecimal.times(
        new Prisma.Decimal(meter.ratePerUnitMinor.toString())
      );
      const totalMinorBig = BigInt(totalDecimal.toFixed(0, Prisma.Decimal.ROUND_HALF_UP));
      if (totalMinorBig < 0n) continue; // defensive

      // Mark previous bills for this (lease, meter, period) as
      // superseded. New bill is the active one.
      await tx.utilityBill.updateMany({
        where: {
          leaseId: input.leaseId,
          meterId: meter.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          superseded: false,
        },
        data: { superseded: true, supersededAt: new Date() },
      });

      // Create the new UtilityBill row.
      const billRow = await tx.utilityBill.create({
        data: {
          leaseId: input.leaseId,
          meterId: meter.id,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          previousReadingValue: previousReading.readingValue,
          currentReadingValue: currentReading.readingValue,
          consumptionUnits: consumptionDecimal,
          totalAmountMinor: totalMinorBig,
          currency: meter.currency,
        },
        select: fullBillSelect(),
      });
      allBills.push(billRow as unknown as UtilityBillRow);

      // Split the total across lease tenants per the lease's mode.
      const shares = computeSharesForLease({
        splitMode: lease.utilitySplitMode,
        customPercents: lease.utilitySplitCustomPercents,
        tenants: lease.tenants,
        totalMinor: totalMinorBig,
      });

      for (const share of shares) {
        const shareRow = await tx.billShare.create({
          data: {
            billId: billRow.id,
            tenantUserId: share.tenantUserId,
            shareMinor: share.shareMinor,
            splitMode: share.splitMode,
            weightUsed: share.weightUsed ?? null,
          },
          select: fullShareSelect(),
        });
        allShares.push(shareRow as unknown as BillShareRow);
      }
    }

    // ── Phase 16 step: update rent_invoice.utility_share_minor ──────
    const utilityShareMinor = allShares.reduce((acc, s) => acc + s.shareMinor, 0n);
    if (utilityShareMinor > 0n) {
      // We need to recompute totalMinor too: baseRentMinor +
      // utilityShareMinor + lateFeeMinor. The Phase 14 invoice was
      // created with utilityShare=0, so we must update it now.
      const invoiceForUpdate = await tx.rentInvoice.findUnique({
        where: { id: invoiceView.id },
        select: {
          id: true,
          baseRentMinor: true,
          lateFeeMinor: true,
        },
      });
      if (!invoiceForUpdate) throw new NotFoundError('Invoice vanished mid-tx');
      const newTotal = monthlyTotal({
        rentMinor: invoiceForUpdate.baseRentMinor,
        utilityShareMinor,
        lateFeeMinor: invoiceForUpdate.lateFeeMinor,
      });
      await tx.rentInvoice.update({
        where: { id: invoiceView.id },
        data: { utilityShareMinor, totalMinor: newTotal },
      });
      // Reflect in the view we return.
      invoiceView.utilityShareMinor = utilityShareMinor.toString();
      invoiceView.totalMinor = newTotal.toString();
    }

    // ── Phase 16 step: audit ───────────────────────────────
    for (const bill of allBills) {
      await tx.auditLog.create({
        data: {
          actorUserId: callerUserId,
          actorRole: 'OWNER',
          action: 'utility_bill.generated',
          targetEntityType: 'utility_bill',
          targetEntityId: bill.id,
          before: Prisma.JsonNull,
          after: {
            leaseId: bill.leaseId,
            meterId: bill.meterId,
            periodStart: bill.periodStart.toISOString().slice(0, 10),
            periodEnd: bill.periodEnd.toISOString().slice(0, 10),
            previousReadingValue: bill.previousReadingValue.toString(),
            currentReadingValue: bill.currentReadingValue.toString(),
            consumptionUnits: bill.consumptionUnits.toString(),
            totalAmountMinor: bill.totalAmountMinor.toString(),
            currency: bill.currency,
          },
        },
      });
      
    }

    return {
      invoice: invoiceView,
      bills: allBills.map(billRowToView),
      shares: allShares.map(shareRowToView),
    };
  });
}

// ──────────────────────────────────────────────────────────────────────
// Helper: split a bill's total across lease tenants per lease.utilitySplitMode
// ──────────────────────────────────────────────────────────────────────

interface ShareComputation {
  tenantUserId: string;
  shareMinor: bigint;
  splitMode: string;
  weightUsed: Prisma.Decimal | number | string | null;
}

function computeSharesForLease(args: {
  splitMode: string;
  customPercents: Prisma.JsonValue | null;
  tenants: Array<{ tenantUserId: string; liabilityShare: Prisma.Decimal }>;
  totalMinor: bigint;
}): ShareComputation[] {
  const { splitMode, customPercents, tenants, totalMinor } = args;
  if (tenants.length === 0) return [];
  if (totalMinor === 0n) {
    return tenants.map((t) => ({
      tenantUserId: t.tenantUserId,
      shareMinor: 0n,
      splitMode,
      weightUsed: null,
    }));
  }

  if (splitMode === 'EQUAL') {
    const ids = tenants.map((t) => t.tenantUserId);
    const raw = splitEqual(totalMinor, ids.length);
    return tenants.map((t, i) => ({
      tenantUserId: t.tenantUserId,
      shareMinor: raw[i]!,
      splitMode,
      weightUsed: null,
    }));
  }

  if (splitMode === 'PROPORTIONAL') {
    const shares = splitProportional(
      totalMinor,
      tenants.map((t) => ({
        tenantUserId: t.tenantUserId,
        weight: t.liabilityShare.toString(),
      }))
    );
    return shares.map((s) => ({
      tenantUserId: s.tenantUserId,
      shareMinor: s.shareMinor,
      splitMode,
      weightUsed: new Prisma.Decimal(s.weightUsed),
    }));
  }

  if (splitMode === 'CUSTOM') {
    // utilitySplitCustomPercents is a JSON array of {tenantUserId, percent}.
    // Fall back to PROPORTIONAL if missing or invalid (Phase 16 doesn't
    // fail-closed — Phase 18+ will tighten this).
    const parsed = parseCustomPercents(customPercents, tenants);
    if (parsed) {
      const shares = splitCustom(
        totalMinor,
        parsed.map((p) => ({
          tenantUserId: p.tenantUserId,
          percent: p.percent,
        }))
      );
      return shares.map((s) => ({
        tenantUserId: s.tenantUserId,
        shareMinor: s.shareMinor,
        splitMode,
        weightUsed: null,
      }));
    }
    // Fallback path
    const shares = splitProportional(
      totalMinor,
      tenants.map((t) => ({
        tenantUserId: t.tenantUserId,
        weight: t.liabilityShare.toString(),
      }))
    );
    return shares.map((s) => ({
      tenantUserId: s.tenantUserId,
      shareMinor: s.shareMinor,
      splitMode: 'PROPORTIONAL',
      weightUsed: new Prisma.Decimal(s.weightUsed),
    }));
  }

  // Unknown mode → fallback to EQUAL.
  const ids = tenants.map((t) => t.tenantUserId);
  const raw = splitEqual(totalMinor, ids.length);
  return tenants.map((t, i) => ({
    tenantUserId: t.tenantUserId,
    shareMinor: raw[i]!,
    splitMode: 'EQUAL',
    weightUsed: null,
  }));
}

interface CustomPercentEntry {
  tenantUserId: string;
  percent: number;
}

function parseCustomPercents(
  json: Prisma.JsonValue | null,
  tenants: Array<{ tenantUserId: string }>
): CustomPercentEntry[] | null {
  if (!Array.isArray(json)) return null;
  const tenantIds = new Set(tenants.map((t) => t.tenantUserId));
  const result: CustomPercentEntry[] = [];
  for (const item of json) {
    if (typeof item !== 'object' || item === null) return null;
    const obj = item as Record<string, unknown>;
    const tid = obj.tenantUserId;
    const pct = obj.percent;
    if (typeof tid !== 'string' || typeof pct !== 'number') return null;
    if (!tenantIds.has(tid)) return null;
    result.push({ tenantUserId: tid, percent: pct });
  }
  if (result.length !== tenants.length) return null;
  return result;
}

// ──────────────────────────────────────────────────────────────────────
// (Phase 14 invoice generation is invoked via generateInvoiceCoreInTx
// from invoices.service.ts — no duplicated logic here.)
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// listBillsForCaller — GET /bills/me
// ──────────────────────────────────────────────────────────────────────

export async function listBillsForCaller(
  callerUserId: string,
  limit: number,
  cursor: string | null
): Promise<BillPage> {
  // The caller is either a TENANT (see their own shares) or the OWNER
  // (see bills for their leases). We use a single query that joins on
  // shares ∪ leases and dedups by bill id.
  //
  // Approach: fetch bills where caller has a share OR caller is the
  // lease owner. Cursor pagination on (period_start desc, id desc).
  const cursorDate = cursor ? decodeCursorDate(cursor) : null;

  const rows = await prisma.utilityBill.findMany({
    where: {
      OR: [
        { shares: { some: { tenantUserId: callerUserId } } },
        { lease: { ownerUserId: callerUserId } },
      ],
      ...(cursorDate && !Number.isNaN(cursorDate.getTime())
        ? { periodStart: { lt: cursorDate } }
        : {}),
    },
    select: {
      id: true,
      leaseId: true,
      meterId: true,
      periodStart: true,
      periodEnd: true,
      totalAmountMinor: true,
      currency: true,
      generatedAt: true,
      superseded: true,
      meter: {
        select: { utilityType: true, label: true },
      },
    },
    orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(`${last.periodStart.toISOString()}|${last.id}`).toString('base64url')
      : null;

  return {
    items: slice.map((r) => ({
      id: r.id,
      leaseId: r.leaseId,
      meterId: r.meterId,
      meterUtilityType: r.meter.utilityType,
      meterLabel: r.meter.label,
      periodStart: r.periodStart.toISOString().slice(0, 10),
      periodEnd: r.periodEnd.toISOString().slice(0, 10),
      totalAmountMinor: r.totalAmountMinor.toString(),
      currency: r.currency,
      generatedAt: r.generatedAt.toISOString(),
      superseded: r.superseded,
    })),
    nextCursor,
  };
}

// ──────────────────────────────────────────────────────────────────────
// getBill — GET /bills/:id
// ──────────────────────────────────────────────────────────────────────

export async function getBill(billId: string): Promise<BillDetailView> {
  const bill = await prisma.utilityBill.findUnique({
    where: { id: billId },
    select: fullBillSelect(),
  });
  if (!bill) throw new NotFoundError('Bill not found');
  const shares = await prisma.billShare.findMany({
    where: { billId },
    select: fullShareSelect(),
    orderBy: { createdAt: 'asc' },
  });
  return {
    bill: billRowToView(bill as unknown as UtilityBillRow),
    shares: shares.map((r) => shareRowToView(r as unknown as BillShareRow)),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Cursor helpers (shared with readings.service.ts — duplicated locally
// to avoid a circular import)
// ──────────────────────────────────────────────────────────────────────

function decodeCursorDate(cursor: string): Date | undefined {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso] = decoded.split('|');
    if (!iso) return undefined;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}
