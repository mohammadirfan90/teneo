// src/modules/properties/flats.controller.ts
//
// Thin handlers per Phase 10 contract (spec §13.2.3).

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import type { BuildingIdParams, CreateFlatInput } from './flats.schemas';
import * as svc from './flats.service';

export const createFlat: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { buildingId } = req.params as unknown as BuildingIdParams;
  const body = req.body as CreateFlatInput;
  const data = await svc.createFlat(buildingId, userId, roles, body);
  res.status(201).json(ok(data, 'Flat created'));
};
