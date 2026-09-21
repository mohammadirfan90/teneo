// src/modules/applications/applications.schemas.ts
//
// Zod schemas for every body / query / params input under
// /api/v1/applications and /api/v1/viewings. Mirrors the split used
// by rooms.schemas.ts: each schema is exported alongside its inferred
// TypeScript type, and the `params:` schemas live alongside the body
// schemas for co-location.
//
// Why we don't reuse the Prisma `ApplicationStatus` enum directly here:
// Zod's `z.enum` needs a literal tuple at compile time; importing the
// runtime enum object works but the inferred type widens to `string`,
// which loses narrow `ApplicationStatus` in handler signatures. Instead
// we duplicate the tuple and re-cast at the boundary in the service.

import { z } from 'zod';

import type {
  ApplicationStatus as ApplicationStatusEnum,
} from '@/generated/prisma/enums';

// ──────────────────────────────────────────────────────────────────────
// Enums (mirror Prisma enum values exactly — kept in sync via tests).
// ──────────────────────────────────────────────────────────────────────

const applicationStatusValues = [
  'SUBMITTED',
  'SCREENING',
  'VIEWING_SCHEDULED',
  'SHORTLISTED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED',
] as const satisfies readonly ApplicationStatusEnum[];

// ──────────────────────────────────────────────────────────────────────
// Body schemas
// ──────────────────────────────────────────────────────────────────────

/** POST /applications — tenant applies for a room. */
export const createApplicationSchema = z.object({
  roomId: z.string().uuid({ message: 'roomId must be a UUID' }),
  message: z
    .string()
    .min(20, 'message must be at least 20 characters')
    .max(2000, 'message must be at most 2000 characters')
    .optional(),
});
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

/** POST /applications/:id/transition — owner moves the state machine. */
export const transitionApplicationSchema = z.object({
  to: z.enum(applicationStatusValues),
  note: z.string().max(500).optional(),
});
export type TransitionApplicationInput = z.infer<typeof transitionApplicationSchema>;

/** POST /applications/:id/withdraw — tenant pulls their own application. */
export const withdrawApplicationSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type WithdrawApplicationInput = z.infer<typeof withdrawApplicationSchema>;


/** POST /applications/:id/viewing — owner proposes slots. */
export const createViewingSchema = z.object({
  proposedSlots: z
    .array(z.string().datetime({ message: 'each proposedSlot must be an ISO datetime' }))
    .min(1, 'at least one proposedSlot is required')
    .max(20, 'at most 20 proposedSlots are allowed'),
});
export type CreateViewingInput = z.infer<typeof createViewingSchema>;

/** POST /viewings/:id/confirm — picks one proposedSlot. */
export const confirmViewingSchema = z.object({
  confirmedSlot: z.string().datetime({ message: 'confirmedSlot must be an ISO datetime' }),
});
export type ConfirmViewingInput = z.infer<typeof confirmViewingSchema>;

/** POST /viewings/:id/cancel — either party cancels. */
export const cancelViewingSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();
export type CancelViewingInput = z.infer<typeof cancelViewingSchema>;

// ──────────────────────────────────────────────────────────────────────
// Query schemas
// ──────────────────────────────────────────────────────────────────────

/** GET /applications — tenant lists own, owner lists received. */
export const listApplicationsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // Optional filter for owner view: only return apps currently in this state.
  status: z.enum(applicationStatusValues).optional(),
});
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// Params schemas
// ──────────────────────────────────────────────────────────────────────

export const applicationIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'application id must be a UUID' }),
});
export type ApplicationIdParams = z.infer<typeof applicationIdParamsSchema>;

export const viewingIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'viewing id must be a UUID' }),
});
export type ViewingIdParams = z.infer<typeof viewingIdParamsSchema>;
