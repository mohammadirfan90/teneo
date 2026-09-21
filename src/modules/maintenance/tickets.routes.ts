// src/modules/maintenance/tickets.routes.ts
//
// Phase 17: routes for /api/v1/rooms/:roomId/tickets and
// /api/v1/tickets/*.
//
// Two routers live in this file:
//   ticketsRoomRouter() — mounted under /api/v1/rooms so the path
//                         /:roomId/tickets resolves correctly with
//                         mergeParams.
//   ticketsRouter()     — mounted under /api/v1/tickets for /me,
//                         /queue, /:id, /:id/updates, /:id/rate.

import { Router } from 'express';

import { requireAuth } from '@/middleware/auth';
import { withIdempotency } from '@/middleware/idempotency';
import { requireRole } from '@/middleware/role';
import { asyncHandler } from '@/lib/async-handler';
import { zodValidate } from '@/lib/validate';

import {
  addUpdateHandler,
  createTicketHandler,
  getTicketHandler,
  listMyTicketsHandler,
  listQueueHandler,
  listTicketsForRoomHandler,
  patchTicketHandler,
  rateTicketHandler,
  requireRoomParty,
  requireTicketParty,
} from './tickets.controller';
import {
  addUpdateSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  patchTicketSchema,
  rateTicketSchema,
  roomIdParamsSchema,
  ticketIdParamsSchema,
} from './tickets.schemas';

// ──────────────────────────────────────────────────────────────────────
// ticketsRoomRouter — mounted at /api/v1/rooms
// ──────────────────────────────────────────────────────────────────────

export function ticketsRoomRouter(): Router {
  const r = Router({ mergeParams: true });

  // POST /:roomId/tickets — TENANT (or ADMIN)
  r.post(
    '/:roomId/tickets',
    requireAuth,
    requireRole('TENANT', 'ADMIN'),
    zodValidate({ params: roomIdParamsSchema }),
    requireRoomParty,
    zodValidate({ body: createTicketSchema }),
    withIdempotency,
    asyncHandler(createTicketHandler)
  );

  // GET /:roomId/tickets — party to the room
  r.get(
    '/:roomId/tickets',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: roomIdParamsSchema }),
    requireRoomParty,
    zodValidate({ query: listTicketsQuerySchema }),
    asyncHandler(listTicketsForRoomHandler)
  );

  return r;
}

// ──────────────────────────────────────────────────────────────────────
// ticketsRouter — mounted at /api/v1/tickets
// ──────────────────────────────────────────────────────────────────────

export function ticketsRouter(): Router {
  const r = Router();

  // GET /me — TENANT (own raised tickets)
  r.get(
    '/me',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ query: listTicketsQuerySchema }),
    asyncHandler(listMyTicketsHandler)
  );

  // GET /queue — OWNER / ADMIN triage queue
  r.get(
    '/queue',
    requireAuth,
    requireRole('OWNER', 'ADMIN'),
    zodValidate({ query: listTicketsQuerySchema }),
    asyncHandler(listQueueHandler)
  );

  // GET /:id — party-or-admin
  r.get(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: ticketIdParamsSchema }),
    requireTicketParty,
    asyncHandler(getTicketHandler)
  );

  // PATCH /:id — transition (owner's forward, ADMIN for DISPUTED→RESOLVED,
  //                raiser for CANCELLED, tenant for DISPUTED).
  r.patch(
    '/:id',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: ticketIdParamsSchema }),
    requireTicketParty,
    zodValidate({ body: patchTicketSchema }),
    withIdempotency,
    asyncHandler(patchTicketHandler)
  );

  // POST /:id/updates — party comment thread (and optional transition).
  r.post(
    '/:id/updates',
    requireAuth,
    requireRole('TENANT', 'OWNER', 'ADMIN'),
    zodValidate({ params: ticketIdParamsSchema }),
    requireTicketParty,
    zodValidate({ body: addUpdateSchema }),
    withIdempotency,
    asyncHandler(addUpdateHandler)
  );

  // POST /:id/rate — TENANT-only, raiser only.
  r.post(
    '/:id/rate',
    requireAuth,
    requireRole('TENANT'),
    zodValidate({ params: ticketIdParamsSchema }),
    requireTicketParty,
    zodValidate({ body: rateTicketSchema }),
    asyncHandler(rateTicketHandler)
  );

  return r;
}
