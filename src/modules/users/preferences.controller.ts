// src/modules/users/preferences.controller.ts

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';
import * as svc from './preferences.service';
import type { PreferencesPutInput, PreferencesVisibilityInput } from './users.schemas';

export const getPreferences: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const data = await svc.getPreferences(userId);
  res.status(200).json(ok(data, 'Tenant preferences retrieved'));
};

export const putPreferences: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as PreferencesPutInput;
  const data = await svc.putPreferences(userId, body);
  res.status(200).json(ok(data, 'Tenant preferences updated'));
};

export const patchVisibility: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as PreferencesVisibilityInput;
  const data = await svc.patchVisibility(userId, body);
  res.status(200).json(ok(data, 'Visibility updated'));
};
