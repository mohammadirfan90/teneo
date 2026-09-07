// src/modules/bills/readings.schemas.ts
//
// Zod schemas for /api/v1/meters/:meterId/readings.

import { z } from 'zod';

/**
 * POST /meters/:meterId/readings body.
 */
export const createReadingSchema = z
  .object({
    readingDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'readingDate must be a YYYY-MM-DD date'),
    readingValue: z
      .union([z.string(), z.number()])
      .refine((v) => {
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n);
      }, 'readingValue must be a finite number'),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type CreateReadingInput = z.infer<typeof createReadingSchema>;

/**
 * Params for /meters/:meterId/readings.
 */
export const meterIdParamsSchema = z.object({
  meterId: z.string().uuid({ message: 'meterId must be a UUID' }),
});
export type MeterIdParams = z.infer<typeof meterIdParamsSchema>;

/**
 * Query for GET /meters/:meterId/readings.
 */
export const listReadingsQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .optional(),
  cursor: z.string().min(1).optional(),
});
export type ListReadingsQuery = z.infer<typeof listReadingsQuerySchema>;

/**
 * Coerce the validated body to a service-input shape (Date + Decimal).
 */
export function toCreateReadingServiceInput(
  meterId: string,
  body: CreateReadingInput
): {
  meterId: string;
  readingDate: Date;
  readingValue: string;
  notes: string | null;
} {
  return {
    meterId,
    readingDate: new Date(`${body.readingDate}T00:00:00.000Z`),
    readingValue: typeof body.readingValue === 'string'
      ? body.readingValue
      : body.readingValue.toString(),
    notes: body.notes ?? null,
  };
}
