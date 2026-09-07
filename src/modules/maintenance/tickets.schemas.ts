// src/modules/maintenance/tickets.schemas.ts
//
// Zod schemas for /api/v1/rooms/:roomId/tickets + /api/v1/tickets/*
// inputs per Phase 17 (11 §11.5, 05 §5.7, 04 §4.6).
//
// Endpoints:
//   POST  /rooms/:roomId/tickets    createTicket
//   GET   /rooms/:roomId/tickets    listTicketsForRoom
//   GET   /tickets/me               listMyTickets
//   GET   /tickets/queue            listQueue
//   GET   /tickets/:id              getTicket
//   PATCH /tickets/:id              transitionTicket
//   POST  /tickets/:id/updates      addUpdate
//   POST  /tickets/:id/rate         rateTicket

import { z } from 'zod';

import {
  MaintenanceCategory as MaintenanceCategoryConst,
  MaintenancePriority as MaintenancePriorityConst,
  MaintenanceStatus as MaintenanceStatusConst,
} from '@/generated/prisma/enums';

// ──────────────────────────────────────────────────────────────────────
// Enum-derived tuple literals (the Prisma-generated const objects are
// the single source of truth — we just spread them into tuples so zod
// gets a [a, b, ...] array for `z.enum`).
// ──────────────────────────────────────────────────────────────────────

type MaintenanceCategoryValue =
  (typeof MaintenanceCategoryConst)[keyof typeof MaintenanceCategoryConst];
type MaintenancePriorityValue =
  (typeof MaintenancePriorityConst)[keyof typeof MaintenancePriorityConst];
type MaintenanceStatusValue =
  (typeof MaintenanceStatusConst)[keyof typeof MaintenanceStatusConst];

const maintenanceCategoryValues = Object.values(
  MaintenanceCategoryConst
) as [MaintenanceCategoryValue, ...MaintenanceCategoryValue[]];
const maintenancePriorityValues = Object.values(
  MaintenancePriorityConst
) as [MaintenancePriorityValue, ...MaintenancePriorityValue[]];
const maintenanceStatusValues = Object.values(
  MaintenanceStatusConst
) as [MaintenanceStatusValue, ...MaintenanceStatusValue[]];

// ──────────────────────────────────────────────────────────────────────
// Path / query params
// ──────────────────────────────────────────────────────────────────────

/** Params for /rooms/:roomId/tickets/*. */
export const roomIdParamsSchema = z.object({
  roomId: z.string().uuid({ message: 'roomId must be a UUID' }),
});
export type RoomIdParams = z.infer<typeof roomIdParamsSchema>;

/** Params for /tickets/:id*. */
export const ticketIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'id must be a UUID' }),
});
export type TicketIdParams = z.infer<typeof ticketIdParamsSchema>;

/**
 * GET /tickets/me + /tickets/queue + /rooms/:roomId/tickets — query
 * shape. `status` + `priority` are optional single-value filters.
 */
export const listTicketsQuerySchema = z.object({
  status: z.enum(maintenanceStatusValues).optional(),
  priority: z.enum(maintenancePriorityValues).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .optional(),
  cursor: z.string().min(1).optional(),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// POST /rooms/:roomId/tickets — body
// ──────────────────────────────────────────────────────────────────────

/**
 * Create a new maintenance ticket. `priority` defaults to MEDIUM in
 * the service mapper (mirroring the Prisma schema default).
 */
export const createTicketSchema = z
  .object({
    title: z
      .string()
      .min(1, 'title must not be empty')
      .max(120, 'title must be at most 120 chars'),
    description: z
      .string()
      .min(1, 'description must not be empty')
      .max(4000, 'description must be at most 4000 chars'),
    category: z.enum(maintenanceCategoryValues),
    priority: z.enum(maintenancePriorityValues).optional(),
  })
  .strict();
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export function toCreateTicketServiceInput(
  roomId: string,
  body: CreateTicketInput
): {
  roomId: string;
  title: string;
  description: string;
  category: MaintenanceCategoryValue;
  priority: MaintenancePriorityValue;
} {
  return {
    roomId,
    title: body.title,
    description: body.description,
    category: body.category,
    priority: body.priority ?? 'MEDIUM',
  };
}

// ──────────────────────────────────────────────────────────────────────
// PATCH /tickets/:id — body
// ──────────────────────────────────────────────────────────────────────

/**
 * `comment` is REQUIRED when transitioning into DISPUTED so the
 * tenant has to articulate what is wrong with the resolution.
 * Optional for every other transition.
 */
export const patchTicketSchema = z
  .object({
    toStatus: z.enum(maintenanceStatusValues),
    comment: z.string().min(1).max(4000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.toStatus !== 'DISPUTED' ||
      (typeof v.comment === 'string' && v.comment.length > 0),
    {
      message: 'comment is required when transitioning to DISPUTED',
      path: ['comment'],
    }
  );
export type PatchTicketInput = z.infer<typeof patchTicketSchema>;

export function toPatchTicketServiceInput(
  id: string,
  body: PatchTicketInput
): {
  id: string;
  toStatus: MaintenanceStatusValue;
  comment: string | null;
} {
  return {
    id,
    toStatus: body.toStatus,
    comment: body.comment ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /tickets/:id/updates — body
// ──────────────────────────────────────────────────────────────────────

/**
 * `statusAfter` lets one call do "comment + transition" in one go
 * (used by the dispute convenience endpoint, but exposed generally
 * so any status move can be combined with a free-text comment).
 */
export const addUpdateSchema = z
  .object({
    body: z
      .string()
      .min(1, 'body must not be empty')
      .max(4000, 'body must be at most 4000 chars'),
    statusAfter: z.enum(maintenanceStatusValues).optional(),
  })
  .strict();
export type AddUpdateInput = z.infer<typeof addUpdateSchema>;

export function toAddUpdateServiceInput(
  ticketId: string,
  body: AddUpdateInput
): {
  ticketId: string;
  body: string;
  statusAfter: MaintenanceStatusValue | null;
} {
  return {
    ticketId,
    body: body.body,
    statusAfter: body.statusAfter ?? null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /tickets/:id/rate — body
// ──────────────────────────────────────────────────────────────────────

export const rateTicketSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(1000).optional(),
  })
  .strict();
export type RateTicketInput = z.infer<typeof rateTicketSchema>;

export function toRateTicketServiceInput(
  id: string,
  body: RateTicketInput
): {
  id: string;
  rating: number;
  comment: string | null;
} {
  return {
    id,
    rating: body.rating,
    comment: body.comment ?? null,
  };
}
