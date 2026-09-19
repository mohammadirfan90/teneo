// src/modules/maintenance/tickets.controller.ts
//
// Phase 17: thin handlers + `requireTicketParty` middleware for
// /api/v1/rooms/:roomId/tickets and /api/v1/tickets/*.
//
// Pattern mirrors `invoices.controller.ts` / `readings.controller.ts`
// (Phase 14/16): 404 no-leak + 403 NOT_OWNER, ADMIN bypass.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { asyncHandler } from '@/lib/async-handler';
import { ok } from '@/lib/envelope';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/lib/errors';

import type { AppRole } from '@/middleware/auth';
import {
  addUpdate,
  createTicket,
  getTicket,
  listMyTickets,
  listQueue,
  listTicketsForCaller,
  listTicketsForRoom,
  rateTicket,
  resolvePartiesForRoom,
  resolvePartiesForTicket,
  transitionTicket,
} from './tickets.service';
import type {
  AddUpdateInput,
  CreateTicketInput,
  ListTicketsQuery,
  PatchTicketInput,
  RateTicketInput,
  RoomIdParams,
  TicketIdParams,
} from './tickets.schemas';
import {
  addUpdateSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  patchTicketSchema,
  rateTicketSchema,
  roomIdParamsSchema,
  ticketIdParamsSchema,
  toAddUpdateServiceInput,
  toCreateTicketServiceInput,
  toPatchTicketServiceInput,
  toRateTicketServiceInput,
} from './tickets.schemas';

// ──────────────────────────────────────────────────────────────────────
// Middleware: ticket-party membership
// ──────────────────────────────────────────────────────────────────────

/**
 * Allows access if the caller is ADMIN, OR the lease owner, OR a
 * tenant on the lease, OR the original raiser. 404 (not 403) when the
 * ticket doesn't exist so existence isn't leaked to a non-party who
 * guessed an ID.
 */
export const requireTicketParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const { id } = req.params as unknown as TicketIdParams;
    const parties = await resolvePartiesForTicket(id);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Ticket not found');
    }
    const callerId = req.user.id;
    const isParty =
      parties.ownerId === callerId ||
      parties.tenantIds.includes(callerId);
    if (!isParty) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this ticket');
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Allows access if the caller is ADMIN, OR the property owner of the
 * room, OR a tenant on any ACTIVE lease for a room of the property.
 * 404 (not 403) when the room doesn't exist. Used by the
 * /rooms/:roomId/tickets endpoints.
 */
export const requireRoomParty: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new UnauthorizedError('Authentication required');
    }
    if (req.user.roles.includes('ADMIN')) {
      next();
      return;
    }
    const { roomId } = req.params as unknown as RoomIdParams;
    const parties = await resolvePartiesForRoom(roomId);
    if (parties.ownerId === null && parties.tenantIds.length === 0) {
      throw new NotFoundError('Room not found');
    }
    const callerId = req.user.id;
    const isParty =
      parties.ownerId === callerId ||
      parties.tenantIds.includes(callerId);
    if (!isParty) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not a party to this room');
    }
    next();
  } catch (err) {
    next(err);
  }
};

// ──────────────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────────────

// ── POST /rooms/:roomId/tickets ───────────────────────────────────────

export const createTicketHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const { roomId } = req.params as unknown as RoomIdParams;
    const body = req.body as CreateTicketInput;
    const serviceInput = toCreateTicketServiceInput(roomId, body);
    const data = await createTicket(userId, serviceInput);
    res.status(201).json(ok(data, 'Ticket created'));
  }
);

// ── GET /rooms/:roomId/tickets ────────────────────────────────────────

export const listTicketsForRoomHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const isAdmin = req.user!.roles.includes('ADMIN');
    const { roomId } = req.params as unknown as RoomIdParams;
    const query: ListTicketsQuery = listTicketsQuerySchema.parse(req.query);
    const limit = parseLimit(query.limit);
    const data = await listTicketsForRoom(
      userId,
      isAdmin,
      roomId,
      {
        status: query.status as never,
        priority: query.priority as never,
      },
      limit,
      query.cursor ?? null
    );
    res.status(200).json(ok(data, 'Tickets retrieved'));
  }
);

// ── GET /tickets/me ──────────────────────────────────────────────────

export const listMyTicketsHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const query: ListTicketsQuery = listTicketsQuerySchema.parse(req.query);
    const limit = parseLimit(query.limit);
    const data = await listMyTickets(
      userId,
      {
        status: query.status as never,
        priority: query.priority as never,
      },
      limit,
      query.cursor ?? null
    );
    res.status(200).json(ok(data, 'Tickets retrieved'));
  }
);

// ── GET /tickets/queue ──────────────────────────────────────────────

export const listQueueHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const isAdmin = req.user!.roles.includes('ADMIN');
    const query: ListTicketsQuery = listTicketsQuerySchema.parse(req.query);
    const limit = parseLimit(query.limit);
    const data = await listQueue(
      userId,
      isAdmin,
      {
        status: query.status as never,
        priority: query.priority as never,
      },
      limit,
      query.cursor ?? null
    );
    res.status(200).json(ok(data, 'Queue retrieved'));
  }
);

// ── GET /tickets/:id ─────────────────────────────────────────────────

export const getTicketHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const isAdmin = req.user!.roles.includes('ADMIN');
    const { id } = req.params as unknown as TicketIdParams;
    const data = await getTicket(userId, isAdmin, id);
    res.status(200).json(ok(data, 'Ticket retrieved'));
  }
);

// ── PATCH /tickets/:id ───────────────────────────────────────────────

export const patchTicketHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const isAdmin = req.user!.roles.includes('ADMIN');
    const { id } = req.params as unknown as TicketIdParams;
    const body = req.body as PatchTicketInput;
    const serviceInput = toPatchTicketServiceInput(id, body);
    const data = await transitionTicket(userId, isAdmin, serviceInput);
    res.status(200).json(ok(data, 'Ticket updated'));
  }
);

// ── POST /tickets/:id/updates ────────────────────────────────────────

export const addUpdateHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const isAdmin = req.user!.roles.includes('ADMIN');
    const { id } = req.params as unknown as TicketIdParams;
    const body = req.body as AddUpdateInput;
    const serviceInput = toAddUpdateServiceInput(id, body);
    const data = await addUpdate(userId, isAdmin, serviceInput);
    res.status(201).json(ok(data, 'Update posted'));
  }
);

// ── POST /tickets/:id/rate ───────────────────────────────────────────

export const rateTicketHandler: RequestHandler = asyncHandler(
  async (req, res) => {
    const userId = req.user!.id;
    const { id } = req.params as unknown as TicketIdParams;
    const body = req.body as RateTicketInput;
    const serviceInput = toRateTicketServiceInput(id, body);
    const data = await rateTicket(userId, serviceInput);
    res.status(200).json(ok(data, 'Ticket rated'));
  }
);

// ──────────────────────────────────────────────────────────────────────
// Helpers (not exported)
// ──────────────────────────────────────────────────────────────────────

function parseLimit(raw: string | undefined): number {
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 20;
  return Math.min(n, 100);
}

// AppRole re-export for callers that wire the middleware elsewhere.
export type { AppRole };
