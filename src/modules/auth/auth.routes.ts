// src/modules/auth/auth.routes.ts
//
// Route definitions for the auth module. Mounted under `/api/v1/auth` in
// src/server.ts.
//
// Mount order in each chain: zodValidate (body) → optional requireAuth
// → asyncHandler → controller. The asyncHandler forwards thrown
// errors to `next(err)` so the global error-handler formats them.

import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import {
  confirmPasswordReset,
  login,
  logout,
  logoutAll,
  refresh,
  requestPasswordReset,
  resendVerification,
  signup,
  verifyEmail,
} from './auth.controller';
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  refreshSchema,
  signupSchema,
  verifyEmailResendSchema,
} from './auth.schemas';

/**
 * Wrap an async Express handler so thrown errors flow through the
 * global error-handler middleware. Stays inline — no utility file
 * (scope discipline).
 */
const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export function authRouter(): Router {
  const r = Router();

  r.post('/signup', zodValidate({ body: signupSchema }), asyncHandler(signup));

  r.post('/login', zodValidate({ body: loginSchema }), asyncHandler(login));

  r.post('/refresh', zodValidate({ body: refreshSchema }), asyncHandler(refresh));

  r.post('/logout', requireAuth, asyncHandler(logout));

  r.post('/logout/all', requireAuth, asyncHandler(logoutAll));

  r.post(
    '/password/reset/request',
    zodValidate({ body: passwordResetRequestSchema }),
    asyncHandler(requestPasswordReset)
  );

  r.post(
    '/password/reset/confirm',
    zodValidate({ body: passwordResetConfirmSchema }),
    asyncHandler(confirmPasswordReset)
  );

  r.post(
    '/verify-email/resend',
    zodValidate({ body: verifyEmailResendSchema }),
    asyncHandler(resendVerification)
  );

  r.get('/verify-email', asyncHandler(verifyEmail));

  return r;
}
