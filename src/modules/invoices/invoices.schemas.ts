// src/modules/invoices/invoices.schemas.ts
//
// Zod schemas for /api/v1/invoices body / query / params inputs.
//
// Names match the route path so they're easy to grep from the
// controller. Zod enum tuples duplicate Prisma enum values so the
// inferred types stay narrow (see leases.schemas.ts for rationale).

import { z } from 'zod';

import type { InvoiceStatus as InvoiceStatusEnum } from '@/generated/prisma/enums';

// ──────────────────────────────────────────────────────────────────────
// Enums (mirror Prisma enum values exactly — kept in sync via tests).
// ──────────────────────────────────────────────────────────────────────

const invoiceStatusValues = [
  'DUE',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'WAIVED',
  'DISPUTED',
] as const satisfies readonly InvoiceStatusEnum[];

// ──────────────────────────────────────────────────────────────────────
// Params schemas
// ──────────────────────────────────────────────────────────────────────

export const invoiceIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'invoice id must be a UUID' }),
});
export type InvoiceIdParams = z.infer<typeof invoiceIdParamsSchema>;

// ──────────────────────────────────────────────────────────────────────
// Body schemas
// ──────────────────────────────────────────────────────────────────────

/**
 * POST /invoices/:id/dispute — body requires a non-empty reason.
 * Constraint: the field name MUST be `reason` to match the audit log
 * shape used by other modules (terminate lease, etc.).
 */
export const disputeInvoiceSchema = z
  .object({
    reason: z
      .string()
      .min(1, 'reason must not be empty')
      .max(1000, 'reason must be at most 1000 characters'),
  })
  .strict();
export type DisputeInvoiceInput = z.infer<typeof disputeInvoiceSchema>;

/**
 * POST /invoices/:id/waive — body requires a non-empty reason. ADMIN only.
 */
export const waiveInvoiceSchema = z
  .object({
    reason: z
      .string()
      .min(1, 'reason must not be empty')
      .max(1000, 'reason must be at most 1000 characters'),
  })
  .strict();
export type WaiveInvoiceInput = z.infer<typeof waiveInvoiceSchema>;

// ──────────────────────────────────────────────────────────────────────
// Re-export so callers can import the enum tuple without re-importing.
// ──────────────────────────────────────────────────────────────────────
export { invoiceStatusValues };
