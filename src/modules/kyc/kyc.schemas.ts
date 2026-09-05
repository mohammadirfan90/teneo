// src/modules/kyc/kyc.schemas.ts
//
// Zod validation for /kyc/* endpoints per 06 §6.10 + 09 §9.3.

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// POST /kyc/submissions — user creates a PENDING submission
// ──────────────────────────────────────────────────────────────────────

const KYC_ROLE_VALUES = ['TENANT', 'OWNER'] as const;

/** Minimum sha256 hex length (the hash isn't a secret, just an integrity tag). */
const DOC_HASH = z
  .string()
  .min(64, 'docHash must be sha256 hex (64 chars)')
  .max(64, 'docHash must be sha256 hex (64 chars)')
  .regex(/^[0-9a-f]{64}$/i, 'docHash must be lowercase hex');

/** Object storage key — opaque to us; bounded for sanity. */
const OBJECT_KEY = z.string().min(1).max(512);

export const createSubmissionSchema = z.object({
  role: z.enum(KYC_ROLE_VALUES),
  documentObjectKeys: z
    .array(OBJECT_KEY)
    .min(1, 'At least one document object key is required')
    .max(10, 'At most 10 documents per submission'),
  docHash: DOC_HASH,
});

export type CreateSubmissionInput = z.infer<typeof createSubmissionSchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /kyc/submissions/:id/decision — ADMIN
// ──────────────────────────────────────────────────────────────────────

export const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  notes: z.string().min(1).max(2000),
});

export type DecisionInput = z.infer<typeof decisionSchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /kyc/submissions/:id/request-info — ADMIN
// ──────────────────────────────────────────────────────────────────────

export const requestInfoSchema = z.object({
  notes: z.string().min(1).max(2000),
});

export type RequestInfoInput = z.infer<typeof requestInfoSchema>;

// ──────────────────────────────────────────────────────────────────────
// GET /kyc/queue — ADMIN cursor pagination
// ──────────────────────────────────────────────────────────────────────

export const queueQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type QueueQueryInput = z.infer<typeof queueQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// GET /kyc/submissions/:id
// ──────────────────────────────────────────────────────────────────────

export const submissionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export type SubmissionIdParams = z.infer<typeof submissionIdParamsSchema>;

// Re-export so callers can wire it explicitly.
export { KYC_ROLE_VALUES };
