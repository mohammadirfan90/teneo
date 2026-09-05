# Housing & Roommate Management Platform — Backend

> **B7A6 Backend Assignment** — a production-shaped REST API for a two-sided rental marketplace (verified owners publish listings; verified tenants discover, apply, lease, pay rent, and manage utilities).

The full design spec lives in [`housing-platform/`](./housing-platform/) (15 markdown files).
The implementation ledger — every endpoint, entity, rule, and state-machine we must honor — is [`housing-platform/SPEC_REQUIREMENTS.md`](./housing-platform/SPEC_REQUIREMENTS.md).

## Quick Start

```bash
# 1. Start infrastructure
docker compose -f app/docker-compose.yml up -d

# 2. Install deps + run migrations + seed demo data
cd app
npm install
cp .env.example .env       # then edit secrets
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
- [`app/README.md`](./app/README.md) — backend setup, scripts, environment
- [`app/postman/`](./app/postman/) — Postman collection for testing
- [`app/docs/SMOKE_TEST.md`](./app/docs/SMOKE_TEST.md) — end-to-end demo walkthrough

## Project Layout

```
B7A6/
├── housing-platform/        # spec (read-only source of truth)
├── app/                     # Node.js backend
│   ├── src/
│   │   ├── modules/         # feature modules (auth, properties, payments, ...)
│   │   ├── lib/             # cross-cutting helpers (db, redis, logger, envelope)
│   │   ├── middleware/      # rbac, validation, helmet, cors, rate-limit
│   │   └── server.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── migrations/
│   │   └── seed.ts
│   ├── postman/
│   ├── docs/
│   ├── docker-compose.yml
│   ├── Dockerfile
│   └── render.yaml
└── README.md                # (this file)
```
