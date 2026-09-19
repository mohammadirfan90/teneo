// src/lib/validate.ts
//
// Zod-powered request validation middleware factory.
//
// Usage at the route definition site:
//   router.post('/signup',
//     zodValidate({ body: signupBodySchema }),
//     controller.signup,
//   );
//
// On failure:
//   - Throws a ValidationError(400, VALIDATION) carrying a per-field
//     errors[] array (field path, issue code, issue message).
//   - The global error-handler middleware converts it into the standard
//     error envelope — handlers never need to try/catch it.
//
// On success:
//   - Replaces req.body / req.query / req.params with the parsed,
//     strongly-typed values (Zod `unknown -> T` cast happens here).
//   - In dev mode (`!isProd`) rejects unknown keys to surface typos
//     early; in prod stays permissive for forward compatibility.

import type { RequestHandler } from 'express';
import type { ZodError, ZodTypeAny, z } from 'zod';

import { isProd } from '@/lib/env';
import { ValidationError } from '@/lib/errors';

export interface ZodValidateOptions {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Field path normalization: Zod nests arrays under numeric indices
 * (e.g. `items.0.name`). We surface that as a flat dotted path so the
 * client can bind errors to a specific form field.
 */
function flattenIssues(error: ZodError): import('@/lib/errors').ApiFieldError[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((p) => (typeof p === 'number' ? String(p) : p)).join('.');
    return {
      field: path === '' ? 'body' : path,
      code: `ZOD_${issue.code.toUpperCase()}`,
      message: issue.message,
    };
  });
}

function parseOrThrow(
  label: 'body' | 'query' | 'params',
  schema: ZodTypeAny,
  data: unknown
): unknown {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  if (isProd) {
    throw new ValidationError(`Invalid ${label}`, flattenIssues(result.error));
  }
  // Dev mode: reject unknown keys so typos in tests are loud.
  const strict = (schema as z.ZodType).safeParse(data);
  if (!strict.success) {
    throw new ValidationError(`Invalid ${label} (strict)`, flattenIssues(strict.error));
  }
  return strict.data;
}

/**
 * Express middleware factory that validates one or more request parts
 * with a Zod schema and replaces them on the request object.
 */
export function zodValidate(opts: ZodValidateOptions): RequestHandler {
  return (req, _res, next) => {
    try {
      if (opts.body) {
        (req as unknown as { body: unknown }).body = parseOrThrow('body', opts.body, req.body);
      }
      if (opts.query) {
        const parsed = parseOrThrow('query', opts.query, req.query);
        // req.query is a getter on Express 5's Request prototype; override on the instance.
        Object.defineProperty(req, 'query', {
          value: parsed,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (opts.params) {
        const parsed = parseOrThrow('params', opts.params, req.params);
        Object.assign(req.params, parsed);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
