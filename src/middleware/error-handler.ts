// src/middleware/error-handler.ts
//
// Catches thrown errors, normalizes to the standard envelope per spec §13.1.
//
// Maps, in order:
//   1. ApiError (our hierarchy in src/lib/errors.ts) → use its status/code/fields
//   2. ZodError                                    → 400 VALIDATION + per-field issues
//   3. Prisma known errors:
//        P2002 unique constraint    → 409 CONFLICT
//        P2025 record not found     → 404 NOT_FOUND
//   4. Anything else                                → 500 SERVER (generic message in prod)
//
// Logging:
//   - 5xx errors log full err object.
//   - 4xx errors log at warn with code + message only.
//   - The Pino redactor already scrubs PII from logged objects.
//
// Prod safety:
//   - In NODE_ENV=production we never return the raw message or stack;
//     we return a fixed public message and the correlation id only.
//   - Clients can use the X-Correlation-Id response header to look up
//     the full error in server logs.

import { Prisma } from '@/generated/prisma/client';
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { isProd } from '@/lib/env';
import { fail, failWithCode } from '@/lib/envelope';
import { ApiError, ConflictError, NotFoundError, ServerError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError;
}

function isPrismaKnown(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError;
}

/**
 * body-parser (express.json / express.urlencoded) throws errors that
 * look like `Error` with `.status`, `.statusCode`, and/or `.type` props.
 * Surface them as 400 VALIDATION rather than a generic 500.
 */
function isBodyParserError(
  err: unknown
): err is Error & { status?: number; statusCode?: number; type?: string } {
  if (!(err instanceof Error)) return false;
  const anyErr = err as Error & { status?: number; statusCode?: number; type?: string };
  const status = anyErr.status ?? anyErr.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) return true;
  // body-parser SyntaxErrors carry .type === 'entity.parse.failed'
  if (typeof anyErr.type === 'string' && anyErr.type.startsWith('entity.')) return true;
  return false;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const correlationId = res.getHeader('X-Correlation-Id') as string | undefined;

  // 1) Our typed API errors.
  if (isApiError(err)) {
    const envelope = failWithCode(err.message, err.code, err.fields ?? []);
    if (err.status >= 500) {
      logger.error({ err, correlationId, code: err.code, status: err.status }, 'api_error_5xx');
    } else {
      logger.warn(
        { correlationId, code: err.code, status: err.status, message: err.message },
        'api_error'
      );
    }
    res.status(err.status).json(envelope);
    return;
  }

  // 2) Raw ZodError — should be wrapped in ValidationError normally, but
  //    handle defensively in case a route forgot to use zodValidate().
  if (isZodError(err)) {
    const fields = err.issues.map((issue) => {
      const path = issue.path.map((p) => (typeof p === 'number' ? String(p) : p)).join('.');
      return {
        field: path === '' ? 'body' : path,
        code: `ZOD_${issue.code.toUpperCase()}`,
        message: issue.message,
      };
    });
    logger.warn({ correlationId, fields }, 'zod_error_unwrapped');
    res.status(400).json(fail('Validation failed', fields));
    return;
  }

  // 2b) body-parser errors (malformed JSON, payload too large) → 400 VALIDATION.
  if (isBodyParserError(err)) {
    const validation = new ValidationError('Malformed request body', [
      { field: 'body', code: 'BODY_PARSE', message: err.message },
    ]);
    logger.warn({ correlationId, message: err.message }, 'body_parse_error');
    res.status(validation.status).json(fail(validation.message, validation.fields!));
    return;
  }

  // 3) Prisma known errors → our typed equivalents.
  if (isPrismaKnown(err)) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | string | undefined) ?? [];
      const field = Array.isArray(target) ? target.join('.') : String(target);
      const conflict = new ConflictError('CONFLICT', 'Resource already exists', [
        { field, code: 'P2002', message: `Duplicate value for ${field}` },
      ]);
      logger.warn(
        { correlationId, code: conflict.code, field, message: conflict.message },
        'prisma_conflict'
      );
      res.status(conflict.status).json(fail(conflict.message, conflict.fields!));
      return;
    }
    if (err.code === 'P2025') {
      const notFound = new NotFoundError('Resource not found');
      logger.warn(
        { correlationId, code: notFound.code, message: notFound.message },
        'prisma_not_found'
      );
      res.status(notFound.status).json(fail(notFound.message, notFound.fields ?? []));
      return;
    }
    // Other Prisma codes → treat as server error.
    const serverErr = new ServerError('Database error', err);
    logger.error({ err, correlationId, prismaCode: err.code }, 'prisma_error_5xx');
    res
      .status(serverErr.status)
      .json(
        isProd
          ? fail('Internal server error', [
              { field: 'unknown', code: 'SERVER', message: 'see server logs' },
            ])
          : fail(serverErr.message, [
              { field: 'unknown', code: err.code, message: serverErr.message },
            ])
      );
    return;
  }

  // 4) Unknown → generic 500.
  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error({ err, correlationId }, 'unhandled_error');
  if (isProd) {
    res
      .status(500)
      .json(
        fail('Internal server error', [
          { field: 'unknown', code: 'SERVER', message: 'see server logs' },
        ])
      );
    return;
  }
  res.status(500).json(fail(message, [{ field: 'unknown', code: 'INTERNAL', message }]));
};
