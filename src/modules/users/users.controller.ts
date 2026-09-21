// src/modules/users/users.controller.ts
//
// Thin HTTP wrappers. Each handler:
//   1. Reads req.user / req.params / req.body (already validated by
//      zodValidate + requireAuth / requireRole in the router).
//   2. Calls users.service.<x>.
//   3. Returns the standard envelope via ok().
//   4. Domain errors propagate via `throw` to the global error-handler.

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';
import type { UpdateMeInput, UserIdParams } from './users.schemas';
import * as svc from './users.service';

export const getMe: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const data = await svc.getMe(userId);
  res.status(200).json(ok(data, 'User profile retrieved'));
};

export const updateMe: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as UpdateMeInput;
  const data = await svc.updateMe(userId, body);
  res.status(200).json(ok(data, 'User profile updated'));
};

export const getUserById: RequestHandler = async (req, res) => {
  const { id } = req.params as unknown as UserIdParams;
  const data = await svc.getUserById(id);
  res.status(200).json(ok(data, 'User retrieved'));
};

export const deactivateUser: RequestHandler = async (req, res) => {
  const actorUserId = req.user!.id;
  const { id } = req.params as unknown as UserIdParams;
  const data = await svc.deactivateUser(actorUserId, id);
  res.status(200).json(ok(data, 'User deactivated'));
};
