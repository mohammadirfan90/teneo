// src/modules/properties/buildings.controller.ts
//
// Thin handlers per Phase 10 contract (spec §13.2.3).

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import type {
  BuildingIdParams,
  CreateBuildingInput,
  PatchBuildingInput,
  PropertyIdParams,
} from './buildings.schemas';
import * as svc from './buildings.service';

export const createBuilding: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { propertyId } = req.params as unknown as PropertyIdParams;
  const body = req.body as CreateBuildingInput;
  const data = await svc.createBuilding(propertyId, userId, roles, body);
  res.status(201).json(ok(data, 'Building created'));
};

export const patchBuilding: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as BuildingIdParams;
  const body = req.body as PatchBuildingInput;
  const data = await svc.patchBuilding(id, userId, roles, body);
  res.status(200).json(ok(data, 'Building updated'));
};
