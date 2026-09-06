// src/modules/search/search.routes.ts
//
// Routes for /search/* — mounted under /api/v1/search in server.ts.
//
// Authorization layers per 13 §13.2.4:
//   GET  /rooms          anonymous-OK (any caller); rate-limited per IP.
//   GET  /rooms/suggest  anonymous-OK; rate-limited per IP.
//   POST   /saved        requireAuth (any logged-in user).
//   GET    /saved        requireAuth (own only — filtered in service).
//   DELETE /saved/:id    requireAuth (own only — existence-leak guard
//                        in service: 404 if missing or not owner).
//
// Server.ts wires the public prefix under `anonymousRateLimiter` and
// the `/saved` prefix under `authenticatedRateLimiter` (which itself
// expects `req.user`).

import { type RequestHandler, Router } from 'express';

import { zodValidate } from '@/lib/validate';
import { requireAuth } from '@/middleware/auth';

import {
  createSavedSearchHandler,
  deleteSavedSearchHandler,
  listSavedSearchesHandler,
  searchRoomsHandler,
  suggestRoomsHandler,
} from './search.controller';
import { createSavedSearchSchema, savedSearchIdParamsSchema } from './search.schemas';

const asyncHandler = (fn: RequestHandler): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/** Public read router — anonymous-OK. Mounted under anon limiter. */
export function searchPublicRouter(): Router {
  const r = Router();
  r.get('/rooms', asyncHandler(searchRoomsHandler));
  r.get('/rooms/suggest', asyncHandler(suggestRoomsHandler));
  return r;
}

/** Saved-search router — requireAuth. Mounted under auth limiter. */
export function searchSavedRouter(): Router {
  const r = Router();
  r.post(
    '/saved',
    requireAuth,
    zodValidate({ body: createSavedSearchSchema }),
    asyncHandler(createSavedSearchHandler)
  );
  r.get('/saved', requireAuth, asyncHandler(listSavedSearchesHandler));
  r.delete(
    '/saved/:id',
    requireAuth,
    zodValidate({ params: savedSearchIdParamsSchema }),
    asyncHandler(deleteSavedSearchHandler)
  );
  return r;
}
