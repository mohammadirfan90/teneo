// src/lib/db.ts
// Prisma 7 client singleton, instantiated with the @prisma/adapter-pg driver.
// Rust engine is gone; the driver adapter is mandatory for SQL providers.
//
// Why a singleton:
//   - Hot-reload safe: tsx watch reuses the same client across reloads.
//   - One pool per process keeps connection counts predictable.
//
// Lifecycle:
//   - Disconnect on SIGTERM/SIGINT (server.ts already wires those).
//
// Deployment compatibility:
//   - Local docker-compose (no TLS, trust auth in dev)
//   - Neon: full TLS, requires sslmode=require
//   - Supabase direct + pooler (pgbouncer=true)
//   - Render managed Postgres
//   We auto-enable TLS when the DATABASE_URL host is anything other than
//   localhost / 127.0.0.1 / ::1. See src/lib/db-shape.ts for the helper.

import { PrismaPg } from '@prisma/adapter-pg';
import { config as loadDotenv } from 'dotenv';
import type pg from 'pg';

import { PrismaClient } from '@/generated/prisma/client';
import { shouldUseTls } from '@/lib/db-shape';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

// Make db.ts safely importable in any entrypoint (scripts, tests, REPL).
// env.ts already calls dotenv, but tsx --eval may not import env first;
// guard with a no-op when DATABASE_URL is already present.
if (!process.env.DATABASE_URL) {
  loadDotenv();
}

// Global-scope cache so tsx watch doesn't spawn N clients.
type GlobalWithPrisma = typeof globalThis & { __prisma?: PrismaClient };
const g = globalThis as GlobalWithPrisma;

function buildClient(): PrismaClient {
  // `env` may not have been imported yet on first call; ensure it is.
  const connectionString = (process.env.DATABASE_URL ?? env.DATABASE_URL) as string;
  const poolSize = process.env.DATABASE_POOL_SIZE
    ? Number.parseInt(process.env.DATABASE_POOL_SIZE, 10)
    : undefined;
  const tls = shouldUseTls(connectionString);
  const config: pg.PoolConfig = {
    connectionString,
    ...(poolSize && Number.isFinite(poolSize) && poolSize > 0 ? { max: poolSize } : {}),
    ...(tls ? { ssl: { rejectUnauthorized: false } } : {}),
  };
  const adapter = new PrismaPg(config);
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = g.__prisma ?? buildClient();

if (!g.__prisma) {
  g.__prisma = prisma;
  // Don't keep the process alive just for the Prisma connection.
  prisma.$connect().catch((err: unknown) => {
    logger.error({ err }, 'initial prisma connect failed');
  });
}

export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, 'prisma disconnect error');
  }
}
