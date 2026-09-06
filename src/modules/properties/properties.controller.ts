// src/modules/properties/properties.controller.ts
//
// Thin handlers per Phase 10 contract (spec §13.2.3).

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import {
  type CreatePropertyInput,
  type ListMyPropertiesQuery,
  type PatchPropertyInput,
  type PropertyIdParams,
  listMyPropertiesQuerySchema,
} from './properties.schemas';
import * as svc from './properties.service';

export const createProperty: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as CreatePropertyInput;
  const data = await svc.createProperty(userId, body);
  res.status(201).json(ok(data, 'Property created'));
};

export const getProperty: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as PropertyIdParams;
  const data = await svc.getProperty(id, userId, roles);
  res.status(200).json(ok(data, 'Property retrieved'));
};

export const patchProperty: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as PropertyIdParams;
  const body = req.body as PatchPropertyInput;
  const data = await svc.patchProperty(id, userId, roles, body);
  res.status(200).json(ok(data, 'Property updated'));
};

export const deleteProperty: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as PropertyIdParams;
  const data = await svc.softDeleteProperty(id, userId, roles);
  res.status(200).json(ok(data, 'Property deleted'));
};

export const publishProperty: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const roles = req.user!.roles;
  const { id } = req.params as unknown as PropertyIdParams;
  const data = await svc.publishProperty(id, userId, roles);
  res.status(200).json(ok(data, 'Property published'));
};

export const listMyProperties: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  // Re-parse here so we get the schema-coerced types (number, etc.)
  // independent of req.query mutation semantics. The route-level
  // zodValidate({ query }) still authorises the shape; we just can't
  // rely on req.query being a mutable, coerced view in Express 5
  // (the getter rebuilds it on each access).
  const query: ListMyPropertiesQuery = listMyPropertiesQuerySchema.parse(req.query);
  const data = await svc.listMyProperties(userId, query);
  res.status(200).json(ok(data, 'Properties retrieved'));
};
