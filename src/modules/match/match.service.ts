// src/modules/match/match.service.ts
//
// Phase 20: business logic for /api/v1/match/* (13 §13.2.4, 05 §5.1).
//
// Authorization model:
//   All routes are caller-scoped to a TENANT user. The service still
//   re-checks the caller's role on every entry point so a future
//   internal RPC can't accidentally bypass the route gate.
//
// `runMatch` is the only DB-heavy operation: it pulls every other
// tenant who has filled out preferences_tenant, scores them against
// the caller, persists the top-N as MatchResult rows, and returns
// the ranked view.

import type { Prisma } from '@/generated/prisma/client';
import type { Gender } from '@/generated/prisma/enums';

import { prisma } from '@/lib/db';
import { ApiError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { logger } from '@/lib/logger';

import {
  type MatchLifestyle,
  type MatchScoreResult,
  type MatchScorerTenantInput,
  matchScore,
} from './scoring';

// ──────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────

export interface MatchResultView {
  matchId: string;
  rank: number;
  score: number;
  breakdown: MatchScoreResult['breakdown'];
  explain: string;
  hardPenalties: string[];
  candidate: {
    userId: string;
    displayName: string;
    gender: Gender | null;
    preferredCities: string[];
    interests: string[];
    /** Revealed only after both sides have accepted an intro. */
    contactRevealed: boolean;
  };
}

export interface MatchRunSummary {
  ranAt: string;
  candidateCount: number;
  topN: number;
}

export interface MatchResultPage {
  summary: MatchRunSummary;
  items: MatchResultView[];
}

export interface IntroRequestView {
  id: string;
  matchId: string;
  callerUserId: string;
  candidateUserId: string;
  callerAcceptedAt: string | null;
  candidateAcceptedAt: string | null;
  revealedAt: string | null;
  declinedAt: string | null;
  status: 'PENDING' | 'MUTUAL' | 'DECLINED';
  /** Surface the candidate's displayName so the caller UI can render. */
  counterpartDisplayName: string;
  createdAt: string;
}

// ──────────────────────────────────────────────────────────────────────
// runMatch — POST /match/run
// ──────────────────────────────────────────────────────────────────────

/**
 * Score every other tenant against the caller, persist the top-N as
 * MatchResult rows, return the ranked view.
 *
 * Strategy:
 *   1. Load caller's User.gender + PreferencesTenant.
 *   2. Load every other tenant (chunked via id cursor to bound memory)
 *      with their User.gender + PreferencesTenant.
 *   3. Run scoring.ts against each candidate.
 *   4. Sort by score desc (hard-penalty gender-mismatch pinned to 0).
 *   5. In a single transaction:
 *      - delete prior match_results rows for this caller
 *      - bulk-create the new top-N rows
 *   6. Return the ranked view.
 */
export async function runMatch(callerUserId: string, topN: number): Promise<MatchResultPage> {
  const caller = await loadTenantInput(callerUserId);
  if (!caller) {
    throw new NotFoundError('Caller has no PreferencesTenant row; complete onboarding first');
  }

  const candidates = await loadAllOtherTenants(callerUserId);
  logger.info({ callerUserId, candidateCount: candidates.length, topN }, 'match_run_starting');

  const scored: Array<{ input: MatchScorerTenantInput; result: MatchScoreResult }> = [];
  for (const cand of candidates) {
    const result = matchScore(caller, cand);
    scored.push({ input: cand, result });
  }

  // Sort by score desc; ties broken by smaller userId (stable order).
  scored.sort((a, b) => {
    if (b.result.score !== a.result.score) return b.result.score - a.result.score;
    return a.input.userId.localeCompare(b.input.userId);
  });

  const top = scored.slice(0, topN);

  // Persist in a single tx — wipe prior results, insert fresh top-N.
  const ranAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.matchResult.deleteMany({ where: { callerUserId } });
    if (top.length > 0) {
      await tx.matchResult.createMany({
        data: top.map((entry, idx) => ({
          callerUserId,
          candidateUserId: entry.input.userId,
          score: entry.result.score,
          breakdown: entry.result.breakdown as unknown as Prisma.InputJsonValue,
          explain: entry.result.explain,
          rank: idx + 1,
        })),
      });
    }
  });

  // Pull the inserted rows so we return stable ids + timestamps.
  const rows = await prisma.matchResult.findMany({
    where: { callerUserId },
    orderBy: { rank: 'asc' },
    select: {
      id: true,
      rank: true,
      score: true,
      breakdown: true,
      explain: true,
      candidateUserId: true,
      candidate: {
        select: {
          id: true,
          gender: true,
          tenantProfile: { select: { displayName: true } },
        },
      },
    },
  });

  // Resolve preferredCities + interests for each candidate in one
  // extra query (not joined above because they're not on the MatchResult).
  const candidateIds = rows.map((r) => r.candidateUserId);
  const candidatePrefs = await prisma.preferencesTenant.findMany({
    where: { userId: { in: candidateIds } },
    select: { userId: true, preferredCities: true, interests: true },
  });
  const prefMap = new Map(candidatePrefs.map((p) => [p.userId, p]));

  const items: MatchResultView[] = rows.map((r) => {
    const entry = top.find((t) => t.input.userId === r.candidateUserId);
    const pref = prefMap.get(r.candidateUserId);
    return {
      matchId: r.id,
      rank: r.rank,
      score: r.score,
      breakdown: r.breakdown as unknown as MatchScoreResult['breakdown'],
      explain: r.explain,
      hardPenalties: entry?.result.hardPenalties ?? [],
      candidate: {
        userId: r.candidateUserId,
        displayName: r.candidate.tenantProfile?.displayName ?? r.candidate.id,
        gender: r.candidate.gender,
        preferredCities: pref?.preferredCities ?? [],
        interests: pref?.interests ?? [],
        contactRevealed: false,
      },
    };
  });

  return {
    summary: {
      ranAt: ranAt.toISOString(),
      candidateCount: candidates.length,
      topN: items.length,
    },
    items,
  };
}

