// src/modules/admin/admin.controller.ts
//
// Phase 19: thin handlers for /api/v1/admin/*.
//   GET   /users/search
//   POST  /listings/:id/takedown
//   POST  /listings/:id/reinstate
//
// Schemas live in this file (rather than a separate *.schemas.ts) per
// the Phase 19 plan — keeps the file count to exactly the 7 files in
// phases.json's files_allowed.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';

import { reinstateListing, searchUsers, takedownListing } from './admin.service';

// ──────────────────────────────────────────────────────────────────────
// Zod schemas (inline)
// ──────────────────────────────────────────────────────────────────────

export const searchUsersQuerySchema = z
  .object({
    q: z.string().min(1, 'q is required').max(120),
    revealPii: z
      .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
      .optional()
      .transform((v) => v === true || v === 'true' || v === '1'),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const listingIdParamsSchema = z
  .object({
    id: z.string().uuid({ message: 'id must be a UUID' }),
  })
  .strict();

export const takedownBodySchema = z
  .object({
    reason: z.string().min(1, 'reason is required').max(500),
  })
  .strict();

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort extraction of caller IP + user-agent for audit logging.
 * Trusts `req.ip` (set by app.set('trust proxy', 1)) and falls back to
 * raw socket address. userAgent may be null for programmatic callers.
 */
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
// GET /users/search
// ──────────────────────────────────────────────────────────────────────

export const searchUsersHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { ipAddress, userAgent } = extractRequestContext(req);
  const data = await searchUsers(
    {
      q: req.query.q as string,
      revealPii: (req.query.revealPii as unknown as boolean) ?? false,
      limit: Number(req.query.limit ?? 20),
      cursor: (req.query.cursor as string | undefined) ?? null,
    },
    callerUserId,
    ipAddress,
    userAgent
  );
  res.status(200).json(ok(data, 'Users retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /listings/:id/takedown
// ──────────────────────────────────────────────────────────────────────

export const takedownListingHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { ipAddress, userAgent } = extractRequestContext(req);
  const { id } = req.params as unknown as z.infer<typeof listingIdParamsSchema>;
  const { reason } = req.body as z.infer<typeof takedownBodySchema>;
  const data = await takedownListing({
    propertyId: id,
    reason,
    callerUserId,
    ipAddress,
    userAgent,
  });
  res.status(200).json(ok(data, 'Listing taken down'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /listings/:id/reinstate
// ──────────────────────────────────────────────────────────────────────

export const reinstateListingHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { ipAddress, userAgent } = extractRequestContext(req);
  const { id } = req.params as unknown as z.infer<typeof listingIdParamsSchema>;
  const data = await reinstateListing({
    propertyId: id,
    callerUserId,
    ipAddress,
    userAgent,
  });
  res.status(200).json(ok(data, 'Listing reinstated'));
});
