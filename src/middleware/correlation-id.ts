// src/middleware/correlation-id.ts
// Reads X-Correlation-Id from the request, generates one if missing,
// attaches it to the response and to req for downstream handlers.

import type { RequestHandler } from 'express';
import { v4 as uuidv4 } from 'uuid';

export const correlationIdMiddleware: RequestHandler = (req, res, next) => {
  const incoming = req.header('X-Correlation-Id');
  const id = incoming && incoming.trim().length > 0 ? incoming.trim() : uuidv4();
  res.setHeader('X-Correlation-Id', id);
  // Attach to the request for handlers + logger child bindings.
  (req as unknown as { correlationId: string }).correlationId = id;
  next();
};
