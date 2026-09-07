// src/modules/bills/bills.schemas.ts
//
// Zod schemas for /api/v1/bills body / params inputs.
//
// Phase 14 scope: only POST /bills/generate. The handler is a thin
// facade that proxies to invoices.service.generateInvoiceForLease.
// Phase 16 (utility meters + bill-split) will extend this file.

import { z } from 'zod';

/**
 * POST /bills/generate — body shape. `periodStart` and `periodEnd` are
 * ISO date strings (YYYY-MM-DD) coerced to UTC midnight Date by the
 * handler before being passed to the service. The service validates
 * periodEnd >= periodStart and the period falls within the lease window.
 */
export const generateBillSchema = z
  .object({
    leaseId: z.string().uuid({ message: 'leaseId must be a UUID' }),
    periodStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'periodStart must be a YYYY-MM-DD date'),
    periodEnd: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be a YYYY-MM-DD date'),
  })
  .strict();
export type GenerateBillInput = z.infer<typeof generateBillSchema>;

/**
 * Coerces the validated body to a service-input shape (Date objects).
 * Lives here so the controller stays trivial.
 */
export function toGenerateBillServiceInput(body: GenerateBillInput): {
  leaseId: string;
  periodStart: Date;
  periodEnd: Date;
} {
  return {
    leaseId: body.leaseId,
    periodStart: new Date(`${body.periodStart}T00:00:00.000Z`),
    periodEnd: new Date(`${body.periodEnd}T00:00:00.000Z`),
  };
}