// src/modules/kyc/kyc.routes.ts
//
// Routes for /kyc/* — mounted under /api/v1/kyc in server.ts.
//
// Authorization layers per spec §6.10 + §9.3:
//   - POST /submissions               requireAuth (any role can submit KYC for the role they want)
//   - GET  /submissions/me            requireAuth
//   - GET  /submissions/:id           requireAuth + ownership-or-admin (in service)
//   - GET  /queue                     requireAuth + requireRole('ADMIN')
//   - POST /submissions/:id/decision  requireAuth + requireRole('ADMIN')
//   - POST /submissions/:id/request-info  requireAuth + requireRole('ADMIN')

import { Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import {
  createSubmission,
  decideSubmission,
  getSubmissionById,
  listMySubmissions,
  listQueue,
  requestInfo,
} from './kyc.controller';
import {
  createSubmissionSchema,
  decisionSchema,
  queueQuerySchema,
  requestInfoSchema,
  submissionIdParamsSchema,
} from './kyc.schemas';

export function kycRouter(): Router {
  const r = Router();

  // ── user-side ─────────────────────────────────────────────────────
  r.post(
    '/submissions',
    requireAuth,
    zodValidate({ body: createSubmissionSchema }),
    asyncHandler(createSubmission)
  );

  r.get('/submissions/me', requireAuth, asyncHandler(listMySubmissions));

  r.get(
    '/submissions/:id',
    requireAuth,
    zodValidate({ params: submissionIdParamsSchema }),
    asyncHandler(getSubmissionById)
  );

  // ── admin-side ────────────────────────────────────────────────────
  r.get(
    '/queue',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({ query: queueQuerySchema }),
    asyncHandler(listQueue)
  );

  r.post(
    '/submissions/:id/decision',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({
      params: submissionIdParamsSchema,
      body: decisionSchema,
    }),
    asyncHandler(decideSubmission)
  );

  r.post(
    '/submissions/:id/request-info',
    requireAuth,
    requireRole('ADMIN'),
    zodValidate({
      params: submissionIdParamsSchema,
      body: requestInfoSchema,
    }),
    asyncHandler(requestInfo)
  );

  return r;
}