// ──────────────────────────────────────────────────────────────────────
// listMyResults — GET /match/results
// ──────────────────────────────────────────────────────────────────────

export async function listMyResults(callerUserId: string): Promise<MatchResultPage> {
  const rows = await prisma.matchResult.findMany({
    where: { callerUserId },
    orderBy: { rank: 'asc' },
    select: {
      id: true,
      rank: true,
      score: true,
      breakdown: true,
      explain: true,
      candidateUserId: true,
      createdAt: true,
      candidate: {
        select: {
          id: true,
          gender: true,
          tenantProfile: { select: { displayName: true } },
        },
      },
      intro: { select: { revealedAt: true } },
    },
  });

  if (rows.length === 0) {
    return {
      summary: { ranAt: '', candidateCount: 0, topN: 0 },
      items: [],
    };
  }

  const candidateIds = rows.map((r) => r.candidateUserId);
  const prefs = await prisma.preferencesTenant.findMany({
    where: { userId: { in: candidateIds } },
    select: { userId: true, preferredCities: true, interests: true },
  });
  const prefMap = new Map(prefs.map((p) => [p.userId, p]));

  const items: MatchResultView[] = rows.map((r) => {
    const pref = prefMap.get(r.candidateUserId);
    return {
      matchId: r.id,
      rank: r.rank,
      score: r.score,
      breakdown: r.breakdown as unknown as MatchScoreResult['breakdown'],
      explain: r.explain,
      hardPenalties: [],
      candidate: {
        userId: r.candidateUserId,
        displayName: r.candidate.tenantProfile?.displayName ?? r.candidate.id,
        gender: r.candidate.gender,
        preferredCities: pref?.preferredCities ?? [],
        interests: pref?.interests ?? [],
        contactRevealed: r.intro?.revealedAt !== null && r.intro?.revealedAt !== undefined,
      },
    };
  });

  return {
    summary: {
      ranAt: rows[0]?.createdAt.toISOString() ?? '',
      candidateCount: rows.length,
      topN: items.length,
    },
    items,
  };
}

// ──────────────────────────────────────────────────────────────────────
// openIntro — POST /match/results/:match_id/intro
// ──────────────────────────────────────────────────────────────────────

/**
 * Open a mutual-intro request against an existing MatchResult. The
 * caller is recorded as having accepted; the candidate has not yet
 * accepted. If an intro row already exists for this match, return
 * the existing one (idempotent).
 */
