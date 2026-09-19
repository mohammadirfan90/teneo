# Teneo

**A production-shaped REST API for a two-sided rental marketplace.** Verified owners publish properties; verified tenants discover them, apply, sign leases, pay rent, split utility bills, and raise maintenance tickets — with the money handling, state machines, and audit trail a real tenancy needs.

> *Teneo* — Latin, "I hold": the root of **tenant** and **tenure**, and the verb at the centre of every lease this API issues.

## Contents

- [Overview](#overview)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [API](#api)
- [Architecture](#architecture)
- [Data model](#data-model)
- [Testing and verification](#testing-and-verification)
- [Deployment](#deployment)
- [Security](#security)
- [Project structure](#project-structure)

## Overview

Teneo models the full lifecycle of a rental tenancy as a single backend service:

```
discover → apply → view → approve → lease → sign → invoice → pay → occupy → maintain → settle
```

Three roles share one API surface, separated by role-based access control:

| Role | Can do |
|---|---|
| **TENANT** | Search rooms, save searches, apply, request viewings, sign leases, pay invoices, split bills, raise tickets, find roommates |
| **OWNER** | Publish properties/buildings/flats/rooms, screen applications, issue and countersign leases, generate rent invoices, record meter readings, resolve tickets |
| **ADMIN** | Approve KYC, moderate listings, read the audit log, act on any resource |

The service is built around a few deliberate constraints: every mutating endpoint is idempotent, every state transition is a validated machine rather than a free-form status column, every money path is reconciled against Stripe, and every privileged action lands in an append-only audit log.

## Features

**Identity and access**
- Email + password registration with argon2id hashing, plus Google OAuth
- Bearer access tokens (Redis-backed, 15-minute TTL) and rotating refresh tokens with family-revoke on reuse detection
- KYC submission and admin review, gating who may list or lease

**Listings**
- Property → Building → Flat → Room hierarchy with per-room availability
- Room photo galleries with dense ordering and reordering
- Faceted room search, plus saved searches per tenant

**Tenancy**
- Applications with viewing-request scheduling
- Multi-tenant leases with counterparty signing, signature tracking, and amendments
- Rent invoice generation on a lease schedule

**Money**
- Stripe PaymentIntent flow with a signature-verified, replay-protected webhook
- Utility meters, meter readings, and automatic bill splitting across occupants

**Operations**
- Maintenance tickets with a lifecycle state machine and post-resolution rating
- Private document vault (KYC, leases) behind signed short-lived URLs
- Admin moderation and audit log
- Roommate matching on declared lifestyle preferences

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 22, TypeScript (strict) |
| Framework | Express |
| Database | PostgreSQL 16 via Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg` driver adapter) |
| Cache / token store | Redis 7 via ioredis |
| Validation | Zod, on every request body, query, and param |
| Auth | argon2id, Google OAuth (`google-auth-library`) |
| Payments | Stripe (PaymentIntent + webhook) |
| Object storage | Cloudinary (public CDN for photos, authenticated assets for documents) |
| Logging | Pino (structured JSON; `pino-pretty` in dev) |
| Tooling | Biome (lint + format), tsx (dev runner) |

## Getting started

### Prerequisites

- Node.js ≥ 22
- Docker, for local Postgres and Redis

### Setup

```bash
# 1. Clone and install
git clone https://github.com/mohammadirfan90/teneo.git
cd teneo
npm install

# 2. Start local infrastructure — Postgres on host port 55432, Redis on 6379
docker compose up -d

# 3. Configure
cp .env.example .env        # defaults work for local dev

# 4. Migrate and seed
npm run prisma:migrate
npm run prisma:seed

# 5. Run
npm run dev
```

The API is then on `http://localhost:3000/api/v1`, with `GET /health/ready` reporting Postgres and Redis reachability.

> Postgres is published on host port **55432**, not 5432, so it does not collide with a native Postgres install.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch-mode dev server (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` / `npm run format` | Biome lint / format |
| `npm run prisma:migrate` | Apply migrations (`migrate deploy`) |
| `npm run prisma:migrate:dev` | Create and apply a migration in dev |
| `npm run prisma:seed` | Seed demo users and listings |

### Demo accounts

Created by [`prisma/seed.ts`](./prisma/seed.ts). All share the password `Demo123!@#`.

| Role | Email |
|---|---|
| Admin | `demo@admin.local` |
| Owner | `owner1@demo.local`, `owner2@demo.local` |
| Tenant | `tenant1@demo.local`, `tenant2@demo.local` |

Note the admin domain is `admin.local`, not `demo.local`.

## Configuration

Environment is parsed and validated by Zod at boot ([`src/lib/env.ts`](./src/lib/env.ts)); the process refuses to start on an invalid config rather than failing at first use.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `PORT` | no | `3000` | Injected by the host in production |
| `LOG_LEVEL` | no | `info` | Pino level |
| `CORS_ORIGINS` | no | — | Comma-separated allowlist |
| `DATABASE_URL` | **yes** | — | TLS auto-enabled for any non-loopback host |
| `REDIS_URL` | **yes** | — | A `rediss://` URL enables TLS automatically |
| `ACCESS_TOKEN_SECRET` | **yes** | — | ≥ 16 chars; use 32 random bytes |
| `REFRESH_TOKEN_SECRET` | **yes** | — | ≥ 16 chars |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` | no | — | Payment routes degrade without them |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | no | — | OAuth endpoint returns 503 when unset |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | no | — | Upload routes return `503 STORAGE_DISABLED` when unset |
| `CLOUDINARY_FOLDER` | no | `teneo` | Namespaces assets so one account can host dev and prod |
| `APP_PUBLIC_URL` | no | `http://localhost:3000` | Used in outbound links |

Optional integrations degrade one feature rather than failing the whole service — a missing Cloudinary key costs you uploads, not the API.

## API

Base path: `/api/v1`

### Response envelope

Every response, success or failure, uses one shape:

```jsonc
// success
{ "success": true, "message": "Operation successful", "data": { } }

// failure
{ "success": false, "message": "Validation failed",
  "errors": [{ "field": "email", "code": "INVALID", "message": "..." }] }
```

Clients can rely on `errors` being a non-empty array whenever `success` is `false`.

### Authentication

```http
Authorization: Bearer <access_token>
```

Access tokens are looked up as `access:{sha256(token)} → user_id` in Redis. Refresh via `POST /auth/refresh`; refresh tokens rotate on every use, and replaying a consumed token revokes the entire token family.

### Idempotency

Mutating endpoints require an `Idempotency-Key` header. A replay within 24 hours returns the original response without re-running side effects, so a retried payment cannot double-charge.

### Rate limiting

Per-IP for anonymous traffic, per-user for authenticated traffic, tiered by role, backed by Redis so limits hold across instances. Exceeding a limit returns `429` with a `Retry-After` header in the standard envelope.

### Endpoint groups

| Prefix | Domain |
|---|---|
| `/auth` | Register, login, refresh, logout, Google OAuth |
| `/users`, `/profiles`, `/preferences` | Account, owner/tenant profiles, tenant preferences |
| `/kyc` | Identity submission and admin review |
| `/properties`, `/buildings`, `/flats`, `/rooms` | Listing hierarchy and room photos |
| `/search` | Room search and saved searches |
| `/applications`, `/viewings` | Applications and viewing requests |
| `/leases` | Lease issue, counterparty signing, amendments |
| `/invoices` | Rent invoice generation and retrieval |
| `/payments` | Stripe PaymentIntent and webhook |
| `/properties/:id/meters`, `/meters/:id/readings`, `/bills` | Utility metering and bill splitting |
| `/tickets`, `/rooms/:id/tickets` | Maintenance lifecycle and rating |
| `/documents` | Private document upload and signed URLs |
| `/match` | Roommate matching and intro requests |
| `/admin` | Moderation and audit log |

A runnable reference lives in [`postman/`](./postman/) — import the environment file first (it auto-populates `accessToken` on login), then the collection, and walk the folders in order. [`docs/SMOKE_TEST.md`](./docs/SMOKE_TEST.md) is the same path as a narrated walkthrough.

### File uploads

Both upload endpoints accept `multipart/form-data` with the file in a field named `file`:

| Endpoint | Who | Limits | Storage |
|---|---|---|---|
| `POST /rooms/:id/photos` | Owner (own room), Admin | 8 MB, JPEG/PNG/WebP, 20 per room | Cloudinary public CDN, URL returned inline |
| `POST /documents` | Any authenticated user | 15 MB, images and PDF | Cloudinary authenticated asset; fetch via `GET /documents/:id/url` |

Uploads are validated three times before anything is stored: multer caps size mid-stream, a MIME allowlist rejects the declared type, and a magic-byte check confirms the bytes match that type, so a renamed executable is refused. Buffers stream straight to Cloudinary; nothing is written to the container filesystem. Deleting a record deletes the remote asset with it.

### Health

| Endpoint | Meaning |
|---|---|
| `GET /health/live` | Process is up |
| `GET /health/ready` | Postgres and Redis reachable, each with a 1s budget — this is the deploy healthcheck |
| `GET /health/startup` | Startup probe |

## Architecture

Requests flow through a fixed pipeline:

```
helmet → cors → body parser → rate limit → auth (Bearer → Redis)
      → RBAC → Zod validation → idempotency → controller
      → service (business rules) → Prisma / Redis / Stripe
      → response envelope → error handler
```

Code is organised by **feature module**, not by technical layer. Each directory under `src/modules/` owns its routes, controller, service, and schemas, so a feature is one place to look rather than four parallel edits.

Cross-cutting concerns live in `src/lib/`:

- **`db.ts`** — Prisma singleton on the `pg` driver adapter, one pool per process, TLS auto-detected from the URL host
- **`redis.ts`** — ioredis singleton; fails fast in development, buffers across reconnects in production
- **`cache.ts`** — best-effort cache with tag-based invalidation and negative caching for 404s; every operation degrades to a database read when Redis is unavailable
- **`envelope.ts`** and **`errors.ts`** — the single response shape and the typed error hierarchy behind it

Both singletons are cached on `globalThis`, so watch-mode reloads do not leak connection pools.

## Data model

31 Prisma models across seven domains:

| Domain | Models |
|---|---|
| Identity | `User`, `UserRole`, `OwnerProfile`, `TenantProfile`, `PreferencesTenant`, `RefreshToken`, `KycSubmission` |
| Listings | `Property`, `Building`, `Flat`, `Room`, `RoomPhoto`, `SavedSearch` |
| Applications | `Application`, `ViewingRequest` |
| Leasing | `Lease`, `LeaseTenant`, `LeaseSignature`, `LeaseAmendment` |
| Money | `RentInvoice`, `Payment`, `PropertyMeter`, `MeterReading`, `UtilityBill`, `BillShare` |
| Operations | `MaintenanceTicket`, `MaintenanceUpdate`, `Document` |
| Platform | `AuditLog`, `MatchResult`, `IntroRequest` |

Schema in [`prisma/schema.prisma`](./prisma/schema.prisma); ordered migrations under [`prisma/migrations/`](./prisma/migrations/). The generated client is committed to `src/generated/prisma/`, since Prisma 7 no longer writes into `node_modules`.

One choice worth calling out: `citext` for case-insensitive email uniqueness, which keeps `LOWER()` out of every lookup.

## Testing and verification

`scripts/` holds executable acceptance checks rather than a unit-test suite:

- `verify-db-shape.ts` — asserts the live schema matches the design
- `verify-p14-calc.ts`, `verify-p16-splitter.ts` — money and bill-split arithmetic
- `verify-p15-state-machines.ts` — every lease, application, and ticket transition, including the illegal ones
- `smoke-*.sh`, `smoke-e2e.mjs` — end-to-end flows against a running server

Run them with `npx tsx scripts/<name>.ts` against a migrated, seeded database.

## Deployment

Deploys to [Render](https://render.com) from [`render.yaml`](./render.yaml) as a Docker web service plus a managed Key Value (Redis) instance. Postgres is external; the blueprint expects a [Neon](https://neon.tech) connection string.

1. Push to GitHub, then in Render choose **New → Blueprint** and select the repo.
2. Set the secrets marked `sync: false` in `render.yaml` (`DATABASE_URL`, token secrets, Stripe, Google, Cloudinary). `REDIS_URL` is wired automatically from the Key Value service.
3. Deploy. The healthcheck hits `/health/ready` and goes green once both Postgres and Redis answer.

**Neon.** Use the pooled endpoint (the `-pooler` host) with `?sslmode=require&pgbouncer=true&connection_limit=1` for `DATABASE_URL`. Migrations need the **direct**, non-pooled endpoint, because PgBouncer in transaction mode cannot hold the advisory locks Prisma takes:

```bash
DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy
```

**Redis.** The Key Value instance uses `maxmemoryPolicy: noeviction` deliberately. It stores live access tokens and idempotency keys, not just cache — under an LRU policy, memory pressure would silently evict sessions and log users out. Every key written carries a TTL, so the keyspace drains on its own.

The [`Dockerfile`](./Dockerfile) is multi-stage: a Node 22 stage compiles TypeScript, and the runtime stage runs as a non-root user with a `HEALTHCHECK` on `/health/ready`.

## Security

- **Passwords** — argon2id; never stored or logged in plaintext.
- **Access tokens** — stored hashed in Redis (`access:{sha256(token)}`), 15-minute TTL, revocable server-side.
- **Refresh tokens** — stored hashed in Postgres with rotation; reuse of a consumed token revokes the whole family.
- **Stripe webhook** — signature-gated rather than Bearer-gated, with `express.raw({ verify })` preserving the exact bytes for HMAC verification. Replays are rejected by a Redis guard.
- **Idempotency** — required on mutating endpoints, so a client retry cannot duplicate a charge or a lease.
- **Enumeration defense** — `/properties/:id` negative-caches unknown ids for 60 seconds, so probing costs an attacker the same as a cache hit.
- **Transport** — TLS is enabled automatically for any non-loopback database host; helmet sets security headers on every response.
- **Audit** — privileged and destructive actions append to `AuditLog`, which has no update or delete path.

## Project structure

```
.
├── src/
│   ├── modules/          # feature modules: routes + controller + service + schemas
│   ├── lib/              # db, redis, cache, env, logger, envelope, errors, stripe, cloudinary
│   ├── middleware/       # auth, rbac, ownership, validation, rate-limit, idempotency
│   ├── generated/prisma/ # generated Prisma client (committed)
│   └── server.ts         # bootstrap, middleware pipeline, route mounting
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── scripts/              # verification and smoke scripts
├── postman/              # collection + environment
├── docs/SMOKE_TEST.md    # narrated end-to-end walkthrough
├── docker-compose.yml    # local Postgres 16 + Redis 7
├── Dockerfile            # multi-stage, non-root
├── render.yaml           # Render blueprint
└── prisma.config.ts      # Prisma 7 config: schema path, migrations, seed
```
