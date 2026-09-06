// src/modules/leases/leases.schemas.ts
//
// Zod schemas for /api/v1/leases body / query / params inputs.
//
// Names match the route path so they're easy to grep from the
// controller. Zod enum tuples duplicate Prisma enum values so the
// inferred types stay narrow (see applications.schemas.ts for the
// rationale).

import { z } from 'zod';

import type {
  LeaseAmendmentStatus as LeaseAmendmentStatusEnum,
  LeasePartyRole as LeasePartyRoleEnum,
  LeaseStatus as LeaseStatusEnum,
} from '@/generated/prisma/enums';

// ──────────────────────────────────────────────────────────────────────
// Enums (mirror Prisma enum values exactly — kept in sync via tests).
// ──────────────────────────────────────────────────────────────────────

const leaseStatusValues = [
  'DRAFT',
  'SIGNED',
  'ACTIVE',
  'ENDED',
  'TERMINATED',
] as const satisfies readonly LeaseStatusEnum[];

const leasePartyRoleValues = ['OWNER', 'TENANT'] as const satisfies readonly LeasePartyRoleEnum[];

const leaseAmendmentStatusValues = [
  'PROPOSED',
  'SIGNED',
  'REJECTED',
] as const satisfies readonly LeaseAmendmentStatusEnum[];

// ──────────────────────────────────────────────────────────────────────
// Body schemas
// ──────────────────────────────────────────────────────────────────────

/** POST /leases/:id/sign — body is empty; presence of Bearer = signature. */
export const signLeaseSchema = z
  .object({
    /** Optional human-readable acknowledgement from the signer. */
    acknowledge: z.string().max(500).optional(),
  })
  .strict();
export type SignLeaseInput = z.infer<typeof signLeaseSchema>;

/** POST /leases/:id/confirm-move-in — body is empty; the tenant asserts they've moved in. */
export const confirmMoveInSchema = z
  .object({
    /** ISO datetime the tenant confirms they moved in (defaults to now). */
    moveInAt: z.string().datetime().optional(),
  })
  .strict();
export type ConfirmMoveInInput = z.infer<typeof confirmMoveInSchema>;

/** POST /leases/:id/terminate — early termination requires a reason. */
export const terminateLeaseSchema = z
  .object({
    reason: z
      .string()
      .min(1, 'reason must not be empty')
      .max(1000, 'reason must be at most 1000 characters'),
  })
  .strict();
export type TerminateLeaseInput = z.infer<typeof terminateLeaseSchema>;

/** POST /leases/:id/amend — propose an amendment. Real schema in Phase 14. */
export const proposeAmendmentSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()),
    note: z.string().max(1000).optional(),
  })
  .strict();
export type ProposeAmendmentInput = z.infer<typeof proposeAmendmentSchema>;

/** POST /leases/:id/amendments/:aid/sign — body is empty; sign = sign. */
export const signAmendmentSchema = z
  .object({
    acknowledge: z.string().max(500).optional(),
  })
  .strict();
export type SignAmendmentInput = z.infer<typeof signAmendmentSchema>;

// ──────────────────────────────────────────────────────────────────────
// Params schemas
// ──────────────────────────────────────────────────────────────────────

export const leaseIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'lease id must be a UUID' }),
});
export type LeaseIdParams = z.infer<typeof leaseIdParamsSchema>;

export const amendmentIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'lease id must be a UUID' }),
  aid: z.string().uuid({ message: 'amendment id must be a UUID' }),
});
export type AmendmentIdParams = z.infer<typeof amendmentIdParamsSchema>;

// ──────────────────────────────────────────────────────────────────────
// Re-exports for callers that want the enum tuple without re-importing.
// ──────────────────────────────────────────────────────────────────────
export { leaseStatusValues, leasePartyRoleValues, leaseAmendmentStatusValues };