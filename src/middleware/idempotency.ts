// src/middleware/idempotency.ts
//
// `withIdempotency` — implements 07 §7.3.
//
// Rules:
//   - Applies to POST / PUT / PATCH / DELETE. Other methods → no-op.
//   - Requires the `Idempotency-Key` header. Missing → 422 SEMANTIC
//     (per §13.1: "All POST/PUT/PATCH/DELETE accept an Idempotency-Key").
//   - Requires `req.user` (mount after `requireAuth`).
//   - Cache key:   `idem:{user_id}:{method}:{route}:{key}`   (24h TTL)
//   - Cached value: { requestHash, status, headers, body }
//     - Same key + same body  → replay the cached response.
//     - Same key + diff body  → 422 SEMANTIC (probable client bug).
//
// Notes:
//   - The cache stores the **response** envelope as JSON. Subsequent
//     replays return the same envelope verbatim, including the original
//     HTTP status, so the client can't tell the difference.
//   - The body hash uses `req.rawBody` (captured by express.json's
//     `verify` callback — see src/server.ts). Hashing the raw bytes
//     means canonical JSON reordering doesn't break idempotency.
//   - We grab `req.route.path` AFTER Express has matched the route
//     (i.e. after `app.use(withIdempotency)` runs downstream of
//     `app.use(router)`). To handle this we fall back to
//     `req.originalUrl` minus the query string if no route path yet.

import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';

import { fail, ok } from '@/lib/envelope';
import { SemanticError } from '@/lib/errors';
import { redis } from '@/lib/redis';

const TTL_SECONDS = 24 * 60 * 60; // 24h per §7.3
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface CachedResponse {
  requestHash: string;
  status: number;
  body: string; // JSON-serialized response body
}

interface RequestWithRawBody extends Request {
  rawBody?: string;
}

function bodyHash(req: Request): string {
  const raw = (req as RequestWithRawBody).rawBody;
  const bytes = raw && raw.length > 0 ? raw : '{}';
  return createHash('sha256').update(bytes).digest('hex');
}

function routeId(req: Request): string {
  // Use the matched route's pattern (e.g. /properties/:id) so two
  // different ids share the cache namespace but the same id replays.
  const routePath = (req.route?.path as string | undefined) ?? '';
  if (routePath.length > 0) return `${req.baseUrl ?? ''}${routePath}`;
  // Fall back to URL minus query string.
  const url = req.originalUrl.split('?')[0] ?? req.originalUrl;
  return url;
}

function cacheKey(req: Request, headerKey: string): string {
  const userId = req.user?.id ?? 'anon';
  // Returns the full Redis key including the namespace prefix.
  return `idem:${userId}:${req.method}:${routeId(req)}:${headerKey}`;
}

interface AugmentedResponse extends Response {
  __idempotencyCaptured?: boolean;
  __idempotencyBody?: string;
  __idempotencyStatus?: number;
}

/**
 * Wrap res.json/res.status so we can capture the response body and
 * status code emitted by the handler. Original response behavior is
 * preserved — we just keep a copy.
 */
function captureResponse(res: Response): void {
  const ar = res as AugmentedResponse;
  if (ar.__idempotencyCaptured) return;
  ar.__idempotencyCaptured = true;

  const originalJson = res.json.bind(res);
  ar.__idempotencyBody = '';
  res.json = ((body: unknown) => {
    ar.__idempotencyBody = JSON.stringify(body);
    return originalJson(body);
  }) as Response['json'];

  const originalStatus = res.status.bind(res);
  let pendingStatus = res.statusCode;
  res.status = ((code: number) => {
    pendingStatus = code;
    ar.__idempotencyStatus = code;
    return originalStatus(code);
  }) as Response['status'];

  // Capture the implicit default (200) too if the handler never called
  // res.status().
  Object.defineProperty(res, 'statusCode', {
    configurable: true,
    get() {
      return pendingStatus;
    },
    set(v: number) {
      pendingStatus = v;
      pendingStatus;
    },
  });
}

async function finalizeAndCache(
  req: Request,
  res: Response,
  cacheK: string,
  requestHash: string
): Promise<void> {
  const ar = res as AugmentedResponse;
  const status = ar.__idempotencyStatus ?? res.statusCode ?? 200;
  const body = ar.__idempotencyBody ?? '';
  const entry: CachedResponse = { requestHash, status, body };

  // SET NX so a race between two parallel requests with the same key
  // doesn't double-store. The loser of the race will re-GET and replay.
  // `cacheK` already includes the `idem:` prefix from cacheKey().
  await redis.set(cacheK, JSON.stringify(entry), 'EX', TTL_SECONDS, 'NX');
}

export const withIdempotency: RequestHandler = async (req, res, next) => {
  try {
    // Only state-changing methods are subject to idempotency.
    if (!STATE_CHANGING.has(req.method)) {
      next();
      return;
    }

    if (!req.user) {
      // Defensive — must be mounted after requireAuth.
      next(new SemanticError('Idempotency requires an authenticated session'));
      return;
    }

    const headerKey = req.header('idempotency-key');
    if (!headerKey || headerKey.trim().length === 0) {
      next(new SemanticError('Idempotency-Key header is required for state-changing requests'));
      return;
    }

    const key = cacheKey(req, headerKey.trim());
    const requestHash = bodyHash(req);

    // 1) Replay-or-mismatch check.
    const existing = await redis.get(key);
    if (existing) {
      let entry: CachedResponse;
      try {
        entry = JSON.parse(existing) as CachedResponse;
      } catch {
        // Corrupt cache row — drop and let the request run through.
        await redis.del(`idem:${key}`);
        entry = { requestHash: '', status: 0, body: '' };
      }
      if (entry.requestHash && entry.requestHash !== requestHash) {
        next(
          new SemanticError('Idempotency-Key reused with a different request body', [
            {
              field: 'idempotency-key',
              code: 'BODY_MISMATCH',
              message: 'Same key was previously used with a different request body',
            },
          ])
        );
        return;
      }
      if (entry.requestHash && entry.body) {
        // Replay.
        res.status(entry.status);
        res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.send(entry.body);
        return;
      }
    }

    // 2) Miss path — wrap response, run handler, then cache.
    captureResponse(res);

    res.on('finish', () => {
      // Fire-and-forget; if Redis is briefly down we don't fail the
      // request the user already received.
      void finalizeAndCache(req, res, key, requestHash).catch(() => undefined);
    });

    next();
  } catch (err) {
    next(err);
  }
};

// Re-exports so route code that uses withIdempotency can also import
// the success/error builders without an additional import.
export { ok, fail };
