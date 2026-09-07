// src/modules/bills/meters.schemas.ts
//
// Zod schemas for /api/v1/properties/:propertyId/meters and
// /api/v1/meters/:meterId/*.

import { z } from 'zod';

/**
 * POST /properties/:propertyId/meters body.
 */
export const createMeterSchema = z
  .object({
    utilityType: z.enum(['WATER', 'ELECTRICITY', 'GAS', 'INTERNET'], {
      message: 'utilityType must be one of WATER, ELECTRICITY, GAS, INTERNET',
    }),
    label: z.string().min(1).max(120),
    ratePerUnitMinor: z
      .union([z.string(), z.number()])
      .transform((v) => {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error('ratePerUnitMinor must be a non-negative number');
        }
        return BigInt(Math.trunc(n));
      }),
    currency: z
      .string()
      .length(3, 'currency must be a 3-letter ISO 4217 code')
      .regex(/^[A-Z]{3}$/, 'currency must be uppercase ISO 4217'),
    unitLabel: z.string().min(1).max(40),
  })
  .strict();
export type CreateMeterInput = z.infer<typeof createMeterSchema>;

/**
 * Params for /properties/:propertyId/meters.
 */
export const propertyIdParamsSchema = z.object({
  propertyId: z.string().uuid({ message: 'propertyId must be a UUID' }),
});
export type PropertyIdParams = z.infer<typeof propertyIdParamsSchema>;
