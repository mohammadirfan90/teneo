// scripts/verify-p2.ts
// Phase 2 acceptance verification script.
// Confirms the Prisma client (via @prisma/adapter-pg + pg) can reach Postgres.

import { disconnectPrisma, prisma } from '../src/lib/db';

async function main(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ v: string; db: string; u: string }>>`
    SELECT version() AS v, current_database() AS db, current_user AS u
  `;
  console.log('phase2 verify: OK', rows[0]);
}

main()
  .catch((err: unknown) => {
    console.error('phase2 verify: FAIL', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
