// src/modules/match/match.routes.ts
//
// Phase 20: routes for /api/v1/match/* (13 §13.2.4, 05 §5.1).
//
//   POST  /run                         requireAuth → requireRole(TENANT)
//   GET   /results                     requireAuth → requireRole(TENANT)
//   POST  /results/:match_id/intro     requireAuth → requireRole(TENANT)
//   POST  /intro-requests/:id/accept   requireAuth → requireRole(TENANT)
//   POST  /intro-requests/:id/decline  requireAuth → requireRole(TENANT)

import { Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';

import {
  acceptIntroHandler,
  declineIntroHandler,
  listMyResultsHandler,
  openIntroHandler,
  runMatchHandler,
} from './match.controller';
import { introIdParamsSchema, matchIdParamsSchema } from './match.schemas';

export function matchRouter(): Router {
  const r = Router();

  // POST /run
  r.post(
    '/run',
    requireAuth,
    requireRole('TENANT'),
    withIdempotency,
    asyncHandler(runMatchHandler)
  );

  // GET /results
  r.get('/results', requireAuth, requireRole('TENANT'), asyncHandler(listMyResultsHandler));

  // POST /results/:match_id/intro
  r.post(
    '/results/:match_id/intro',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ params: matchIdParamsSchema }),
    withIdempotency,
    asyncHandler(openIntroHandler)
  );

  // POST /intro-requests/:id/accept
  r.post(
    '/intro-requests/:id/accept',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ params: introIdParamsSchema }),
    withIdempotency,
    asyncHandler(acceptIntroHandler)
  );

  // POST /intro-requests/:id/decline
  r.post(
    '/intro-requests/:id/decline',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ params: introIdParamsSchema }),
    withIdempotency,
    asyncHandler(declineIntroHandler)
  );

  return r;
}
