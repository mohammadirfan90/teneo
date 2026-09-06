// src/modules/properties/flats.routes.ts
//
// Routes for /flats/* — mounted under /api/v1/flats in server.ts.
//
// Spec §13.2.3:
//   POST /api/v1/buildings/:building_id/flats — but the URL is
//   buildings-prefixed, so this router only handles paths starting
//   with /flats/:id (none in v1 Phase 10). Kept as a placeholder so
//   future endpoints can be added without touching server.ts.
//
// The `POST /buildings/:building_id/flats` route is mounted on the
// buildings router (see buildings.routes.ts) so the URL hierarchy is
// preserved.

import { Router } from 'express';

export function flatsRouter(): Router {
  const r = Router();
  // No /flats/:id endpoints in Phase 10 — `POST /flats/:flat_id/rooms`
  // is on the rooms router because the URL is rooms-prefixed.
  return r;
}
