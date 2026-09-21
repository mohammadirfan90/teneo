// src/middleware/ownership.ts
//
// `requireOwnership(getOwnerId)` — ABAC layer per 02 §2.4.
//
// Semantics:
//   - ADMIN → bypass (admin staff can read/write anything).
//   - Otherwise: load the resource's owner id via `getOwnerId(req)` and
//     compare to `req.user.id`. Mismatch → 403 NOT_OWNER.
//   - If `getOwnerId(req)` returns `null` (resource doesn't exist),
//     surface 404 NOT_FOUND rather than 403 — we don't want to leak
//     resource existence to a non-owner who guessed an ID.
//
// `getOwnerId` may be sync or async so the implementation can hit PG,
// Redis, or a static lookup. Errors are propagated.
//
// Use as:
//   router.patch('/properties/:id',
//     requireAuth,
//     requireRole('OWNER'),
//     requireOwnership(async (req) => {
//       const p = await prisma.property.findUnique({
//         where: { id: req.params.id }, select: { ownerUserId: true },
//       });
//       return p?.ownerUserId ?? null;
//     }),
//     handler,
//   );

import type { Request, RequestHandler } from 'express';

import { NotFoundError, NotOwnerError, UnauthorizedError } from '@/lib/errors';

export type OwnerIdResolver = (req: Request) => Promise<string | null> | string | null;

export function requireOwnership(getOwnerId: OwnerIdResolver): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (!req.user) {
        throw new UnauthorizedError('Authentication required');
      }

      // ADMIN bypass — only place ADMIN gets an implicit pass.
      if (req.user.roles.includes('ADMIN')) {
        next();
        return;
      }

      const ownerId = await getOwnerId(req);
      if (ownerId === null) {
        throw new NotFoundError('Resource not found');
      }
      if (ownerId !== req.user.id) {
        // 403 NOT_OWNER with a generic message — don't leak the
        // resource's actual owner id back to the caller.
        throw new NotOwnerError('resource');
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
