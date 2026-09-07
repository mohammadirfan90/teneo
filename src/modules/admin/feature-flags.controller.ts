// src/modules/admin/feature-flags.controller.ts
//
// Phase 19: thin handlers for /api/v1/admin/feature-flags/*.
//   GET   /
//   PUT   /:key
//
// Schemas live in this file per the Phase 19 plan.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { ok } from '@/lib/envelope';

import { listFlags, upsertFlag } from './feature-flags.service';

// ──────────────────────────────────────────────────────────────────────
// Zod schemas (inline)
// ──────────────────────────────────────────────────────────────────────

export const flagKeyParamsSchema = z
  .object({
    key: z
      .string()
      .min(1, 'key is required')
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'key must be lowercase snake_case'),
  })
  .strict();

export const upsertFlagBodySchema = z
  .object({
    enabled: z.boolean(),
    description: z.string().max(500).optional(),
  })
  .strict();

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function extractRequestContext(req: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const ip = (req.ip ?? req.socket?.remoteAddress ?? null) as string | null;
  return {
    ipAddress: ip,
    userAgent: (req.get('user-agent') ?? null) as string | null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// GET /
// ──────────────────────────────────────────────────────────────────────

export const listFlagsHandler: RequestHandler = asyncHandler(async (_req, res) => {
  const data = await listFlags();
  res.status(200).json(ok(data, 'Feature flags retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// PUT /:key
// ──────────────────────────────────────────────────────────────────────

export const upsertFlagHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { ipAddress, userAgent } = extractRequestContext(req);
  const { key } = req.params as unknown as z.infer<typeof flagKeyParamsSchema>;
  const { enabled, description } = req.body as z.infer<typeof upsertFlagBodySchema>;
  const data = await upsertFlag({
    key,
    enabled,
    description: description ?? null,
    callerUserId,
    ipAddress,
    userAgent,
  });
  res.status(200).json(ok(data, 'Feature flag upserted'));
});
