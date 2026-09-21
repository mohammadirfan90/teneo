// src/modules/admin/audit.controller.ts
//
// Phase 19: read-only listing for /api/v1/admin/audit-logs.
//
//   GET /audit-logs?limit=&cursor=&actorUserId=&action=&targetEntityType=&targetEntityId=&from=&to=&format=
//
// Cursor: <occurredAt ISO>|<id> base64url. Order: occurredAt DESC, id DESC.
// Format:
//   json (default) — paginated { items[], nextCursor }
//   csv            — streamed text/csv with header row; iterates pages of 500.
//
// Schemas live in this file (rather than a separate *.schemas.ts) per
// the Phase 19 plan.

import type { RequestHandler, Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '@/lib/async-handler';
import { prisma } from '@/lib/db';
import { ok } from '@/lib/envelope';

// ──────────────────────────────────────────────────────────────────────
// Zod schemas (inline)
// ──────────────────────────────────────────────────────────────────────

const isoDate = z.preprocess((v) => {
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  return v;
}, z.date());

export const listAuditLogsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    cursor: z.string().min(1).max(500).optional(),
    actorUserId: z.string().uuid().optional(),
    action: z.string().min(1).max(64).optional(),
    targetEntityType: z.string().min(1).max(64).optional(),
    targetEntityId: z.string().uuid().optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    format: z.enum(['json', 'csv']).optional().default('json'),
  })
  .strict();

// ──────────────────────────────────────────────────────────────────────
// View types
// ──────────────────────────────────────────────────────────────────────

export interface AuditLogView {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetEntityType: string | null;
  targetEntityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuditLogPage {
  items: AuditLogView[];
  nextCursor: string | null;
}

// ──────────────────────────────────────────────────────────────────────
// Internal row type + mapper
// ──────────────────────────────────────────────────────────────────────

type AuditLogRow = {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetEntityType: string | null;
  targetEntityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

const auditLogSelect = {
  id: true,
  occurredAt: true,
  actorUserId: true,
  actorRole: true,
  action: true,
  targetEntityType: true,
  targetEntityId: true,
  ipAddress: true,
  userAgent: true,
} as const;

function rowToView(r: AuditLogRow): AuditLogView {
  return {
    id: r.id,
    occurredAt: r.occurredAt.toISOString(),
    actorUserId: r.actorUserId,
    actorRole: r.actorRole,
    action: r.action,
    targetEntityType: r.targetEntityType,
    targetEntityId: r.targetEntityId,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function decodeCursor(cursor: string | undefined): Date | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso] = decoded.split('|');
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function encodeCursor(d: Date, id: string): string {
  return Buffer.from(`${d.toISOString()}|${id}`, 'utf8').toString('base64url');
}

// CSV-escape per RFC 4180: wrap in quotes if the value contains a
// comma, quote, or newline; double-up any embedded quotes.
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// GET /audit-logs
// ──────────────────────────────────────────────────────────────────────

export const listAuditLogsHandler: RequestHandler = asyncHandler(async (req, res) => {
  const q: z.infer<typeof listAuditLogsQuerySchema> = listAuditLogsQuerySchema.parse(req.query);

  const where = buildWhere(q);

  if (q.format === 'csv') {
    await streamCsv(res, where);
    return;
  }

  const cursorDate = decodeCursor(q.cursor);
  const rows = await prisma.auditLog.findMany({
    where: cursorDate ? { ...where, occurredAt: { lt: cursorDate } } : where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    select: auditLogSelect,
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt, last.id) : null;

  const data: AuditLogPage = {
    items: page.map((r) => rowToView(r as AuditLogRow)),
    nextCursor,
  };
  res.status(200).json(ok(data, 'Audit logs retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// Where-clause builder + CSV streamer (not exported)
// ──────────────────────────────────────────────────────────────────────

function buildWhere(q: z.infer<typeof listAuditLogsQuerySchema>): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (q.actorUserId) where.actorUserId = q.actorUserId;
  if (q.action) where.action = { contains: q.action };
  if (q.targetEntityType) where.targetEntityType = q.targetEntityType;
  if (q.targetEntityId) where.targetEntityId = q.targetEntityId;
  if (q.from || q.to) {
    where.occurredAt = {
      ...(q.from ? { gte: q.from } : {}),
      ...(q.to ? { lte: q.to } : {}),
    };
  }
  return where;
}

async function streamCsv(res: Response, where: Record<string, unknown>): Promise<void> {
  // Pull pages of 500 until empty. No top-level limit — operators need
  // full exports. We bail if the response closes prematurely.
  const PAGE = 500;

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`
  );

  // Header row.
  res.write(
    'id,occurredAt,actorUserId,actorRole,action,targetEntityType,targetEntityId,ipAddress,userAgent\n'
  );

  let cursor: Date | null = null;
  // Safety cap of 100k rows to avoid runaway exports in case of a
  // missing index. Phase 19 volumes are well below this.
  let total = 0;
  const HARD_CAP = 100_000;

  while (total < HARD_CAP) {
    const rows = await prisma.auditLog.findMany({
      where: cursor ? { ...where, occurredAt: { lt: cursor } } : where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: PAGE,
      select: auditLogSelect,
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const v = rowToView(r as AuditLogRow);
      res.write(
        `${[
          csvEscape(v.id),
          csvEscape(v.occurredAt),
          csvEscape(v.actorUserId),
          csvEscape(v.actorRole),
          csvEscape(v.action),
          csvEscape(v.targetEntityType),
          csvEscape(v.targetEntityId),
          csvEscape(v.ipAddress),
          csvEscape(v.userAgent),
        ].join(',')}\n`
      );
    }

    total += rows.length;
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1] as AuditLogRow;
    cursor = last.occurredAt;
  }

  res.end();
}
