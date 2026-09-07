# Housing & Roommate Management Platform — Backend

> **B7A6 Backend Assignment** — a production-shaped REST API for a two-sided rental marketplace (verified owners publish listings; verified tenants discover, apply, lease, pay rent, and manage utilities).

The full design spec lives in [`housing-platform/`](./housing-platform/) (15 markdown files).
The implementation ledger — every endpoint, entity, rule, and state-machine we must honor — is [`housing-platform/SPEC_REQUIREMENTS.md`](./housing-platform/SPEC_REQUIREMENTS.md).

## Submission

| Field | Value |
|---|---|
| Project name | Housing & Roommate Management Platform — Backend |
| Repository | `github.com/<your-org>/B7A6` *(this repo)* |
| Live URL | _to be filled in after first Render deploy_ |
| API docs | [`docs/SMOKE_TEST.md`](./docs/SMOKE_TEST.md) + [`housing-platform/SPEC_REQUIREMENTS.md`](./housing-platform/SPEC_REQUIREMENTS.md) |
| Postman | [`postman/Housing-Platform.postman_collection.json`](./postman/Housing-Platform.postman_collection.json) (+ matching env file) |
| Demo credentials | See [§Demo Credentials](#demo-credentials-seeded) below — admin/owner/tenant emails + shared dev password |



## Quick Start

```bash
# 1. Start infrastructure (Postgres on host port 55432 + Redis on 6379)
docker compose up -d

# 2. Install deps + run migrations + seed demo data
npm install
cp .env.example .env       # then edit secrets if needed
npm run prisma:migrate
npm run prisma:seed

# 3. Run dev server
npm run dev
# API on http://localhost:3000/api/v1
```

## Demo Credentials (seeded)

| Role | Email | Password |
|---|---|---|
| Admin | admin@housing.local | Demo123!@# |
| Owner | alice.owner@housing.local | Demo123!@# |
| Owner | bob.owner@housing.local | Demo123!@# |
| Tenant | carol.tenant@housing.local | Demo123!@# |
| Tenant | dave.tenant@housing.local | Demo123!@# |

## Stack

- **Runtime:** Node.js (LTS) + TypeScript + Express.js
- **Database:** PostgreSQL 16 via Prisma ORM
- **Cache / Session store:** Redis 7
- **Validation:** Zod
- **Auth:** Email+password (argon2id) + Google OAuth, Bearer tokens (Redis) + DB-hashed refresh tokens
- **Payments:** Stripe (PaymentIntent + webhook, idempotent)
- **Linting/Formatting:** Biome
- **Deployment:** Render (web service + managed Postgres + Redis)

## Documentation

- [`housing-platform/`](./housing-platform/) — full design specification
- [`housing-platform/SPEC_REQUIREMENTS.md`](./housing-platform/SPEC_REQUIREMENTS.md) — implementation ledger (this is what we build from)
- [`docs/SMOKE_TEST.md`](./docs/SMOKE_TEST.md) — step-by-step demo walkthrough (matches the demo video plan)
- `phases/phase-*.md` — per-phase progress notes (gitignored, workflow state)
- `scripts/verify-*.ts` — live acceptance scripts (Phase 2)

## Postman

Import the two files in `postman/`:

1. `Housing-Platform.postman_environment.json` — environment with `baseUrl`, `accessToken` (auto-populated by `/auth/login`), and seeded emails for the demo creds.
2. `Housing-Platform.postman_collection.json` — 23 folders, 121 requests, role-aware Bearer auth + `Idempotency-Key` auto-injection via the collection-level pre-request script.

Walk the folders in order (Auth → Users → … → Admin) for the demo flow.

## Deployment

- `Dockerfile` — multi-stage (Node 22 build → non-root runtime). Container `HEALTHCHECK` hits `/health/ready`.
- `render.yaml` — Render Blueprint. One-click deploy from the Render dashboard. Healthcheck path is `/health/ready`.

To deploy:

1. Push this repo to GitHub.
2. In Render: **New → Blueprint** → pick the repo. Render reads `render.yaml` and provisions the web service.
3. Set the env-group secrets (`DATABASE_URL`, `REDIS_URL`, `STRIPE_*`, `GOOGLE_*`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`) in the Render dashboard.
4. First boot runs `npm run prisma:migrate` then `node dist/server.js`. `GET /health/ready` returns 200 once both Postgres and Redis are reachable.

## Security notes

- All access tokens are stored hashed in Redis (`access:{sha256(token)} → user_id`) with a 15-minute TTL.
- Refresh tokens are stored hashed in Postgres (`refresh_tokens.token_hash`) with rotation + family-revoke semantics; reuse triggers the whole family revocation (Phase 6 detail).
- Rate limits are per-IP for anonymous, per-user for authenticated, per-role tier (see SPEC §NFR-11).
- The Stripe webhook is signature-gated, **not** Bearer-auth-gated — its body parser uses `express.raw({ verify })` to preserve the raw bytes for HMAC verification.
- Idempotency-Key is required on every mutating endpoint that runs through `withIdempotency` middleware; replays within 24h return the original response without re-running side effects.
- 404 enumeration defense: `/properties/:id` negative-caches bogus ids for 60s (Phase 21).

## Project Layout

```
B7A6/
├── housing-platform/        # spec (read-only source of truth)
├── src/                     # TypeScript source
│   ├── modules/             # feature modules (auth, properties, payments, ...) — added phase 5+
│   ├── lib/                 # cross-cutting helpers (db, redis, logger, envelope, cache)
│   ├── middleware/          # rbac, validation, helmet, cors, rate-limit, idempotency
│   ├── generated/prisma/    # generated Prisma client (committed)
│   └── server.ts
├── prisma/
│   ├── schema.prisma
│   ├── migrations/          # added phase 3+
│   └── seed.ts
├── postman/                 # Phase 22 Postman collection + env
├── docs/                    # Phase 22 SMOKE_TEST walkthrough
├── scripts/                 # verify scripts + DB-shape unit tests
├── docker-compose.yml       # Postgres 16 + Redis 7 (local dev)
├── Dockerfile               # multi-stage, non-root, HEALTHCHECK /health/ready (Phase 22)
├── render.yaml              # Render Blueprint (Phase 22)
├── prisma.config.ts
└── README.md                # (this file)
```
