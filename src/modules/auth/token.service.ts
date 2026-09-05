// src/modules/auth/token.service.ts
//
// Token minting, rotation, and revocation. The single source of truth
// for the access-token Redis schema (`access:{sha256(token)} → user_id`,
// TTL 900s) and the refresh-token PG schema (id = sha256(raw)).
//
// Rotation uses compare-and-swap: a reused refresh token triggers
// family-wide revocation per 06 §6.4.

import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

import { prisma } from '@/lib/db';
import { redis } from '@/lib/redis';

const ACCESS_TTL_SECONDS = 900; // 15m per 06 §6.1
const REFRESH_TTL_DAYS = 30; // 06 §6.1

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function generateOpaqueToken(): string {
  // 32 random bytes → base64url (43 chars unpadded). url-safe.
  return randomBytes(32).toString('base64url');
}

export interface MintedAccess {
  token: string;
  expiresIn: number;
}

export interface MintedRefresh {
  token: string;
  expiresAt: Date;
  familyId: string;
}

/** Mint an access token + write it to Redis. */
export async function mintAccessToken(userId: string): Promise<MintedAccess> {
  const token = generateOpaqueToken();
  await redis.set(`access:${sha256Hex(token)}`, userId, 'EX', ACCESS_TTL_SECONDS);
  return { token, expiresIn: ACCESS_TTL_SECONDS };
}

/**
 * Mint a refresh token and persist its hash.
 *
 * - familyId: if provided, reuse the family (rotation case). Otherwise
 *   mint a new UUID — every login creates a new family.
 */
export async function mintRefreshToken(
  userId: string,
  opts: { familyId?: string; userAgent?: string; ip?: string } = {}
): Promise<MintedRefresh> {
  const token = generateOpaqueToken();
  const id = sha256Hex(token);
  const familyId = opts.familyId ?? uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      id,
      userId,
      familyId,
      expiresAt,
      userAgent: opts.userAgent ?? null,
      ip: opts.ip ?? null,
    },
  });

  return { token, expiresAt, familyId };
}

export type RevokeResult =
  | { kind: 'rotated'; familyId: string; userId: string }
  | { kind: 'reuse-detected'; familyId: string; userId: string; revokedCount: number }
  | { kind: 'not-found' }
  | { kind: 'expired' };

/**
 * Compare-and-swap revocation. Used by the refresh-rotation flow.
 *
 * Behaviour:
 *   - Row not found                            → 'not-found'
 *   - Row found, already revoked               → 'reuse-detected'
 *     (revoke every other row in the family and return the count)
 *   - Row found, revoked_at is null, expiresAt
 *     in the past                              → 'expired'
 *   - Row found, valid                         → 'rotated' (caller now
 *     inserts the new refresh row in the same family)
 */
export async function revokeRefreshByRaw(rawToken: string): Promise<RevokeResult> {
  const id = sha256Hex(rawToken);
  const now = new Date();

  // CAS update: only succeeds if revoked_at is still null.
  const updated = await prisma.refreshToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: now },
  });

  if (updated.count === 0) {
    // Either the row never existed, or it was already revoked.
    const existing = await prisma.refreshToken.findUnique({ where: { id } });
    if (!existing) return { kind: 'not-found' };
    // Already revoked → reuse detection: kill the whole family.
    const revoked = await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return {
      kind: 'reuse-detected',
      familyId: existing.familyId,
      userId: existing.userId,
      revokedCount: revoked.count,
    };
  }

  // We just revoked the row; now read it back to learn the family.
  const row = await prisma.refreshToken.findUnique({ where: { id } });
  if (!row) return { kind: 'not-found' };
  if (row.expiresAt.getTime() < now.getTime()) return { kind: 'expired' };

  return { kind: 'rotated', familyId: row.familyId, userId: row.userId };
}

/** Revoke every active refresh token for a user. Returns rows touched. */
export async function revokeAllRefreshForUser(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** Delete the Redis access-token entry that backs a raw token. */
export async function killAccess(rawToken: string): Promise<void> {
  await redis.del(`access:${sha256Hex(rawToken)}`);
}

// ──────────────────────────────────────────────────────────────────────
// Login throttle (06 §6.4): 5 fails / 15 min / email
// ──────────────────────────────────────────────────────────────────────

const LOGIN_FAIL_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

function loginKey(email: string): string {
  return `ratelimit:login:${email.toLowerCase()}`;
}

export async function isLoginLocked(email: string): Promise<boolean> {
  const count = await redis.get(loginKey(email));
  return count !== null && Number(count) >= LOGIN_FAIL_LIMIT;
}

export async function incrementLoginFails(email: string): Promise<number> {
  const key = loginKey(email);
  // INCR + EXPIRE in a single MULTI so the TTL is set on first hit.
  const results = await redis.multi().incr(key).expire(key, LOGIN_WINDOW_SECONDS, 'NX').exec();
  const incrResult = results?.[0];
  const newCount = Array.isArray(incrResult) ? Number(incrResult[1]) : Number(incrResult);
  return newCount;
}

export async function resetLoginFails(email: string): Promise<void> {
  await redis.del(loginKey(email));
}
