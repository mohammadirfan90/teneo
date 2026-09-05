// src/server.ts
// Express bootstrap. Phase 1: health endpoints + global middleware (helmet,
// cors, correlation, json body parsing, error handler, 404).
// Future phases mount feature routers under /api/v1/...

import cors from 'cors';
import express, { type RequestHandler } from 'express';
import helmet from 'helmet';

import { corsOrigins, env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { correlationIdMiddleware } from '@/middleware/correlation-id';
import { errorHandler } from '@/middleware/error-handler';
import { notFoundHandler } from '@/middleware/not-found';

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
    }),
  );

  // Body parsing with a tight limit to deflect payload-overflow DoS.
  app.use(express.json({ limit: '1mb' }));
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
        'request',
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

  // /health/ready: readiness — full subsystem check. Wired up in phase 22.
  app.get('/health/ready', (_req, res) => {
    res.status(200).json({
      success: true,
      message: 'ready',
      data: { status: 'ok', checks: {} },
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
    res.status(200).json({
      success: true,
      message: 'Housing Platform API v1',
      data: { version: '1.0.0', status: 'phase-1-scaffold' },
    });
  });

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
