// src/modules/auth/auth.controller.ts
//
// Thin HTTP wrapper. Each method:
//   1. Reads req.body (already validated by zodValidate middleware).
//   2. Reads request meta (IP, user-agent) for audit/throttle context.
//   3. Calls auth.service.<x>.
//   4. Returns the standard envelope via ok().
//   5. Domain errors propagate via `throw` to the global error-handler.

import type { Request, RequestHandler } from 'express';

import { ok } from '@/lib/envelope';
import type {
  GoogleOAuthCallbackInput,
  LoginInput,
  RefreshInput,
  SignupInput,
} from './auth.schemas';
import * as svc from './auth.service';

function readMeta(req: Request): { userAgent?: string; ip?: string } {
  return {
    userAgent: req.get('user-agent') ?? undefined,
    // Express sets `req.ip` from the configured `trust proxy` setting.
    ip: req.ip,
  };
}

function readBearer(req: Request): string | undefined {
  const header = req.get('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token;
}

export const signup: RequestHandler = async (req, res) => {
  const body = req.body as SignupInput;
  const data = await svc.signupUser(body, readMeta(req));
  res.status(201).json(ok(data, 'Account created'));
};

export const login: RequestHandler = async (req, res) => {
  const body = req.body as LoginInput;
  const data = await svc.loginUser(body, readMeta(req));
  res.status(200).json(ok(data, 'Signed in'));
};

export const refresh: RequestHandler = async (req, res) => {
  const body = req.body as RefreshInput;
  const data = await svc.refreshSession(body, readMeta(req));
  res.status(200).json(ok(data, 'Session refreshed'));
};

export const logout: RequestHandler = async (req, res) => {
  // requireAuth middleware guarantees req.user is set.
  const userId = req.user!.id;
  const accessRaw = readBearer(req);
  await svc.logoutCurrentSession(userId, accessRaw);
  res.status(200).json(ok(null, 'Signed out'));
};

export const logoutAll: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const revoked = await svc.logoutAll(userId);
  res.status(200).json(ok({ revoked }, 'Signed out from all sessions'));
};

export const googleOAuthCallback: RequestHandler = async (req, res) => {
  const body = req.body as GoogleOAuthCallbackInput;
  const data = await svc.loginOrLinkGoogle(body, readMeta(req));
  res.status(200).json(ok(data, 'Signed in with Google'));
};
