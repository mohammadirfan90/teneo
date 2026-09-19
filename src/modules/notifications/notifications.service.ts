// src/modules/notifications/notifications.service.ts
//
// Phase 18 business logic for /api/v1/notifications/* plus the
// in-process emit() helper used by other modules.
//
// The emit() helper is the only public surface consumed by other
// modules in Phase 18. It must be called from INSIDE the originating
// module's prisma.$transaction so the notification row commits or
// rolls back atomically with the domain mutation. Phase 19+ replaces
// this with an outbox-driven dispatcher; the helper signature stays
// stable so callers can be migrated one-by-one.
//
// Default channel policy (per Phase 18 user answer):
//   Empty preference map → [IN_APP] for every event.
//   EMAIL is opt-in only — never on by default.
//
// Source-event idempotency:
//   When `opts.sourceEventId` is supplied, emit() pre-checks for an
//   existing row with the same (recipient, sourceEventId) and returns
//   it instead of inserting a duplicate. Mirrors the P2002 + pre-check
//   pattern from Phase 14 invoice generation + Phase 15 payment
//   intent + Phase 16 reading creation.

import type { Prisma } from '@/generated/prisma/client';
import type { NotificationChannel, NotificationEventType } from '@/generated/prisma/enums';

import type { Prisma as PrismaTypes } from '@/generated/prisma/client';

import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface NotificationView {
  id: string;
  recipientUserId: string;
  eventType: NotificationEventType;
  payload: Record<string, unknown>;
  read: boolean;
  readAt: string | null;
  channels: NotificationChannel[];
  createdAt: string;
}

export interface NotificationSummaryView {
  id: string;
  eventType: NotificationEventType;
  read: boolean;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationSummaryView[];
  nextCursor: string | null;
}

