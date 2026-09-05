// src/lib/envelope.ts
//
// Standard response envelope builders per spec §13.1.
//
// Success envelope:
//   { success: true,  message: <string>, data: <T> }
//
// Error envelope:
//   { success: false, message: <string>, errors: ApiFieldError[] }
//
// Why builders and not raw JSON:
//   - One place to add tracing fields (correlation id) later.
//   - Forces every route to declare a message; no silent empty 200s.
//   - Handlers should never call res.json() directly for normal flows.

import type { ApiFieldError } from '@/lib/errors';

/** Shape of every successful response. */
export interface OkEnvelope<T> {
  success: true;
  message: string;
  data: T;
}

/** Shape of every error response. */
export interface FailEnvelope {
  success: false;
  message: string;
  errors: ApiFieldError[];
}

/**
 * Build a success envelope.
 *
 * @param data   payload to expose under `data`
 * @param message short, human-readable summary; safe for end users
 */
export function ok<T>(data: T, message = 'Operation successful'): OkEnvelope<T> {
  return { success: true, message, data };
}

/**
 * Build an error envelope.
 *
 * @param message short, human-readable summary; safe for end users.
 *                Must NOT contain PII (per §11.3.3) — keep it generic.
 * @param errors  structured field-level details (at least one entry).
 */
export function fail(message: string, errors: ApiFieldError[]): FailEnvelope {
  // Guarantee at least one error entry; clients can rely on the array
  // always being non-empty so they don't have to guard against it.
  const safeErrors =
    errors && errors.length > 0 ? errors : [{ field: 'unknown', code: 'INTERNAL', message }];
  return { success: false, message, errors: safeErrors };
}

/**
 * Like `fail()` but lets the caller pick the synthetic error code that
 * the error-handler uses when an ApiError has no `fields[]` entries.
 * Useful for tail classes like `NotFoundError` whose envelope should
 * carry `code: 'NOT_FOUND'` even when no field-level detail was set.
 */
export function failWithCode(
  message: string,
  code: string,
  errors: ApiFieldError[] = []
): FailEnvelope {
  const safeErrors = errors && errors.length > 0 ? errors : [{ field: 'unknown', code, message }];
  return { success: false, message, errors: safeErrors };
}
