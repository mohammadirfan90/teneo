// src/modules/applications/applications.controller.ts
//
// Thin handlers for /api/v1/applications (per spec §13.2.5).

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import type {
  ApplicationIdParams,
  CreateApplicationInput,
  CreateViewingInput,
  ListApplicationsQuery,
  TransitionApplicationInput,
  WithdrawApplicationInput,
} from './applications.schemas';
import {
  createApplication,
  createViewingRequest,
  getApplication,
  listApplicationsForOwner,
  listApplicationsForTenant,
  transitionApplication,
  withdrawApplication,
} from './applications.service';

// ── Applications ──────────────────────────────────────────────────────

export const createApplicationHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as CreateApplicationInput;
  const data = await createApplication(userId, body);
  res.status(201).json(ok(data, 'Application created'));
};

export const listApplicationsHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { listApplicationsQuerySchema } = await import('./applications.schemas');
  const query: ListApplicationsQuery = listApplicationsQuerySchema.parse(req.query);
  // Route layer guarantees requireRole('TENANT','OWNER'|'ADMIN'); service
  // decides which list view to run. We re-check role here so a future
  // refactor of route guards can't accidentally hand an OWNER a
  // tenant-shaped list.
  const roles = req.user!.roles;
  const isTenant = roles.includes('TENANT') && !roles.includes('OWNER');
  const data = isTenant
    ? await listApplicationsForTenant(userId, query)
    : await listApplicationsForOwner(userId, query);
  res.status(200).json(ok(data, 'Applications retrieved'));
};

export const getApplicationHandler: RequestHandler = async (req, res) => {
  const { id } = req.params as unknown as ApplicationIdParams;
  const data = await getApplication(id);
  res.status(200).json(ok(data, 'Application retrieved'));
};

export const transitionApplicationHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as ApplicationIdParams;
  const body = req.body as TransitionApplicationInput;
  const data = await transitionApplication(userId, id, body);
  res.status(200).json(ok(data, 'Application transitioned'));
};

export const withdrawApplicationHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as ApplicationIdParams;
  const body = req.body as WithdrawApplicationInput;
  const data = await withdrawApplication(userId, id, body);
  res.status(200).json(ok(data, 'Application withdrawn'));
};

// ── Viewing creation (lives under /applications/:id/viewing) ──────────

export const createViewingHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as ApplicationIdParams;
  const body = req.body as CreateViewingInput;
  const data = await createViewingRequest(userId, id, body);
  res.status(201).json(ok(data, 'Viewing requested'));
};
