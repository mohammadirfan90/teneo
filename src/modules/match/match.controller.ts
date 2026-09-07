// src/modules/match/match.controller.ts
//
// Phase 20: thin handlers for /api/v1/match/* (13 §13.2.4, 05 §5.1).
//
//   POST  /run                         runMatch
//   GET   /results                     listMyResults
//   POST  /results/:match_id/intro     openIntro
//   POST  /intro-requests/:id/accept   acceptIntro
//   POST  /intro-requests/:id/decline  declineIntro

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { ok } from '@/lib/envelope';

import type { IntroIdParams, MatchIdParams } from './match.schemas';
import { acceptIntro, declineIntro, listMyResults, openIntro, runMatch } from './match.service';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

// ──────────────────────────────────────────────────────────────────────
// POST /run
// ──────────────────────────────────────────────────────────────────────

export const runMatchHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const topN = parseLimit(req.body?.limit);
  const data = await runMatch(callerUserId, topN);
  res.status(200).json(ok(data, 'Match run completed'));
});

// ──────────────────────────────────────────────────────────────────────
// GET /results
// ──────────────────────────────────────────────────────────────────────

export const listMyResultsHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const data = await listMyResults(callerUserId);
  res.status(200).json(ok(data, 'Match results retrieved'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /results/:match_id/intro
// ──────────────────────────────────────────────────────────────────────

export const openIntroHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { match_id } = req.params as unknown as MatchIdParams;
  const data = await openIntro(callerUserId, match_id);
  res.status(201).json(ok(data, 'Intro request opened'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /intro-requests/:id/accept
// ──────────────────────────────────────────────────────────────────────

export const acceptIntroHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { id } = req.params as unknown as IntroIdParams;
  const data = await acceptIntro(callerUserId, id);
  res.status(200).json(ok(data, 'Intro accepted'));
});

// ──────────────────────────────────────────────────────────────────────
// POST /intro-requests/:id/decline
// ──────────────────────────────────────────────────────────────────────

export const declineIntroHandler: RequestHandler = asyncHandler(async (req, res) => {
  const callerUserId = req.user!.id;
  const { id } = req.params as unknown as IntroIdParams;
  const data = await declineIntro(callerUserId, id);
  res.status(200).json(ok(data, 'Intro declined'));
});

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function parseLimit(raw: number | undefined): number {
  if (!raw || Number.isNaN(raw)) return 20;
  return Math.max(1, Math.min(50, Math.floor(raw)));
}
