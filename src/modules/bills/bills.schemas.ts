// src/modules/bills/bills.schemas.ts
//
// Zod schemas for /api/v1/bills body / params inputs.
//
// Phase 16 endpoints:
//   POST /bills/generate     — extended Phase 14 hot path
//   GET  /bills/me           — list bills for caller
//   GET  /bills/:id          — bill detail with shares

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
 * GET /bills/:id — params shape.
 */
export const billIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'id must be a UUID' }),
});
export type BillIdParams = z.infer<typeof billIdParamsSchema>;

/**
 * GET /bills/me — query shape.
 */
export const listBillsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .optional(),
  cursor: z.string().min(1).optional(),
});
export type ListBillsQuery = z.infer<typeof listBillsQuerySchema>;

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