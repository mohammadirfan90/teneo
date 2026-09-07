// src/modules/notifications/notifications.schemas.ts
//
// Zod schemas for /api/v1/notifications/* per Phase 18
// (04 §4.3.7, 05 §5.8, 13 §13.2.8).
//
// Endpoints:
//   GET   /me                     listNotifications
//   POST  /:id/read               markRead
//   POST  /read-all               markAllRead
//   GET   /me/preferences         getPreferences
//   PUT   /me/preferences         updatePreferences

import { z } from 'zod';

import {
  NotificationChannel as NotificationChannelConst,
  NotificationEventType as NotificationEventTypeConst,
} from '@/generated/prisma/enums';

// ──────────────────────────────────────────────────────────────────────
// Enum-derived tuple literals (same pattern as tickets.schemas.ts).
// ──────────────────────────────────────────────────────────────────────

type NotificationChannelValue =
  (typeof NotificationChannelConst)[keyof typeof NotificationChannelConst];
type NotificationEventTypeValue =
  (typeof NotificationEventTypeConst)[keyof typeof NotificationEventTypeConst];

const notificationChannelValues = Object.values(NotificationChannelConst) as [
  NotificationChannelValue,
  ...NotificationChannelValue[],
];

const notificationEventTypeValues = Object.values(NotificationEventTypeConst) as [
  NotificationEventTypeValue,
  ...NotificationEventTypeValue[],
];

// ──────────────────────────────────────────────────────────────────────
// Path / query params
// ──────────────────────────────────────────────────────────────────────

/** Params for /:id/read. */
export const notificationIdParamsSchema = z.object({
  id: z.string().uuid({ message: 'id must be a UUID' }),
});
export type NotificationIdParams = z.infer<typeof notificationIdParamsSchema>;

/**
 * GET /me — query shape. `unreadOnly` filters to unread rows; default
 * false (return everything).
 */
export const listNotificationsQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/, 'limit must be a positive integer').optional(),
  cursor: z.string().min(1).optional(),
  unreadOnly: z.union([z.literal('true'), z.literal('false')]).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

// ──────────────────────────────────────────────────────────────────────
// PUT /me/preferences — body
// ──────────────────────────────────────────────────────────────────────

/**
 * Channel-event preference map. Keys are FREE-FORM event-type strings
 * — clients can store new event types from Phase 19+ without breaking
 * serialization (the closed-set enum on the server side validates at
 * resolution time, not at write time).
 *
 * Values are arrays of channels (must be non-empty). An empty map
 * means "default to [IN_APP] for everything".
 */
export const updatePreferencesSchema = z
  .object({
    channelEventMap: z.record(
      z.string().min(1).max(64),
      z
        .array(z.enum(notificationChannelValues))
        .min(1, 'channel list must be non-empty')
        .max(2, 'only IN_APP and EMAIL are supported in v1')
    ),
  })
  .strict();
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

export function toUpdatePreferencesServiceInput(body: UpdatePreferencesInput): {
  channelEventMap: Record<string, NotificationChannelValue[]>;
} {
  return {
    channelEventMap: body.channelEventMap as Record<string, NotificationChannelValue[]>,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Re-exports for callers that want the enum value arrays.
// ──────────────────────────────────────────────────────────────────────

export { notificationChannelValues, notificationEventTypeValues };
export type { NotificationChannelValue, NotificationEventTypeValue };
