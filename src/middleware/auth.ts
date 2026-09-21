// src/middleware/auth.ts
//
// `requireAuth` — turns `Authorization: Bearer <token>` into `req.user`,
// backed by the Redis access-token store defined in 06 §6.1.
//
// Flow (per 06 §6.1 lifecycle diagram):
//   1. Parse `Authorization: Bearer <opaque-token>`.
//   2. sha256(token) → `redis.get("access:" + hash)`.
//        miss → 401 UNAUTHENTICATED (client should POST /auth/refresh).
//   3. Hit → load user + roles from PG once per request, via Prisma.
//        Soft-deleted (`deleted_at != null`) or non-ACTIVE user → 401.
//   4. Attach `{ id, email, status, roles }` to `req.user`.
//
// Notes:
//   - Tokens are opaque (32 random bytes, base64url). We don't validate
//     any signature here; the Redis key is the source of truth.
//   - There is no MFA flow in v1; do not reintroduce one.

import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

import { prisma } from '@/lib/db';
import { UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { redis } from '@/lib/redis';

export type AppRole = 'TENANT' | 'OWNER' | 'ADMIN';
export type AppUserStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export interface AuthenticatedUser {
  id: string;
  email: string;
  status: AppUserStatus;
  roles: AppRole[];
}

declare global {
  namespace Express {
    // Express's own Request shape; we extend it instead of replacing.
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/** sha256 of an arbitrary string, lowercase hex (32 bytes → 64 chars). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Parse the Bearer header. Returns the raw token (without the "Bearer "
 * prefix) or null if the header is missing/malformed.
 *
 * We deliberately do NOT split on whitespace loosely: a Bearer token
 * must be exactly one space after the scheme.
 */
function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

export const requireAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = extractBearer(req.header('authorization'));
    if (!token) {
      throw new UnauthorizedError('Authentication required');
    }

    const accessKey = `access:${sha256Hex(token)}`;
    const userId = await redis.get(accessKey);
    if (!userId) {
      throw new UnauthorizedError('Token expired or invalid');
    }

    // Load user + roles from PG. Single round-trip per request.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
        deletedAt: true,
        roles: { select: { role: true } },
      },
    });

    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') {
      // Soft-deleted / suspended / deactivated users should NOT be able
      // to keep using their access tokens. We log this so it's visible
      // to operators when an attacker probes with an old token.
      logger.warn(
        { userId, status: user?.status, deleted: !!user?.deletedAt },
        'auth_user_unavailable'
      );
      throw new UnauthorizedError('Account unavailable');
    }

    req.user = {
      id: user.id,
      email: user.email,
      status: user.status,
      roles: user.roles.map((r) => r.role),
    } satisfies AuthenticatedUser;

    next();
  } catch (err) {
    next(err);
  }
};
