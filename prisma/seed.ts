// prisma/seed.ts
//
// Phase 3 skeleton only — real seeding (admin user, demo owner/tenant pairs)
// lands in phase 9 once the auth + KYC modules are in place.
//
// This stub exists so `package.json`'s `prisma.seed` script has a target
// and so any contributor running `prisma migrate dev --seed` gets a clear
// "not yet implemented" message rather than a confusing import error.

import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { disconnectPrisma, prisma } from '../src/lib/db';

async function main(): Promise<void> {
  console.log('Phase 3 seed: no-op.');
  console.log('Real seeding lands in phase 9 (KYC + admin review queue).');
  console.log('Current row counts:');
  const counts = {
    users: await prisma.user.count(),
    userRoles: await prisma.userRole.count(),
    ownerProfiles: await prisma.ownerProfile.count(),
    tenantProfiles: await prisma.tenantProfile.count(),
    kycSubmissions: await prisma.kycSubmission.count(),
    auditLogs: await prisma.auditLog.count(),
    refreshTokens: await prisma.refreshToken.count(),
  };
  console.log(counts);
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
