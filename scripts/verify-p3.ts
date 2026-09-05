// scripts/verify-p3.ts
// Phase 3 acceptance verification.
// Round-trips every entity added in phase 3, then asserts the partial
// unique indexes and the audit append-only trigger behave as documented.

import { config as loadDotenv } from 'dotenv';
loadDotenv();

import { Prisma } from '../src/generated/prisma/client';
import { disconnectPrisma, prisma } from '../src/lib/db';

interface Counts {
  users: number;
  userRoles: number;
  ownerProfiles: number;
  tenantProfiles: number;
  kycSubmissions: number;
  auditLogs: number;
  refreshTokens: number;
}

async function counts(): Promise<Counts> {
  return {
    users: await prisma.user.count(),
    userRoles: await prisma.userRole.count(),
    ownerProfiles: await prisma.ownerProfile.count(),
    tenantProfiles: await prisma.tenantProfile.count(),
    kycSubmissions: await prisma.kycSubmission.count(),
    auditLogs: await prisma.auditLog.count(),
    refreshTokens: await prisma.refreshToken.count(),
  };
}

async function main(): Promise<void> {
  // Snapshot before so the script is idempotent across re-runs.
  const before = await counts();

  // 1) Create a user with one OWNER + one TENANT role.
  const user = await prisma.user.create({
    data: {
      email: 'verify-p3@example.test',
      passwordHash: 'placeholder',
      status: 'ACTIVE',
      roles: {
        create: [{ role: 'OWNER' }, { role: 'TENANT' }],
      },
    },
    include: { roles: true },
  });
  if (user.roles.length !== 2) {
    throw new Error(`Expected 2 roles, got ${user.roles.length}`);
  }

  // 2) Create both profiles (1:1).
  const [owner, tenant] = await Promise.all([
    prisma.ownerProfile.create({
      data: {
        userId: user.id,
        displayName: 'Verify Owner',
        kycStatus: 'NONE',
      },
    }),
    prisma.tenantProfile.create({
      data: {
        userId: user.id,
        displayName: 'Verify Tenant',
        kycStatus: 'NONE',
      },
    }),
  ]);

  // 3) KYC submission — partial-unique test: a second PENDING for the same
  //    (user, role) must violate the constraint.
  await prisma.kycSubmission.create({
    data: {
      userId: user.id,
      role: 'OWNER',
      status: 'PENDING',
      documentObjectKeys: ['kyc/front.jpg'],
    },
  });
  let partialUniqueBlocked = false;
  try {
    await prisma.kycSubmission.create({
      data: {
        userId: user.id,
        role: 'OWNER',
        status: 'PENDING',
        documentObjectKeys: ['kyc/front-dup.jpg'],
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      partialUniqueBlocked = true;
    } else {
      throw e;
    }
  }
  if (!partialUniqueBlocked) {
    throw new Error(
      'Expected kyc_submissions_active_uniq partial unique to block a second PENDING submission'
    );
  }

  // 4) Refresh token — PK is the sha256(raw) id, so we just need a UUID-shaped value.
  await prisma.refreshToken.create({
    data: {
      id: '11111111-1111-1111-1111-111111111111',
      userId: user.id,
      familyId: '22222222-2222-2222-2222-222222222222',
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
    },
  });

  // 5) Audit log — append-only.
  const log = await prisma.auditLog.create({
    data: {
      action: 'phase3.verify',
      actorUserId: user.id,
      actorRole: 'SYSTEM',
      targetEntityType: 'user',
      targetEntityId: user.id,
      after: { ok: true },
    },
  });
  let appendOnlyBlocked = false;
  try {
    await prisma.$executeRaw`UPDATE audit_logs SET action='hacked' WHERE id = ${log.id}::uuid`;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      appendOnlyBlocked = true;
    } else {
      throw e;
    }
  }
  if (!appendOnlyBlocked) {
    throw new Error('Expected audit_logs append-only trigger to block UPDATE');
  }

  // 6) Snapshot after and clean up.
  const after = await counts();
  const created = {
    users: after.users - before.users,
    userRoles: after.userRoles - before.userRoles,
    ownerProfiles: after.ownerProfiles - before.ownerProfiles,
    tenantProfiles: after.tenantProfiles - before.tenantProfiles,
    kycSubmissions: after.kycSubmissions - before.kycSubmissions,
    auditLogs: after.auditLogs - before.auditLogs,
    refreshTokens: after.refreshTokens - before.refreshTokens,
  };
  console.log('phase3 verify: OK', {
    user_id: user.id,
    owner_profile_id: owner.id,
    tenant_profile_id: tenant.id,
    created,
    partial_unique_active_block: partialUniqueBlocked,
    audit_append_only_block: appendOnlyBlocked,
  });

  // Clean up the row we created so reruns stay idempotent. The audit row
  // is wiped under the trigger's opt-in (test fixtures only — production
  // never deletes audit rows).
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL audit.allow_mutation = 'on'`),
    prisma.auditLog.deleteMany({ where: { actorUserId: user.id } }),
  ]);
  await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  await prisma.kycSubmission.deleteMany({ where: { userId: user.id } });
  await prisma.ownerProfile.deleteMany({ where: { userId: user.id } });
  await prisma.tenantProfile.deleteMany({ where: { userId: user.id } });
  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
}

main()
  .catch((err: unknown) => {
    console.error('phase3 verify: FAIL', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