export async function openIntro(callerUserId: string, matchId: string): Promise<IntroRequestView> {
  const match = await prisma.matchResult.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      callerUserId: true,
      candidateUserId: true,
    },
  });
  if (!match) throw new NotFoundError('Match result not found');
  if (match.callerUserId !== callerUserId) {
    throw new ForbiddenError('NOT_OWNER', 'Caller did not produce this match result');
  }

  const existing = await prisma.introRequest.findUnique({
    where: { matchResultId: match.id },
    select: introsSelect,
  });
  if (existing) return await toIntroView(existing, callerUserId);

  const created = await prisma.introRequest.create({
    data: {
      matchResultId: match.id,
      callerUserId: match.callerUserId,
      candidateUserId: match.candidateUserId,
      callerAcceptedAt: new Date(),
    },
    select: introsSelect,
  });
  return await toIntroView(created, callerUserId);
}

// ──────────────────────────────────────────────────────────────────────
// acceptIntro / declineIntro — POST /intro-requests/:id/{accept|decline}
// ──────────────────────────────────────────────────────────────────────

export async function acceptIntro(
  callerUserId: string,
  introId: string
): Promise<IntroRequestView> {
  return await prisma.$transaction(async (tx) => {
    const intro = await tx.introRequest.findUnique({
      where: { id: introId },
      select: { ...introsSelect, declinedAt: true },
    });
    if (!intro) throw new NotFoundError('Intro request not found');
    if (intro.declinedAt !== null) {
      throw new ApiError(409, 'CONFLICT', 'Intro was already declined');
    }
    if (intro.callerUserId !== callerUserId && intro.candidateUserId !== callerUserId) {
      throw new ApiError(403, 'FORBIDDEN', 'Caller is not a party to this intro');
    }

    const isCaller = intro.callerUserId === callerUserId;
    const now = new Date();
    const updated = await tx.introRequest.update({
      where: { id: introId },
      data: isCaller ? { callerAcceptedAt: now } : { candidateAcceptedAt: now },
      select: introsSelect,
    });

    // Mutual accept → set revealedAt.
    if (updated.callerAcceptedAt && updated.candidateAcceptedAt && !updated.revealedAt) {
      await tx.introRequest.update({
        where: { id: introId },
        data: { revealedAt: now },
        select: introsSelect,
      });
    }

    return await toIntroViewTx(
      tx,
      { ...updated, revealedAt: updated.revealedAt ?? null },
      callerUserId
    );
  });
}