export interface PreferenceView {
  channelEventMap: Record<string, NotificationChannel[]>;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row type + mappers
// ──────────────────────────────────────────────────────────────────────

type NotificationRow = {
  id: string;
  recipientUserId: string;
  eventType: NotificationEventType;
  payload: Prisma.JsonValue;
  read: boolean;
  readAt: Date | null;
  channels: NotificationChannel[];
  createdAt: Date;
};

function notificationRowToView(r: NotificationRow): NotificationView {
  return {
    id: r.id,
    recipientUserId: r.recipientUserId,
    eventType: r.eventType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    read: r.read,
    readAt: r.readAt?.toISOString() ?? null,
    channels: r.channels,
    createdAt: r.createdAt.toISOString(),
  };
}

function notificationRowToSummary(r: NotificationRow): NotificationSummaryView {
  return {
    id: r.id,
    eventType: r.eventType,
    read: r.read,
    createdAt: r.createdAt.toISOString(),
  };
}

const fullNotificationSelect = () =>
  ({
    id: true,
    recipientUserId: true,
    eventType: true,
    payload: true,
    read: true,
    readAt: true,
    channels: true,
    createdAt: true,
  }) satisfies PrismaTypes.NotificationSelect;

const summaryNotificationSelect = () =>
  ({
    id: true,
    eventType: true,
    read: true,
    createdAt: true,
  }) satisfies PrismaTypes.NotificationSelect;

// ──────────────────────────────────────────────────────────────────────
// Channel-resolution helper (per Phase 18 user answer: IN_APP only
// by default; EMAIL is opt-in).
// ──────────────────────────────────────────────────────────────────────

async function resolveChannels(
  tx: Prisma.TransactionClient,
  recipientUserId: string,
  eventType: NotificationEventType
): Promise<NotificationChannel[]> {
  const prefs = await tx.notificationPreference.findUnique({
    where: { userId: recipientUserId },
    select: { channelEventMap: true },
  });
  if (!prefs) {
    return ['IN_APP'];
  }
  const map = (prefs.channelEventMap ?? {}) as Record<string, NotificationChannel[]>;
  const requested = map[eventType];
  if (!requested || requested.length === 0) {
    return ['IN_APP'];
  }
  return requested;
}

// ──────────────────────────────────────────────────────────────────────
// emit() — the in-process helper other modules call
// ──────────────────────────────────────────────────────────────────────

export interface EmitOptions {
  /** Outbox-event UUID — used for idempotency. */
  sourceEventId?: string;
  /** Pass the calling transaction client. If omitted, runs standalone. */
  tx?: Prisma.TransactionClient;
}

/**
 * Emit a notification to a recipient. Must be called from inside the
 * originating transaction so the notification commits/rolls back
 * atomically with the domain mutation.
 *
 * Defaults:
 *   • Channels = [IN_APP] unless the recipient has explicitly opted
 *     into other channels for this eventType.
 *   • `read` = false.
 *   • If `sourceEventId` matches an existing row for this recipient,
 *     returns the existing row instead of inserting a duplicate.
 *
 * Returns the inserted (or existing) `NotificationView`, or `null`
 * when the recipient has opted out of every channel for this event.
 */
export async function emit(
  eventType: NotificationEventType,
  recipientUserId: string,
  payload: Record<string, unknown>,
  opts: EmitOptions = {}
): Promise<NotificationView | null> {
  const tx = opts.tx ?? prisma;
  const channels = await resolveChannels(tx, recipientUserId, eventType);
  if (channels.length === 0) return null;

  // Idempotency: pre-check on (recipient, sourceEventId).
  if (opts.sourceEventId) {
    const existing = await tx.notification.findFirst({
      where: {
        recipientUserId,
        sourceEventId: opts.sourceEventId,
      },
      select: fullNotificationSelect(),
    });
    if (existing) {
      return notificationRowToView(existing as unknown as NotificationRow);
    }
  }

  try {
    const created = await tx.notification.create({
      data: {
        recipientUserId,
        eventType,
        payload: payload as PrismaTypes.InputJsonValue,
        sourceEventId: opts.sourceEventId ?? null,
        channels,
      },
      select: fullNotificationSelect(),
    });
    return notificationRowToView(created as unknown as NotificationRow);
  } catch (e) {
    // Race-loser branch: another concurrent emit won the partial UNIQUE.
    if (opts.sourceEventId && (e as { code?: string }).code === 'P2002') {
      const existing = await tx.notification.findFirst({
        where: { recipientUserId, sourceEventId: opts.sourceEventId },
        select: fullNotificationSelect(),
      });
      if (existing) {
        return notificationRowToView(existing as unknown as NotificationRow);
      }
    }
    throw e;
  }
}

/**
 * Optional event→recipient resolver scaffolding. Phase 19+ will fill
 * this in as each module wires `emit()` into its hot paths. For now
 * the helper is exposed but unused — callers pass the recipient
 * explicitly to stay in control.
 */
export const EVENT_RECIPIENT_RESOLVERS: Record<
  NotificationEventType,
  // (context) => Promise<string | null>
  string
> = {} as Record<NotificationEventType, string>;

export async function resolveRecipientForEvent(
  // Both params are unused: this is a Phase 19 placeholder that always
  // returns null, so callers must pass recipientUserId to emit()
  // explicitly. Underscore-prefixed rather than `void`-ed so the
  // intent is visible in the signature itself.
  _eventType: NotificationEventType,
  _context: Record<string, unknown> = {}
): Promise<string | null> {
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// listForCaller — GET /me
// ──────────────────────────────────────────────────────────────────────

export async function listForCaller(
  callerUserId: string,
  limit: number,
  cursor: string | null,
  unreadOnly: boolean
): Promise<NotificationPage> {
  const where: PrismaTypes.NotificationWhereInput = {
    recipientUserId: callerUserId,
  };
  if (unreadOnly) where.read = false;

  const { cursorDate, cursorId } = decodeCursor(cursor);
  if (cursorDate && !Number.isNaN(cursorDate.getTime())) {
    const or: PrismaTypes.NotificationWhereInput[] = [{ createdAt: { lt: cursorDate } }];
    if (cursorId) or.push({ createdAt: cursorDate, id: { lt: cursorId } });
    where.OR = or;
  }

  const rows = await prisma.notification.findMany({
    where,
    select: summaryNotificationSelect(),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url')
      : null;

  return {
    items: slice.map((r) => notificationRowToSummary(r as unknown as NotificationRow)),
    nextCursor,
  };
}

// ──────────────────────────────────────────────────────────────────────
// markRead — POST /:id/read
// ──────────────────────────────────────────────────────────────────────

export async function markRead(
  callerUserId: string,
  notificationId: string
): Promise<NotificationView> {
  return await prisma.$transaction(async (tx) => {
    const row = await tx.notification.findUnique({
      where: { id: notificationId },
      select: fullNotificationSelect(),
    });
    if (!row) throw new NotFoundError('Notification not found');

    // Caller must be the recipient. 404 no-leak when not owner
    // is overkill for a self-owned resource; 403 keeps the contract
    // consistent with other "own this row" checks.
    if (row.recipientUserId !== callerUserId) {
      throw new ForbiddenError('NOT_OWNER', 'Caller is not the recipient of this notification');
    }

    // Idempotent: re-marking an already-read notification is a no-op
    // (still returns the view) rather than a 409.
    if (!row.read) {
      const updated = await tx.notification.update({
        where: { id: notificationId },
        data: { read: true, readAt: new Date() },
        select: fullNotificationSelect(),
      });
      return notificationRowToView(updated as unknown as NotificationRow);
    }
    return notificationRowToView(row as unknown as NotificationRow);
  });
}

// ──────────────────────────────────────────────────────────────────────
// markAllRead — POST /read-all
// ──────────────────────────────────────────────────────────────────────

export async function markAllRead(callerUserId: string): Promise<{ updated: number }> {
  const res = await prisma.notification.updateMany({
    where: { recipientUserId: callerUserId, read: false },
    data: { read: true, readAt: new Date() },
  });
  return { updated: res.count };
}

// ──────────────────────────────────────────────────────────────────────
// Preferences
// ──────────────────────────────────────────────────────────────────────

export async function getPreferences(callerUserId: string): Promise<PreferenceView> {
  const row = await prisma.notificationPreference.findUnique({
    where: { userId: callerUserId },
    select: { channelEventMap: true },
  });
  if (!row) {
    return { channelEventMap: {} };
  }
  return {
    channelEventMap: (row.channelEventMap ?? {}) as Record<string, NotificationChannel[]>,
  };
}

export async function updatePreferences(
  callerUserId: string,
  channelEventMap: Record<string, NotificationChannel[]>
): Promise<PreferenceView> {
  const updated = await prisma.notificationPreference.upsert({
    where: { userId: callerUserId },
    create: {
      userId: callerUserId,
      channelEventMap: channelEventMap as PrismaTypes.InputJsonValue,
    },
    update: {
      channelEventMap: channelEventMap as PrismaTypes.InputJsonValue,
    },
    select: { channelEventMap: true },
  });
  return {
    channelEventMap: (updated.channelEventMap ?? {}) as Record<string, NotificationChannel[]>,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Cursor encoder / decoder — shared pattern (tickets, bills, …).
// ──────────────────────────────────────────────────────────────────────

function decodeCursor(cursor: string | null): {
  cursorDate: Date | null;
  cursorId: string | null;
} {
  if (!cursor) return { cursorDate: null, cursorId: null };
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|');
    const date = iso ? new Date(iso) : null;
    return {
      cursorDate: date && !Number.isNaN(date.getTime()) ? date : null,
      cursorId: id || null,
    };
  } catch {
    return { cursorDate: null, cursorId: null };
  }
}
