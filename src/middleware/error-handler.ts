// src/middleware/error-handler.ts
// Catches thrown errors, normalizes to the standard envelope per spec §13.1.
// Phase 1: minimal handler with redaction-safe logging.
// Phase 4 will replace the inline error types with src/lib/errors.ts (ApiError hierarchy).

import type { ErrorRequestHandler } from 'express';

import { isProd } from '@/lib/env';
import { logger } from '@/lib/logger';

export interface ApiFieldError {
  field: string;
  code: string;
  message: string;
}

/** Minimal typed error interface used by phase 1. Phase 4 supersedes with src/lib/errors.ts. */
export interface ApiErrorLike extends Error {
  status: number;
  code: string;
  fields?: ApiFieldError[];
}

function isApiError(err: unknown): err is ApiErrorLike {
  return (
    err instanceof Error &&
    typeof (err as ApiErrorLike).status === 'number' &&
    typeof (err as ApiErrorLike).code === 'string'
  );
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const correlationId = res.getHeader('X-Correlation-Id') as string | undefined;

  if (isApiError(err)) {
    const fields = err.fields && err.fields.length > 0
      ? err.fields
      : [{ field: 'unknown', code: err.code, message: err.message }];

    if (err.status >= 500) {
      logger.error({ err, correlationId, code: err.code }, 'api_error_5xx');
    } else {
      logger.warn({ correlationId, code: err.code, message: err.message }, 'api_error');
    }
    res.status(err.status).json({ success: false, message: err.message, errors: fields });
    return;
  }

  // Unknown — log full, return generic.
  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error({ err, correlationId }, 'unhandled_error');
  res.status(500).json({
    success: false,
    message: isProd ? 'Internal server error' : message,
    errors: [{ field: 'unknown', code: 'INTERNAL', message: isProd ? 'see server logs' : message }],
  });
};
