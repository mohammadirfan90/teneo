// src/modules/notifications/notifications.routes.ts
//
// Routes for /api/v1/notifications/* — mounted in server.ts under
// /api/v1/notifications.
//
//   GET   /me              caller-scoped feed (cursor-paginated)
//   POST  /:id/read        mark one notification read
//   POST  /read-all        mark every notification for the caller read
//   GET   /me/preferences  get channel-event map
//   PUT   /me/preferences  upsert channel-event map

import { type RequestHandler, Router } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';
import { requireRole } from '@/middleware/role';

import {
  getPreferencesHandler,
  listNotificationsHandler,
  markAllReadHandler,
  markReadHandler,
  updatePreferencesHandler,
} from './notifications.controller';
import {
  listNotificationsQuerySchema,
  notificationIdParamsSchema,
  updatePreferencesSchema,
} from './notifications.schemas';

export function notificationsRouter(): Router {
  const r = Router();

  // GET /me — feed
  r.get(
    '/me',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ query: listNotificationsQuerySchema }),
    asyncHandler(listNotificationsHandler)
  );

  // POST /:id/read
  r.post(
    '/:id/read',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: notificationIdParamsSchema }),
    asyncHandler(markReadHandler)
  );

  // POST /read-all
  r.post(
    '/read-all',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    asyncHandler(markAllReadHandler)
  );

  // GET /me/preferences
  r.get(
    '/me/preferences',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    asyncHandler(getPreferencesHandler)
  );

  // PUT /me/preferences
  r.put(
    '/me/preferences',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ body: updatePreferencesSchema }),
    asyncHandler(updatePreferencesHandler)
  );

  return r;
}
