// src/modules/search/search.controller.ts
//
// Thin handlers per 13 §13.2.4 contract.

import type { RequestHandler } from 'express';

import { ok } from '@/lib/envelope';

import type {
  CreateSavedSearchInput,
  ListSavedSearchesQuery,
  SavedSearchIdParams,
  SearchRoomsQuery,
  SuggestQuery,
} from './search.schemas';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  searchRooms,
  suggestRooms,
} from './search.service';

// ──────────────────────────────────────────────────────────────────────
// Public read endpoints (anonymous-OK; rate-limited by the router)
// ──────────────────────────────────────────────────────────────────────

/**
 * Inline parse (Express 5's req.query getter rebuilds the object on
 * every access, defeating middleware-time mutations of coerced
 * numbers/dates). Same pattern as properties.controller.ts.
 */
export const searchRoomsHandler: RequestHandler = async (req, res) => {
  const { searchRoomsQuerySchema } = await import('./search.schemas');
  const query: SearchRoomsQuery = searchRoomsQuerySchema.parse(req.query);
  const data = await searchRooms(query);
  res.status(200).json(ok(data, 'Rooms retrieved'));
};

export const suggestRoomsHandler: RequestHandler = async (req, res) => {
  const { suggestQuerySchema } = await import('./search.schemas');
  const query: SuggestQuery = suggestQuerySchema.parse(req.query);
  const data = await suggestRooms(query);
  res.status(200).json(ok(data, 'Suggestions retrieved'));
};

// ──────────────────────────────────────────────────────────────────────
// Saved searches — requireAuth (router enforces it)
// ──────────────────────────────────────────────────────────────────────

export const createSavedSearchHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const body = req.body as CreateSavedSearchInput;
  const data = await createSavedSearch(userId, body);
  res.status(201).json(ok(data, 'Saved search created'));
};

export const listSavedSearchesHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { listSavedSearchesQuerySchema } = await import('./search.schemas');
  const query: ListSavedSearchesQuery = listSavedSearchesQuerySchema.parse(req.query);
  const data = await listSavedSearches(userId, query);
  res.status(200).json(ok(data, 'Saved searches retrieved'));
};

export const deleteSavedSearchHandler: RequestHandler = async (req, res) => {
  const userId = req.user!.id;
  const { id } = req.params as unknown as SavedSearchIdParams;
  const data = await deleteSavedSearch(userId, id);
  res.status(200).json(ok(data, 'Saved search deleted'));
};
