// src/server.ts
// Express bootstrap. Phase 1: health endpoints + global middleware (helmet,
// cors, correlation, json body parsing, error handler, 404).
// Future phases mount feature routers under /api/v1/...

import cors from 'cors';
import express, { type RequestHandler } from 'express';
import helmet from 'helmet';

import { prisma } from '@/lib/db';
import { corsOrigins, env } from '@/lib/env';
import { ok } from '@/lib/envelope';
import { ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { redis } from '@/lib/redis';
import { zodValidate } from '@/lib/validate';
import { correlationIdMiddleware } from '@/middleware/correlation-id';
import { errorHandler } from '@/middleware/error-handler';
import { notFoundHandler } from '@/middleware/not-found';
import { anonymousRateLimiter, authenticatedRateLimiter } from '@/middleware/rate-limit';
import { protectedDemoRouter } from '@/modules/_demo/protected.routes';
import { adminRouter } from '@/modules/admin/admin.routes';
import { featureFlagsRouter } from '@/modules/admin/feature-flags.routes';
import { applicationsRouter } from '@/modules/applications/applications.routes';
import { viewingsRouter } from '@/modules/applications/viewings.routes';
import { authRouter } from '@/modules/auth/auth.routes';
import { billsRouter } from '@/modules/bills/bills.routes';
import { metersRouter } from '@/modules/bills/meters.routes';
import { readingsRouter } from '@/modules/bills/readings.routes';
import { documentsRouter } from '@/modules/documents/documents.routes';
import { invoicesRouter } from '@/modules/invoices/invoices.routes';
import { kycRouter } from '@/modules/kyc/kyc.routes';
import { leasesRouter } from '@/modules/leases/leases.routes';
import { ticketsRoomRouter, ticketsRouter } from '@/modules/maintenance/tickets.routes';
import { matchRouter } from '@/modules/match/match.routes';
import { notificationsRouter } from '@/modules/notifications/notifications.routes';
import { stripeWebhookHandler } from '@/modules/payments/payments.controller';
import { paymentsRouter } from '@/modules/payments/payments.routes';
import { buildingsRouter } from '@/modules/properties/buildings.routes';
import { flatsRouter } from '@/modules/properties/flats.routes';
import { propertiesRouter } from '@/modules/properties/properties.routes';
import { roomsRouter } from '@/modules/properties/rooms.routes';
import { searchPublicRouter, searchSavedRouter } from '@/modules/search/search.routes';
import { preferencesRouter } from '@/modules/users/preferences.routes';
import { profilesRouter } from '@/modules/users/profiles.routes';
import { usersRouter } from '@/modules/users/users.routes';
import { z } from 'zod';

export function createApp(): express.Express {
  const app = express();

  // Trust the first proxy so X-Forwarded-* headers are honored (Render, Vercel).
  app.set('trust proxy', 1);

  // Security headers per NFR-21.
  app.use(helmet());

  // CORS per NFR-22. Allow comma-separated origins from env; empty = same-origin.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // server-to-server / curl
        if (corsOrigins.length === 0) return callback(null, true);
        if (corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: false, // Bearer tokens — no cookies
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    })
  );

  // Body parsing with a tight limit to deflect payload-overflow DoS.
  // The `verify` callback stashes the raw bytes on req.rawBody so the
  // idempotency middleware (07 §7.3) can hash the canonical request body
  // regardless of how Express has parsed it.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        const r = req as express.Request & { rawBody?: string };
        r.rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Correlation ID on every request + response.
  app.use(correlationIdMiddleware);

  // Request log line with correlation id; very lightweight (no body).
  app.use(((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info(
        {
          correlationId: (req as { correlationId?: string }).correlationId,
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Date.now() - start,
        },
        'request'
      );
    });
    next();
  }) as RequestHandler);

  // ── Health endpoints ────────────────────────────────────────────────
  // /health/live: liveness — process is up. Spec §13.2.11.
  app.get('/health/live', (_req, res) => {
    res.status(200).json({
      success: true,
      message: 'alive',
      data: { status: 'ok', service: 'housing-platform-backend' },
    });
  });

  // /health/ready: readiness — full subsystem check (Phase 22).
  // Pings the database and Redis so Render's platform probe (and the
  // container HEALTHCHECK in the Dockerfile) only get a 200 when both
  // dependencies are reachable. Each subsystem times out at 1s so a
  // wedged dep doesn't keep the probe hanging.
  app.get('/health/ready', async (_req, res) => {
    const checks: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
    let allOk = true;

    // DB check: `SELECT 1` via $queryRaw — no model dependency.
    const dbStart = Date.now();
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('db_timeout')), 1000)),
      ]);
      checks.db = { ok: true, latencyMs: Date.now() - dbStart };
    } catch (err) {
      allOk = false;
      checks.db = { ok: false, latencyMs: Date.now() - dbStart, error: (err as Error).message };
    }

    // Redis check: PING. ioredis throws on offline-queue-disabled when
    // the connection is down, so we still catch + tag.
    const redisStart = Date.now();
    try {
      await Promise.race([
        redis.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('redis_timeout')), 1000)),
      ]);
      checks.redis = { ok: true, latencyMs: Date.now() - redisStart };
    } catch (err) {
      allOk = false;
      checks.redis = {
        ok: false,
        latencyMs: Date.now() - redisStart,
        error: (err as Error).message,
      };
    }

    const status = allOk ? 200 : 503;
    res.status(status).json({
      success: allOk,
      message: allOk ? 'ready' : 'not_ready',
      data: {
        status: allOk ? 'ok' : 'degraded',
        uptimeSeconds: Math.round(process.uptime()),
        checks,
      },
    });
  });

  // /health/startup: startup probe — same as live for now.
  app.get('/health/startup', (_req, res) => {
    res.status(200).json({
      success: true,
      message: 'starting',
      data: { status: 'ok' },
    });
  });

  // ── API v1 root ──────────────────────────────────────────────────────
  // Phase 1 placeholder; feature routers mount here in later phases.
  app.get('/api/v1', (_req, res) => {
    res.status(200).json(ok({ version: '1.0.0', status: 'phase-4-scaffold' }));
  });

  // ── Phase 5: anonymous rate limiter (must be BEFORE the demo routes) ─
  // Mounted before the demo route handlers so it actually intercepts
  // their requests. express-rate-limit increments a counter on each
  // matched request and returns 429 once the per-1s burst (20) is hit.
  app.use('/api/v1/_demo', anonymousRateLimiter);

  // ── Phase 4 demo: envelope + zodValidate wiring ─────────────────────
  // GET /api/v1/_demo/ping — smoke test for the standard success envelope.
  app.get('/api/v1/_demo/ping', (_req, res) => {
    res.status(200).json(ok({ pong: true }));
  });

  // POST /api/v1/_demo/echo — exercises zodValidate on the body.
  // Valid request: { "message": "hello" } → 200 with { pong: true, echoed: "hello" }.
  // Invalid request: anything missing "message" or with empty string → 400 with errors[].
  const echoSchema = z.object({
    message: z.string().min(1, 'must not be empty'),
  });
  app.post('/api/v1/_demo/echo', zodValidate({ body: echoSchema }), (req, res) => {
    const { message } = req.body as z.infer<typeof echoSchema>;
    res.status(200).json(ok({ pong: true, echoed: message }));
  });

  // POST /api/v1/_demo/throw-validation — demonstrates ValidationError → envelope.
  app.post('/api/v1/_demo/throw-validation', (_req, _res, next) => {
    next(
      new ValidationError('Validation failed (demo)', [
        { field: 'demoField', code: 'INVALID', message: 'this is a demo field error' },
      ])
    );
  });

  // ── Phase 5: protected demo routes (auth-gated) ────────────────────
  // Per-role limiter on the protected prefix; requireAuth + requireRole
  // live inside the router. Order is: per-role limit → requireAuth →
  // requireRole → handler.
  app.use('/api/v1/_demo/protected', authenticatedRateLimiter, protectedDemoRouter());

  // ── Phase 6: auth router (signup/login/refresh/logout/…) ───────────
  // Public routes (signup, login, refresh, verify-email) get the
  // anonymous rate limiter treatment for the /auth prefix. The /logout
  // route itself requires requireAuth inside the router.
  app.use('/api/v1/auth', anonymousRateLimiter, authRouter());

  // ── Phase 8: users + profiles + preferences routers ────────────────
  // Anon limiter on /users (mostly self-service, hot path).
  // Per-role limiter on /profiles + /preferences (always require auth).
  app.use('/api/v1/users', anonymousRateLimiter, usersRouter());
  app.use('/api/v1/profiles', authenticatedRateLimiter, profilesRouter());
  app.use('/api/v1/preferences', authenticatedRateLimiter, preferencesRouter());

  // ── Phase 9: KYC submissions + admin review queue ────────────────
  // All KYC routes require auth (rate limit per role).
  app.use('/api/v1/kyc', authenticatedRateLimiter, kycRouter());

  // ── Phase 10: properties + buildings + flats + rooms ──────────────
  // All routes require auth; per-role limiter (publish + admin paths
  // live behind `requireRole` in each router).
  app.use('/api/v1/properties', authenticatedRateLimiter, propertiesRouter());
  app.use('/api/v1/buildings', authenticatedRateLimiter, buildingsRouter());
  app.use('/api/v1/flats', authenticatedRateLimiter, flatsRouter());
  app.use('/api/v1/rooms', authenticatedRateLimiter, roomsRouter());

  // ── Phase 11: room search (PG fallback) + saved searches ─────────
  // Public read surface (anonymous-OK) goes under the anon limiter.
  // Saved-search endpoints go under the auth limiter; requireAuth lives
  // inside the saved router. Order: anon limiter first (cheapest to
  // reject), then auth limiter so saved-search is always per-user.
  app.use('/api/v1/search', anonymousRateLimiter, searchPublicRouter());
  app.use('/api/v1/search', authenticatedRateLimiter, searchSavedRouter());

  // ── Phase 12: applications + viewings + transitions ───────────────
  // Both routers require auth (requireAuth lives inside). Per-role
  // rate limiter applies uniformly. Order matters only for readability.
  app.use('/api/v1/applications', authenticatedRateLimiter, applicationsRouter());
  app.use('/api/v1/viewings', authenticatedRateLimiter, viewingsRouter());

  // ── Phase 13: leases + counterparty signing + document + amendments ─
  // Multi-party resource: all transition routes layer requireLeaseParty
  // on top of role gates. /me uses requireAuth only.
  app.use('/api/v1/leases', authenticatedRateLimiter, leasesRouter());

  // ── Phase 17: maintenance tickets ─────────────────────────────────
  // /rooms/:roomId/tickets (TENANT raises; party reads) lives on the
  // existing /api/v1/rooms prefix via ticketsRoomRouter.
  // /tickets/me, /queue, /:id, /:id/updates, /:id/rate live on a
  // fresh /api/v1/tickets prefix.
  app.use('/api/v1/rooms', authenticatedRateLimiter, ticketsRoomRouter());
  app.use('/api/v1/tickets', authenticatedRateLimiter, ticketsRouter());

  // ── Phase 14: rent invoice generation + bills facade ────────────────
  // /invoices is auth-gated for every route (party-or-admin on :id);
  // /bills/generate is OWNER-only. Both use per-role rate limiting.
  app.use('/api/v1/invoices', authenticatedRateLimiter, invoicesRouter());
  app.use('/api/v1/bills', authenticatedRateLimiter, billsRouter());

  // ── Phase 16: utility meters + readings ─────────────────────────────
  // /properties/:propertyId/meters (OWNER | ADMIN)
  // /meters/:meterId/readings        (OWNER | TENANT | ADMIN)
  // The metersRouter is mounted under /properties so the path
  // /:propertyId/meters resolves correctly with mergeParams.
  // The readingsRouter is mounted under /meters for the same reason.
  app.use('/api/v1/properties', authenticatedRateLimiter, metersRouter());
  app.use('/api/v1/meters', authenticatedRateLimiter, readingsRouter());

  // ── Phase 15: Stripe payments + webhook ──────────────────────────────
  // CRITICAL: webhook MUST mount BEFORE the authenticated rate limiter
  // and signature-gated only (no Bearer). Mounted directly on the app
  // so it bypasses the per-role limiter — Stripe's retries would
  // otherwise blow through the per-user limit.
  //
  // The body is already captured by the global express.json({ verify })
  // hook in `req.rawBody` (utf-8 string). The handler reads that
  // directly; no per-route express.raw() needed.
  app.post('/api/v1/payments/stripe/webhook', stripeWebhookHandler);

  // The normal auth-gated payments router (intent / me / :id / refund).
  app.use('/api/v1/payments', authenticatedRateLimiter, paymentsRouter());

  // ── Phase 18: notifications feed + channel preferences ───────────────
  // All routes require auth; per-role limiter applies uniformly. Feed is
  // caller-scoped (own notifications only) and preferences are
  // caller-scoped.
  app.use('/api/v1/notifications', authenticatedRateLimiter, notificationsRouter());

  // ── Phase 18: documents (stubbed presigned URLs + soft-delete) ──────
  // All routes require auth. /upload-url and /:id (DELETE) are state-
  // changing so they pass through withIdempotency inside the router.
  app.use('/api/v1/documents', authenticatedRateLimiter, documentsRouter());

  // ── Phase 19: admin moderation + audit logs + feature flags ────────
  // Two routers under the /admin prefix:
  //   adminRouter          — /users/search, /listings/:id/{takedown,reinstate},
  //                          /health, /audit-logs/*
  //   featureFlagsRouter   — /feature-flags/* (mounted under /admin)
  // Both require ADMIN role; non-admin → 403 (must_pass).
  app.use('/api/v1/admin', authenticatedRateLimiter, adminRouter());
  app.use('/api/v1/admin/feature-flags', authenticatedRateLimiter, featureFlagsRouter());

  // ── Phase 20: roommate matching (lite) ─────────────────────────────
  // /match/* — TENANT-only (every endpoint is caller-scoped). Match
  // runs + intro lifecycle calls are state-changing → withIdempotency.
  app.use('/api/v1/match', authenticatedRateLimiter, matchRouter());

  // ── Error handling (must be last) ───────────────────────────────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

// Boot only when run directly (not when imported by tests).
if (require.main === module) {
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server_listening');
  });

  function shutdown(signal: string): void {
    logger.info({ signal }, 'shutdown_initiated');
    server.close((err) => {
      if (err) {
        logger.error({ err }, 'shutdown_error');
        process.exit(1);
      }
      process.exit(0);
    });
    // Hard timeout fallback.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled_rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught_exception');
    process.exit(1);
  });
}
