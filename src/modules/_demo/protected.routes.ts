// src/modules/_demo/protected.routes.ts
//
// Demo surface for Phase 5. Three routes that exercise the new middleware
// in isolation:
//   GET  /_demo/protected          — requireAuth only
//   GET  /_demo/protected/owner-only — requireAuth + requireRole('OWNER')
//   POST /_demo/protected/echo-idem — requireAuth + idempotency (07 §7.3)
//
// Used to verify:
//   - 401 with no Bearer
//   - 200 with valid Bearer
//   - 403 FORBIDDEN when caller is TENANT but route requires OWNER
//   - 422 when Idempotency-Key reused with different body
//   - replayed response when Idempotency-Key reused with same body
//
// Replaced by real /auth + /users routes in Phases 6 and 8.

import { Router } from 'express';

import { ok } from '@/lib/envelope';
import { type AuthenticatedUser, requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';

export function protectedDemoRouter(): Router {
  const r = Router();

  // /_demo/protected — any authenticated user.
  r.get('/', requireAuth, (req, res) => {
    res.status(200).json(ok({ user: req.user as AuthenticatedUser }));
  });

  // /_demo/protected/owner-only — OWNER only. TENANT → 403 FORBIDDEN.
  r.get('/owner-only', requireAuth, requireRole('OWNER'), (req, res) => {
    res.status(200).json(ok({ message: 'owner area' }));
  });

  // /_demo/protected/echo-idem — state-changing echo with idempotency.
  // Header `Idempotency-Key: <uuid>` required. Same key + same body
  // replays the original response; same key + different body → 422.
  r.post(
    '/echo-idem',
    requireAuth,
    withIdempotency,
    (req, res) => {
      const body = req.body as { message?: string } | undefined;
      res.status(201).json(ok({ pong: true, echoed: body?.message ?? null }));
    }
  );

  return r;
}
