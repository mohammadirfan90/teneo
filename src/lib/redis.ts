// src/lib/redis.ts
//
// ioredis singleton, hot-reload safe. Used by:
//   - rate-limit middleware  (rate-limit-redis store)
//   - auth middleware        (access:{sha256(token)} → user_id)
//   - idempotency middleware (idem:{user_id}:{method}:{route}:{key})
//
// Mirrors src/lib/db.ts: a single connection pool per process keeps
// counts predictable; the global cache survives tsx watch reloads.
//
// Why ioredis and not node-redis:
//   - ioredis has better cluster/sentinel support for future scaling.
//   - rate-limit-redis v4 speaks ioredis natively.
//   - Lazy-connect is opt-out (we want fail-fast on a missing Redis).
//
// Deployment note:
//   On Render, REDIS_URL is injected from the managed Key Value service
//   declared in render.yaml (internal `redis://`, private network, no TLS).
//   Repointing at an external provider such as Upstash needs no code change
//   either — ioredis enables TLS from a `rediss://` URL on its own.

import { config as loadDotenv } from 'dotenv';
import { Redis } from 'ioredis';

import { env, isProd } from '@/lib/env';
import { logger } from '@/lib/logger';

// Make redis.ts safely importable from any entrypoint (scripts, tests, REPL).
if (!process.env.REDIS_URL) {
  loadDotenv();
}

type GlobalWithRedis = typeof globalThis & { __redis?: Redis };
const g = globalThis as GlobalWithRedis;

function buildClient(): Redis {
  const client = new Redis(env.REDIS_URL, {
    // Dev: fail fast, so a forgotten `docker compose up` is loud rather
    // than a request hanging on a queue that will never drain.
    // Prod: buffer instead. Managed Redis drops idle connections, and with
    // the queue off every command issued mid-reconnect rejects instantly.
    // cache.ts degrades gracefully on that, but the access-token lookup in
    // auth.ts and the rate-limit store would 401/500 a real user over a
    // blip that resolves in milliseconds.
    enableOfflineQueue: isProd,
    // Keep the socket warm so the provider's idle reaper never closes it —
    // reconnecting is the expensive part, not the keepalive probe.
    keepAlive: 10_000,
    // Reasonable defaults; bumps under load are the operator's call.
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
    lazyConnect: false,
  });

  client.on('error', (err: Error) => {
    // Don't crash the process on a transient Redis hiccup; the limiter
    // middleware will surface 5xx when it can't talk to Redis. Log once
    // per error is enough — ioredis emits repeatedly.
    logger.error({ err: err.message }, 'redis_error');
  });

  return client;
}

export const redis: Redis = g.__redis ?? buildClient();

if (!g.__redis) {
  g.__redis = redis;
}

export async function disconnectRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch (err) {
    logger.error({ err }, 'redis disconnect error');
  }
}
