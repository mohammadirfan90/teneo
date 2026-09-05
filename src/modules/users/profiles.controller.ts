// src/modules/users/profiles.controller.ts

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';
import * as svc from './profiles.service';
import type { ProfilePatchInput } from './users.schemas';

export const getOwnerProfile: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const data = await svc.getOwnerProfile(userId);
  res.status(200).json(ok(data, 'Owner profile retrieved'));
};

export const patchOwnerProfile: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as ProfilePatchInput;
  const data = await svc.patchOwnerProfile(userId, body);
  res.status(200).json(ok(data, 'Owner profile updated'));
};

export const getTenantProfile: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const data = await svc.getTenantProfile(userId);
  res.status(200).json(ok(data, 'Tenant profile retrieved'));
};

export const patchTenantProfile: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as ProfilePatchInput;
  const data = await svc.patchTenantProfile(userId, body);
  res.status(200).json(ok(data, 'Tenant profile updated'));
};
