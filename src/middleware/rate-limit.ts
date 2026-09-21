// src/middleware/rate-limit.ts
//
// Per-role rate limiting per 13 §13.5.
//
// Two stacked limiters:
//
//   1. `anonymousRateLimiter` — per-IP, mounted globally BEFORE
//      `requireAuth`. Burst = 20 over 1s window (per §13.5 anon row).
//      Protects public endpoints (auth flows, search, health-adjacent).
//
//   2. `authenticatedRateLimiter` — per-user, mounted AFTER `requireAuth`
//      on protected routes. Selects `max` based on req.user.roles:
//        ADMIN        → 200
//        OWNER|TENANT → 60
//        USER         → 40 (fallback for role-less users)
//      Same 1s window as the anonymous limiter so a logged-in user
//      counts against BOTH buckets if both apply.
//
// Why two limiters, not one:
//   - The anonymous limiter must run before auth so we can reject
//     pre-auth floods before doing a Redis access-token lookup.
//   - The per-role limiter needs req.user populated, so it runs after.
//   - Stacking them matches §13.5's "per role" wording while still
//     protecting public endpoints from pre-auth abuse.
//
// Why `max = burst` over a 1s window:
//   express-rate-limit v7 has no native RPS-vs-burst distinction. We
//   approximate by allowing the burst budget over a 1-second window.
//   Long-window average RPS is enforced by route-specific stricter
//   limits (e.g. login throttle in Phase 6 uses a separate 15-min window).
//
// Both limiters emit the standard 429 envelope via their `handler`.

import type { NextFunction, Request, Response } from 'express';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import type { SendCommandFn } from 'rate-limit-redis';
import { RedisStore } from 'rate-limit-redis';

import { redis } from '@/lib/redis';

const ANON_BURST = 20; // §13.5 Anonymous: 10 RPS / 20 burst
const ANON_WINDOW_MS = 1000;

const AUTH_USER_MAX = 40; // §13.5 Authenticated USER: 20 RPS / 40 burst
const AUTH_PRIMARY_MAX = 60; // §13.5 TENANT/OWNER: 30 RPS / 60 burst
const AUTH_ADMIN_MAX = 200; // §13.5 ADMIN: 100 RPS / 200 burst

const redisStore = (prefix: string): RedisStore => {
  // rate-limit-redis v4: pass `sendCommand` so we use the existing
  // ioredis client (one connection pool, no extra sockets). ioredis's
  // reply type is broader than RedisReply at compile time; cast at the
  // boundary — every command rate-limit-redis issues returns either a
  // string or number at runtime.
  const store = new RedisStore({
    sendCommand: ((...args: string[]) =>
      redis.call(...(args as [string, ...string[]]))) as unknown as SendCommandFn,
    prefix,
  });

  // RedisStore's constructor eagerly fires two `SCRIPT LOAD` commands and
  // parks the promises on these fields. Because the limiters are built at
  // module load — before ioredis has connected — and the client runs with
  // `enableOfflineQueue: false` in dev (src/lib/redis.ts), those commands
  // reject instead of waiting, and nothing is awaiting them yet. That
  // produced four unhandled rejections on every boot: two stores x two
  // scripts. In production the queue is on, so they simply resolve once the
  // connection lands; allSettled covers both shapes.
  //
  // Nothing is actually broken: `retryableIncrement` catches the rejected
  // sha, reloads the script, and retries on the first real request, by
  // which point Redis is connected. So we only need to mark these as
  // handled. Swallowing here is safe precisely because the library owns
  // the recovery path — do not "fix" this by awaiting the shas at boot.
  void Promise.allSettled([store.incrementScriptSha, store.getScriptSha]);

  return store;
};

/**
 * Custom 429 handler. Returns the standard envelope so callers don't
 * have to special-case express-rate-limit's default text body.
 */
function rateLimitHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
  options: Options
): void {
  const retryAfterSec = Math.ceil(options.windowMs / 1000);
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({
    success: false,
    message: 'Too many requests',
    errors: [
      {
        field: 'retry-after',
        code: 'RATE_LIMITED',
        message: `Retry after ${retryAfterSec}s`,
      },
    ],
  });
  // Mark so request-log middleware can tag this as throttled.
  (req as Request & { throttled?: boolean }).throttled = true;
}

/** Per-IP limiter for unauthenticated requests. Burst 20 / 1s. */
export const anonymousRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: ANON_WINDOW_MS,
  limit: ANON_BURST,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:anon:'),
  keyGenerator: (req: Request): string => req.ip ?? 'unknown',
  handler: rateLimitHandler,
});

/**
 * Per-user limiter for authenticated routes. Selects max from roles.
 * Must be mounted AFTER `requireAuth`.
 */
export const authenticatedRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: ANON_WINDOW_MS,
  // Do NOT also set `limit` here. express-rate-limit v7 resolves the
  // effective cap from `config.limit` only (dist/index.cjs:730); `max` is
  // merely the deprecated alias, folded in as the *default* value of
  // `limit`. Passing an explicit numeric `limit` therefore overwrites the
  // per-role `max` callback below and it is never invoked — which silently
  // capped ADMIN at 40 instead of 200, and OWNER/TENANT at 40 instead
  // of 60. Leaving `limit` unset lets the callback become `config.limit`.
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: redisStore('rl:auth:'),
  keyGenerator: (req: Request): string => {
    return req.user?.id ?? req.ip ?? 'unknown';
  },
  max: (req: Request): number => {
    const roles = req.user?.roles ?? [];
    if (roles.includes('ADMIN')) return AUTH_ADMIN_MAX;
    if (roles.includes('OWNER') || roles.includes('TENANT')) return AUTH_PRIMARY_MAX;
    return AUTH_USER_MAX;
  },
  handler: rateLimitHandler,
});
