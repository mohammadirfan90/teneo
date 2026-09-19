// src/modules/notifications/notifications.controller.ts
//
// Phase 18: thin handlers for /api/v1/notifications/*. Pattern mirrors
// `bills.controller.ts` / `tickets.controller.ts`. Every endpoint is
// caller-scoped (own notifications only).

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';

import {
  type ListNotificationsQuery,
  type UpdatePreferencesInput,
  listNotificationsQuerySchema,
  toUpdatePreferencesServiceInput,
} from './notifications.schemas';
import type { NotificationIdParams } from './notifications.schemas';
import {
  getPreferences,
  listForCaller,
  markAllRead,
  markRead,
  updatePreferences,
} from './notifications.service';

// ──────────────────────────────────────────────────────────────────────
// GET /me — caller-scoped feed
// ──────────────────────────────────────────────────────────────────────

export const listNotificationsHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const query: ListNotificationsQuery = listNotificationsQuerySchema.parse(req.query);
  const limit = parseLimit(query.limit);
  const unreadOnly = query.unreadOnly === 'true';
  const data = await listForCaller(userId, limit, query.cursor ?? null, unreadOnly);
  res.status(200).json(ok(data, 'Notifications retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /:id/read — mark one read
// ──────────────────────────────────────────────────────────────────────

export const markReadHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as NotificationIdParams;
  const data = await markRead(userId, id);
  res.status(200).json(ok(data, 'Notification marked read'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /read-all — bulk mark
// ──────────────────────────────────────────────────────────────────────

export const markAllReadHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const data = await markAllRead(userId);
  res.status(200).json(ok(data, 'Notifications marked read'));
});

// ──────────────────────────────────────────────────────────────────────
// GET /me/preferences
// ──────────────────────────────────────────────────────────────────────

export const getPreferencesHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const data = await getPreferences(userId);
  res.status(200).json(ok(data, 'Preferences retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// PUT /me/preferences
// ──────────────────────────────────────────────────────────────────────

export const updatePreferencesHandler: RequestHandler = asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as UpdatePreferencesInput;
  const serviceInput = toUpdatePreferencesServiceInput(body);
  const data = await updatePreferences(userId, serviceInput.channelEventMap);
  res.status(200).json(ok(data, 'Preferences updated'));
});

// ──────────────────────────────────────────────────────────────────────
// Helpers (not exported)
// ──────────────────────────────────────────────────────────────────────

function parseLimit(raw: string | undefined): number {
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 20;
  return Math.min(n, 100);
}
