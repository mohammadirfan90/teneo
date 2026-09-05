// src/modules/kyc/kyc.controller.ts
//
// Thin handlers per Phase 9 contract (spec §6.10 + §9.3).
// All input validated by zodValidate() at the route layer.

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import type {
  CreateSubmissionInput,
  DecisionInput,
  QueueQueryInput,
  RequestInfoInput,
} from './kyc.schemas';
import type { SubmissionIdParams } from './kyc.schemas';
import * as svc from './kyc.service';

// ──────────────────────────────────────────────────────────────────────
// user-side
// ──────────────────────────────────────────────────────────────────────

export const createSubmission: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as CreateSubmissionInput;
  const data = await svc.createSubmission(userId, body);
  res.status(201).json(ok(data, 'KYC submission created'));
};

export const listMySubmissions: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const data = await svc.listMySubmissions(userId);
  res.status(200).json(ok(data, 'KYC submissions retrieved'));
};

export const getSubmissionById: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as SubmissionIdParams;
  const isAdmin = req.user!.roles.includes('ADMIN');
  const data = await svc.getSubmissionById(id, userId, isAdmin);
  res.status(200).json(ok(data, 'KYC submission retrieved'));
};

// ──────────────────────────────────────────────────────────────────────
// admin-side
// ──────────────────────────────────────────────────────────────────────

export const listQueue: RequestHandler = async (req, res) => {
  const query = req.query as unknown as QueueQueryInput;
  const data = await svc.listQueue(query);
  res.status(200).json(ok(data, 'KYC queue retrieved'));
};

export const decideSubmission: RequestHandler = async (req, res) => {
  const adminId = req.user!.id;
  const { id } = req.params as unknown as SubmissionIdParams;
  const body = req.body as DecisionInput;
  const data = await svc.decideSubmission(id, adminId, body);
  res.status(200).json(ok(data, `KYC submission ${body.decision.toLowerCase()}`));
};

export const requestInfo: RequestHandler = async (req, res) => {
  const adminId = req.user!.id;
  const { id } = req.params as unknown as SubmissionIdParams;
  const body = req.body as RequestInfoInput;
  const data = await svc.requestInfo(id, adminId, body);
  res.status(200).json(ok(data, 'KYC info request noted'));
};
