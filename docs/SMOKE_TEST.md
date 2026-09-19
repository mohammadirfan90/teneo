# Housing Platform — Smoke Test Walkthrough

> **Audience:** the demo video recorder and any reviewer walking through the live API.
>
> **Format:** ordered steps matching the [SPEC_REQUIREMENTS §Demo Smoke Test](./housing-platform/SPEC_REQUIREMENTS.md#demo-smoke-test-planned-video-walkthrough) plan. Every step lists the endpoint, the minimum body, and the **expected status code**.

Each step is also a one-click Postman request — import `postman/Housing-Platform.postman_collection.json` and the matching environment file, then walk down the folder tree in order.

> **Pre-flight:** `docker compose up -d`, `npm install`, `npm run prisma:migrate`, `npm run prisma:seed`, `npm run dev`. API at `http://localhost:3000/api/v1`.

---

## 0 — Authenticate as the three demo roles

```bash
# Admin
curl -sS -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@admin.local","password":"Demo123!@#"}'

# Owner (Olivia)
curl -sS -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner1@demo.local","password":"Demo123!@#"}'

# Tenant (Tara)
curl -sS -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"tenant1@demo.local","password":"Demo123!@#"}'
```

Expected: **200** with `{ success, message, data: { accessToken, refreshToken, ... } }`. Save each `accessToken` for the next steps.

Health sanity-check:

```bash
curl -sS http://localhost:3000/health/live    # → 200 "alive"
curl -sS http://localhost:3000/health/ready   # → 200 "ready" (DB + Redis both ok)
```

---

## 1 — Owner publishes a listing

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 1.1 | `GET /users/me` | — | **200** with `roles: ['OWNER']` |
| 1.2 | `POST /properties` | `{ "title":"...","city":"Berlin","countryCode":"DE","propertyType":"BUILDING", ... }` | **201**; capture `propertyId` |
| 1.3 | `POST /properties/{propertyId}/buildings` | `{ "name":"Main", "floors":6 }` | **201**; capture `buildingId` |
| 1.4 | `POST /buildings/{buildingId}/flats` | `{ "floor":3, "doorNumber":"3B" }` | **201**; capture `flatId` |
| 1.5 | `POST /flats/{flatId}/rooms` | `{ "label":"Room A", "baseRentMinor":75000, ... }` | **201**; capture `roomId` |
| 1.6 | `POST /rooms/{roomId}/publish` | — | **200**; `status: PUBLISHED` |

> The publish chain (1.2 → 1.6) requires `role=OWNER` + KYC `APPROVED`. The seed sets this.

---

## 2 — Tenant searches + applies

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 2.1 | `GET /search/rooms?city=Berlin&rent_min=50000&rent_max=150000&currency=EUR` | — | **200**; the published room shows up |
| 2.2 | `GET /search/rooms/suggest?q=Ber` | — | **200**; typeahead hits |
| 2.3 | `POST /search/saved` | `{ "name":"Berlin under 1000 EUR", "query": {...} }` | **201**; capture `savedSearchId` |
| 2.4 | `POST /applications` | `{ "roomId":"<from 1.5>", "message":"..." }` | **201**; capture `applicationId` |
| 2.5 | `GET /applications/me` | — | **200**; the new app appears with `status: SUBMITTED` |

---

## 3 — Owner proposes + confirms a viewing

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 3.1 | `POST /applications/{applicationId}/transition` | `{ "to":"SCREENING" }` | **200** |
| 3.2 | `POST /applications/{applicationId}/viewing` | `{ "proposedSlots":["2026-09-15T10:00:00Z", ...] }` | **201**; capture `viewingId` |
| 3.3 | `POST /viewings/{viewingId}/confirm` | `{ "confirmedSlot":"2026-09-15T10:00:00Z" }` | **200**; `status: CONFIRMED` |

---

## 4 — Owner approves → lease draft → both sign → move-in

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 4.1 | `POST /applications/{applicationId}/transition` | `{ "to":"APPROVED" }` | **200**; room flips to `RESERVED`; lease draft created |
| 4.2 | `GET /leases/me` (as owner) | — | **200**; lease shows `status: DRAFT` |
| 4.3 | `POST /leases/{leaseId}/sign` (owner) | `{ "acknowledge":"..." }` | **200**; `ownerSignedAt` populated |
| 4.4 | `POST /leases/{leaseId}/sign` (tenant) | `{ "acknowledge":"..." }` | **200**; `status: SIGNED` (both signatures) |
| 4.5 | `POST /leases/{leaseId}/confirm-move-in` (tenant) | `{ "moveInAt":"2026-09-15T10:00:00Z" }` | **200**; `status: ACTIVE` |

---

## 5 — Rent invoice generated + tenant pays via Stripe

The Phase 14 invoice generator runs on a cron OR on-demand via an OWNER endpoint. For the demo we trigger manually:

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 5.1 | (OWNER) trigger invoice generation for the active lease | `POST /leases/{leaseId}/generate-invoices` or wait for cron | **200/201**; capture `invoiceId` |
| 5.2 | `GET /invoices/me` (tenant) | — | **200**; `status: OPEN`, amount visible |
| 5.3 | `POST /payments/stripe/intent` (tenant) | `{ "invoiceId":"..." }` | **200**; `clientSecret` returned |
| 5.4 | Complete payment on Stripe-hosted UI (test card `4242 4242 4242 4242`) | — | — |
| 5.5 | Stripe sends webhook → `/stripe/webhook` | signature-gated | **200**; invoice flips to `PAID` |
| 5.6 | `GET /invoices/{invoiceId}` | — | **200**; `status: PAID`, `paidAt` populated |

---

## 6 — Utility meter reading → bill split

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 6.1 | `POST /properties/{propertyId}/meters` | `{ "utilityType":"ELECTRICITY", "label":"Main", "ratePerUnitMinor":150, ... }` | **201**; capture `meterId` |
| 6.2 | `POST /meters/{meterId}/readings` | `{ "readingDate":"2026-08-31", "readingValue":1245.5 }` | **201** |
| 6.3 | `POST /bills/generate` | `{ "leaseId":"...", "periodStart":"2026-08-01", "periodEnd":"2026-08-31" }` | **201** |
| 6.4 | `GET /bills/me` (tenant) | — | **200**; bill shares populated |

---

## 7 — Tenant raises a maintenance ticket

| Step | Method + path | Body (or note) | Expected |
|---|---|---|---|
| 7.1 | `POST /rooms/{roomId}/tickets` | `{ "title":"Leaking faucet", "category":"PLUMBING", "priority":"MEDIUM", ... }` | **201**; capture `ticketId` |
| 7.2 | `GET /tickets/queue` (owner) | — | **200**; the ticket appears |
| 7.3 | `PATCH /tickets/{ticketId}` (owner) | `{ "toStatus":"IN_PROGRESS", "comment":"Plumber scheduled" }` | **200** |
| 7.4 | `POST /tickets/{ticketId}/updates` | `{ "body":"Plumber replaced the cartridge", "statusAfter":"IN_PROGRESS" }` | **201** |
| 7.5 | `PATCH /tickets/{ticketId}` (owner) | `{ "toStatus":"RESOLVED" }` | **200** |
| 7.6 | `POST /tickets/{ticketId}/rate` (tenant) | `{ "rating":5, "comment":"..." }` | **200**; `rating` populated |

---

## 8 — Admin reviews audit log

```bash
curl -sS "http://localhost:3000/api/v1/admin/audit-logs?limit=20" \
  -H "Authorization: Bearer <adminToken>"
```

Expected: **200**; rows include `application.created`, `application.transitioned`, `lease.draft_created`, `lease.signed`, `payment.completed`, etc.

Export as CSV:

```bash
curl -sS "http://localhost:3000/api/v1/admin/audit-logs?format=csv&from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z" \
  -H "Authorization: Bearer <adminToken>" \
  -o audit-logs.csv
```

Expected: **200**; `Content-Type: text/csv`; rows match the JSON view.

---

## 9 — Admin takedown → cache invalidates

1. As tenant, `GET /search/rooms?city=Berlin` → see the published room. **200**.
2. As admin, `POST /admin/listings/{propertyId}/takedown` with `{ "reason":"..." }` → **200**; `status: TAKEN_DOWN`.
3. As tenant, repeat the search. **200** with an empty result list — the room is hidden.

---

## Negative-path spot checks

These should each return the indicated error code, not crash:

| Scenario | Endpoint | Expected |
|---|---|---|
| Wrong password | `POST /auth/login` with bad password | **401 UNAUTHENTICATED** |
| Cross-tenant lease access | `GET /leases/{otherTenantLeaseId}` | **403 FORBIDDEN** |
| Approve already-reserved room | `POST /applications/.../transition` to APPROVED twice | **409 STATE_MACHINE** |
| Publish without KYC | sign up a fresh user + try `POST /properties` | **403 KYC_REQUIRED** |
| Cursor on a UUID not belonging to caller | `GET /search/saved/{otherUserSavedSearchId}` | **404 NOT_FOUND** (existence-leak guard) |
| Stripe webhook with bad signature | `POST /stripe/webhook` | **400 INVALID_SIGNATURE** |

---

## Cleanup

```bash
docker compose down          # keep volumes
docker compose down -v       # wipe Postgres + Redis (full reset)
```
