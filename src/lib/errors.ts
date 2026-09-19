// src/lib/errors.ts
//
// Typed API errors per spec §13.1 (codes) and §11.3.3 (PII-safe messages).
//
// Why a class hierarchy:
//   - The error-handler middleware checks `instanceof` to pick the right
//     HTTP status and envelope.
//   - Service code throws the narrowest subclass that fits.
//   - Field-level details (validation errors) ride on the `fields` array,
//     not in the message string, so the client gets structured data and
//     the public-facing `message` stays generic.
//
// Sub-codes (per §13.1):
//   400 VALIDATION         — generic body / query / params failure
//   401 UNAUTHENTICATED    — missing or invalid token
//   403 FORBIDDEN           — auth ok, role/ownership denied
//   403 KYC_REQUIRED        — auth ok, role-profile not yet KYC-approved
//   403 NOT_OWNER           — resource-level ownership check failed
//   404 NOT_FOUND           — entity / route not present
//   409 CONFLICT            — unique constraint, state-machine collision
//   422 SEMANTIC            — semantically invalid (e.g., date in past)
//   429 RATE_LIMITED        — global or per-route limit hit
//   5xx SERVER              — anything not modeled above

export interface ApiFieldError {
  field: string;
  code: string;
  message: string;
}

/**
 * Base class for every error that maps to a known HTTP status + code.
 * Service code rarely throws this directly — pick a subclass.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly fields?: ApiFieldError[];
  public readonly cause?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { fields?: ApiFieldError[]; cause?: unknown } = {}
  ) {
    // Pass message-only to the parent (don't leak internals via .stack
    // signature). We still expose cause explicitly.
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.fields = options.fields;
    this.cause = options.cause;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 400 — Validation
// ──────────────────────────────────────────────────────────────────────

export class ValidationError extends ApiError {
  constructor(message = 'Validation failed', fields: ApiFieldError[] = []) {
    super(400, 'VALIDATION', message, { fields });
  }
}

// ──────────────────────────────────────────────────────────────────────
// 401 — Authentication required
// ──────────────────────────────────────────────────────────────────────

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHENTICATED', message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// 403 — Forbidden (role / ownership / KYC)
// ──────────────────────────────────────────────────────────────────────

export class ForbiddenError extends ApiError {
  constructor(code: 'FORBIDDEN' | 'KYC_REQUIRED' | 'NOT_OWNER', message: string) {
    super(403, code, message);
  }
}

/** Convenience: KYC not yet approved for the role being attempted. */
export class KycRequiredError extends ForbiddenError {
  constructor(role: 'OWNER' | 'TENANT') {
    super('KYC_REQUIRED', `${role} role requires KYC approval before this action`);
  }
}

/** Convenience: caller is authenticated but does not own the resource. */
export class NotOwnerError extends ForbiddenError {
  constructor(resource = 'resource') {
    super('NOT_OWNER', `Caller does not own this ${resource}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// 404 — Not found
// ──────────────────────────────────────────────────────────────────────

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

// ──────────────────────────────────────────────────────────────────────
// 409 — Conflict (uniqueness, state machine)
// ──────────────────────────────────────────────────────────────────────

export class ConflictError extends ApiError {
  constructor(code: 'CONFLICT' | 'STATE_MACHINE', message: string, fields: ApiFieldError[] = []) {
    super(409, code, message, { fields });
  }
}

// ──────────────────────────────────────────────────────────────────────
// 422 — Semantic (well-formed but makes no sense)
// ──────────────────────────────────────────────────────────────────────

export class SemanticError extends ApiError {
  constructor(message: string, fields: ApiFieldError[] = []) {
    super(422, 'SEMANTIC', message, { fields });
  }
}

// ──────────────────────────────────────────────────────────────────────
// 429 — Rate limited
// ──────────────────────────────────────────────────────────────────────

export class RateLimitedError extends ApiError {
  constructor(message = 'Too many requests', retryAfterSec?: number) {
    super(429, 'RATE_LIMITED', message, {
      fields:
        typeof retryAfterSec === 'number'
          ? [
              {
                field: 'retry-after',
                code: 'RATE_LIMITED',
                message: `Retry after ${retryAfterSec}s`,
              },
            ]
          : undefined,
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// 5xx — Server
// ──────────────────────────────────────────────────────────────────────

export class ServerError extends ApiError {
  constructor(message = 'Internal server error', cause?: unknown) {
    super(500, 'SERVER', message, { cause });
  }
}

/** Feature-disabled sentinel. Thrown when a configured integration
 *  (e.g. Stripe) is not provisioned on this environment. Surfaces as
 *  503 to the client with a clear, non-leaky message.
 *
 *  Distinct from the generic ServerError (500) so callers can branch on
 *  `error.code === 'STRIPE_DISABLED'` to show a useful inline UI hint.
 */
export class StripeDisabledError extends ApiError {
  constructor(message = 'Stripe is not configured on this environment') {
    super(503, 'STRIPE_DISABLED', message);
    this.name = 'StripeDisabledError';
  }
}

/** Same contract as StripeDisabledError, for Cloudinary object storage.
 *  Thrown by upload/download/delete routes when CLOUDINARY_* is unset so
 *  a credential-free dev environment degrades to a clear 503 instead of
 *  a 500 from deep inside the SDK.
 */
export class StorageDisabledError extends ApiError {
  constructor(message = 'File storage is not configured on this environment') {
    super(503, 'STORAGE_DISABLED', message);
    this.name = 'StorageDisabledError';
  }
}
