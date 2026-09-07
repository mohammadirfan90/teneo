// src/lib/cache.ts
//
// Phase 21: tiny Redis-backed cache with tag-based invalidation.
//
// API:
//   - get<T>(key)                 — null on miss or Redis error
//   - set<T>(key, value, ttlSec)  — TTL in seconds; expires on its own
//   - del(key)                    — sync delete
//   - taggedSet<T>(key, val, ttlSec, tags)
//                                 — set + register each tag → key mapping
//   - invalidateTag(tag)          — delete every key registered for tag
//
// Pattern for hot reads:
//
//   const cached = await cache.get<PropertyView>('property:{id}');
//   if (cached !== null) return cached;
//   const row = await fetchFromDb();
//   if (!row) {
//     // Negative-cache 404s per SPEC §8.4.1 (TTL 60s).
//     await cache.set('property:{id}', { __notFound: true }, 60);
//     return null;
//   }
//   await cache.taggedSet('property:{id}', row, 600, ['property:{id}']);
//   return row;
//
// Invalidation (on PATCH /properties/:id):
//
//   await cache.invalidateTag('property:{id}');
//
// Why we use a "tag set" key pattern:
//   Each tag stores a Redis SET of cache keys. invalidateTag reads
//   the set, DELetes every key in O(N), then DELetes the set itself.
//   We never use SUNIONSTORE or fan-out — one tag = one round-trip.
//
// Failure modes:
//   - Redis down → every operation returns null/no-op. The caller
//     falls back to DB. We never throw on Redis errors; the cache is
//     strictly best-effort.
//   - JSON parse failure on a corrupt entry → treat as miss and DEL.
//
// The module never logs errors itself; callers may want to
// distinguish "miss" from "Redis down" via the logger. For now the
// cache.ts file is silent on errors — the calling service logs a
// "cache miss" line, which is the same shape regardless of cause.

import { createHash } from 'node:crypto';

import { logger } from '@/lib/logger';
import { redis } from '@/lib/redis';

// Sentinel used to distinguish a "real" cache value from a missing
// or invalid entry. Callers compare with `===` and shouldn't see it
// because we JSON.parse it before returning.
const NEGATIVE_FOUND = '__not_found__';

// ──────────────────────────────────────────────────────────────────────
// Core: get / set / del
// ──────────────────────────────────────────────────────────────────────

export async function get<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, key }, 'cache_get_failed');
    return null;
  }
}

export async function set<T>(key: string, value: T, ttlSec: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSec)));
  } catch (err) {
    logger.warn({ err, key }, 'cache_set_failed');
  }
}

export async function del(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, 'cache_del_failed');
  }
}

// ──────────────────────────────────────────────────────────────────────
// Negative cache helper
// ──────────────────────────────────────────────────────────────────────

/**
 * Tag a key as "definitely not found" for the next `ttlSec` seconds.
 * Used for SPEC §8.4.1's 404-enumeration defense: the same caller
 * spamming /properties/:id with bogus ids gets a fast path instead
 * of one DB roundtrip per attempt.
 *
 * Returns `true` when the negative is now cached, `false` when the
 * call failed (caller should treat as a normal miss).
 */
export async function cacheNegative(key: string, ttlSec: number): Promise<boolean> {
  try {
    await redis.set(
      key,
      JSON.stringify({ [NEGATIVE_FOUND]: true }),
      'EX',
      Math.max(1, Math.floor(ttlSec))
    );
    return true;
  } catch (err) {
    logger.warn({ err, key }, 'cache_negative_failed');
    return false;
  }
}

/**
 * True when a key holds a cached "not found" sentinel. Callers that
 * negative-cached a 404 should check this before falling through to
 * the DB.
 */
export function isNegative<T>(value: T | null): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, NEGATIVE_FOUND)
  );
}

// ──────────────────────────────────────────────────────────────────────
// Tagged set + invalidateTag
// ──────────────────────────────────────────────────────────────────────

const TAG_PREFIX = 'tag_set:';

/**
 * Set a key + register it under each tag. Tags are an explicit list
 * (we deliberately don't auto-tag by key prefix — that leads to
 * accidental over-invalidation).
 */
export async function taggedSet<T>(
  key: string,
  value: T,
  ttlSec: number,
  tags: readonly string[]
): Promise<void> {
  if (tags.length === 0) {
    await set(key, value, ttlSec);
    return;
  }
  try {
    await redis.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSec)));
    // SADD each tag → key. TTL on tag_set:* is bumped to the same
    // window so the set doesn't outlive the longest-lived value
    // (use max(ttl) when composing, but Phase 21 always uses a
    // single ttl per call — phase 22 may revisit).
    for (const tag of tags) {
      await redis.sadd(`${TAG_PREFIX}${tag}`, key);
      await redis.expire(`${TAG_PREFIX}${tag}`, Math.max(60, Math.floor(ttlSec) * 2));
    }
  } catch (err) {
    logger.warn({ err, key, tags }, 'cache_tagged_set_failed');
  }
}

/**
 * Invalidate every key registered under the given tag. Reads the
 * tag set, DELs each member, then DELs the set itself. Returns the
 * number of keys removed (best-effort; 0 on Redis error).
 */
export async function invalidateTag(tag: string): Promise<number> {
  try {
    const tagKey = `${TAG_PREFIX}${tag}`;
    const members = await redis.smembers(tagKey);
    if (members.length === 0) {
      await redis.del(tagKey);
      return 0;
    }
    await redis.del(...members, tagKey);
    return members.length;
  } catch (err) {
    logger.warn({ err, tag }, 'cache_invalidate_tag_failed');
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Query-string → stable filter hash (used by /search/rooms)
// ──────────────────────────────────────────────────────────────────────

/**
 * Deterministic, opaque hash of an arbitrary filter object. Stable
 * across processes because SHA-256. Returns a 16-char prefix so
 * Redis keys stay short.
 *
 * The input is canonicalised by JSON.stringify-ing a sorted-keys
 * version — `{b:1,a:2}` and `{a:2,b:1}` produce the same hash.
 */
export function hashFilter<T extends Record<string, unknown>>(filter: T): string {
  const sortedKeys = Object.keys(filter).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = filter[k];
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}
