// src/middleware/not-found.ts
// Catch-all 404 handler. Must be mounted AFTER all routes.

import type { RequestHandler } from 'express';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    errors: [
      {
        field: 'path',
        code: 'NOT_FOUND',
        message: `No route matches ${req.method} ${req.originalUrl}`,
      },
    ],
  });
};