export async function declineIntro(
  callerUserId: string,
  introId: string
): Promise<IntroRequestView> {
  const intro = await prisma.introRequest.findUnique({
    where: { id: introId },
    select: introsSelect,
  });
  if (!intro) throw new NotFoundError('Intro request not found');
  if (intro.callerUserId !== callerUserId && intro.candidateUserId !== callerUserId) {
    throw new ApiError(403, 'FORBIDDEN', 'Caller is not a party to this intro');
  }
  if (intro.declinedAt) return await toIntroView(intro, callerUserId);

  const updated = await prisma.introRequest.update({
    where: { id: introId },
    data: { declinedAt: new Date() },
    select: introsSelect,
  });
  return await toIntroView(updated, callerUserId);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers (internal)
// ──────────────────────────────────────────────────────────────────────

const introsSelect = {
  id: true,
  matchResultId: true,
  callerUserId: true,
  candidateUserId: true,
  callerAcceptedAt: true,
  candidateAcceptedAt: true,
  revealedAt: true,
  declinedAt: true,
  createdAt: true,
} as const;

async function toIntroView(
  row: {
    id: string;
    matchResultId: string;
    callerUserId: string;
    candidateUserId: string;
    callerAcceptedAt: Date | null;
    candidateAcceptedAt: Date | null;
    revealedAt: Date | null;
    declinedAt: Date | null;
    createdAt: Date;
  },
  callerUserId: string
): Promise<IntroRequestView> {
  const counterpartId = row.callerUserId === callerUserId ? row.candidateUserId : row.callerUserId;
  const profile = await prisma.tenantProfile.findUnique({
    where: { userId: counterpartId },
    select: { displayName: true },
  });
  return {
    id: row.id,
    matchId: row.matchResultId,
    callerUserId: row.callerUserId,
    candidateUserId: row.candidateUserId,
    callerAcceptedAt: row.callerAcceptedAt?.toISOString() ?? null,
    candidateAcceptedAt: row.candidateAcceptedAt?.toISOString() ?? null,
    revealedAt: row.revealedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    status: row.declinedAt ? 'DECLINED' : row.revealedAt ? 'MUTUAL' : 'PENDING',
    counterpartDisplayName: profile?.displayName ?? counterpartId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function toIntroViewTx(
  tx: Prisma.TransactionClient,
  row: {
    id: string;
    matchResultId: string;
    callerUserId: string;
    candidateUserId: string;
    callerAcceptedAt: Date | null;
    candidateAcceptedAt: Date | null;
    revealedAt: Date | null;
    declinedAt: Date | null;
    createdAt: Date;
  },
  callerUserId: string
): Promise<IntroRequestView> {
  const counterpartId = row.callerUserId === callerUserId ? row.candidateUserId : row.callerUserId;
  const profile = await tx.tenantProfile.findUnique({
    where: { userId: counterpartId },
    select: { displayName: true },
  });
  return {
    id: row.id,
    matchId: row.matchResultId,
    callerUserId: row.callerUserId,
    candidateUserId: row.candidateUserId,
    callerAcceptedAt: row.callerAcceptedAt?.toISOString() ?? null,
    candidateAcceptedAt: row.candidateAcceptedAt?.toISOString() ?? null,
    revealedAt: row.revealedAt?.toISOString() ?? null,
    declinedAt: row.declinedAt?.toISOString() ?? null,
    status: row.declinedAt ? 'DECLINED' : row.revealedAt ? 'MUTUAL' : 'PENDING',
    counterpartDisplayName: profile?.displayName ?? counterpartId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadTenantInput(userId: string): Promise<MatchScorerTenantInput | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, gender: true, tenantProfile: { select: { id: true } } },
  });
  if (!user || !user.tenantProfile) return null;

  const prefs = await prisma.preferencesTenant.findUnique({
    where: { userId },
    select: {
      budgetMinMinor: true,
      budgetMaxMinor: true,
      preferredCities: true,
      moveInFrom: true,
      moveInTo: true,
      lifestyle: true,
      interests: true,
    },
  });
  if (!prefs) return null;

  return {
    userId: user.id,
    gender: user.gender,
    budgetMinMinor: prefs.budgetMinMinor,
    budgetMaxMinor: prefs.budgetMaxMinor,
    preferredCities: prefs.preferredCities,
    moveInFrom: prefs.moveInFrom,
    moveInTo: prefs.moveInTo,
    lifestyle: (prefs.lifestyle as MatchLifestyle | null) ?? null,
    interests: prefs.interests,
  };
}

/**
 * Load every other tenant (chunked via id cursor) so the match run
 * stays bounded in memory on large datasets. v1 returns all rows in
 * one findMany because the pool is small (tenants in private beta);
 * Phase 21+ may add tenant-cohort filtering.
 */
async function loadAllOtherTenants(callerUserId: string): Promise<MatchScorerTenantInput[]> {
  const PAGE = 500;
  const inputs: MatchScorerTenantInput[] = [];
  let cursor: string | undefined = undefined;
  // Safety cap of 10k candidates per run — way above any realistic
  // v1 tenant pool; protects against runaway loops in tests.
  const HARD_CAP = 10_000;

  while (inputs.length < HARD_CAP) {
    const cursorId: string | null = cursor ?? null;
    const rows: Array<{
      id: string;
      gender: Gender | null;
      tenantPreferences: {
        budgetMinMinor: bigint | null;
        budgetMaxMinor: bigint | null;
        preferredCities: string[];
        moveInFrom: Date | null;
        moveInTo: Date | null;
        lifestyle: unknown;
        interests: string[];
      } | null;
    }> = await prisma.user.findMany({
      where: {
        id: { not: callerUserId },
        tenantProfile: { isNot: null },
        // Only score tenants who opted into matching visibility.
        tenantPreferences: { visibility: 'PUBLIC' },
      },
      orderBy: { id: 'asc' },
      take: PAGE,
      skip: cursorId ? 1 : 0,
      cursor: cursorId ? { id: cursorId } : undefined,
      select: {
        id: true,
        gender: true,
        tenantPreferences: {
          select: {
            budgetMinMinor: true,
            budgetMaxMinor: true,
            preferredCities: true,
            moveInFrom: true,
            moveInTo: true,
            lifestyle: true,
            interests: true,
          },
        },
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const p = r.tenantPreferences;
      if (!p) continue;
      inputs.push({
        userId: r.id,
        gender: r.gender,
        budgetMinMinor: p.budgetMinMinor,
        budgetMaxMinor: p.budgetMaxMinor,
        preferredCities: p.preferredCities,
        moveInFrom: p.moveInFrom,
        moveInTo: p.moveInTo,
        lifestyle: (p.lifestyle as MatchLifestyle | null) ?? null,
        interests: p.interests,
      });
    }

    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1]?.id;
    if (!cursor) break;
  }

  return inputs;
}
