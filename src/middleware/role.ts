// src/middleware/role.ts
//
// `requireRole(...allowed)` — strict 3-role RBAC gate per 06 §6.9.
//
// Strict means:
//   - ADMIN does NOT implicitly pass a requireRole('OWNER') gate. Per
//     §2.4, ADMIN's special power is ownership bypass (handled by
//     `requireOwnership`), not role bypass. A route that requires OWNER
//     stays OWNER-only; an ADMIN who is also an OWNER passes naturally
//     because `user_roles` carries both rows.
//   - If `req.user` is missing, the route was mounted incorrectly — we
//     fail closed with 401 rather than silently allowing through.
//
// Use as:
//   router.post('/properties',
//     requireAuth,
//     requireRole('OWNER'),
//     handler,
//   );

import type { RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '@/lib/errors';
import type { AppRole } from '@/middleware/auth';

export function requireRole(...allowed: AppRole[]): RequestHandler {
  if (allowed.length === 0) {
    throw new Error('requireRole(...) needs at least one role argument');
  }

  return (req, _res, next) => {
    if (!req.user) {
      // Defensive: must be mounted AFTER requireAuth.
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const has = req.user.roles.some((r) => allowed.includes(r));
    if (!has) {
      next(
        new ForbiddenError(
          'FORBIDDEN',
          `Role not permitted for this resource (need one of: ${allowed.join(', ')})`
        )
      );
      return;
    }

    next();
  };
}
