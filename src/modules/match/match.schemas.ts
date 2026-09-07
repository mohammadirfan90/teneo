// src/modules/match/match.schemas.ts
//
// Phase 20: zod schemas for /api/v1/match/* per 13 §13.2.4, 05 §5.1.
//
// Endpoints:
//   POST /run                            runMatch (TENANT)
//   GET  /results                        listMyResults (TENANT)
//   POST /results/:match_id/intro        openIntro (TENANT)
//   POST /intro-requests/:id/accept      acceptIntro (TENANT)
//   POST /intro-requests/:id/decline     declineIntro (TENANT)

import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────────
// Path / query params
// ──────────────────────────────────────────────────────────────────────

export const matchIdParamsSchema = z.object({
  match_id: z.string().uuid({ message: 'match_id must be a UUID' }),
});
export type MatchIdParams = z.infer<typeof matchIdParamsSchema>;

export const introIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'id must be a UUID' }),
});
export type IntroIdParams = z.infer<typeof introIdParamsSchema>;

export const runMatchBodySchema = z
  .object({
    /**
     * Optional override for the top-N cap. Defaults to 20 in the
     * controller. Caller-supplied values are clamped to [1, 50] to
     * keep the response payload bounded.
     */
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .default({});
export type RunMatchInput = z.infer<typeof runMatchBodySchema>;

export const runMatchQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
export type RunMatchQuery = z.infer<typeof runMatchQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// No body schemas — /accept, /decline, /intro are POSTs with empty body
// (just path params drive them).
// ──────────────────────────────────────────────────────────────────────
