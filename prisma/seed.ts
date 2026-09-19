// prisma/seed.ts
//
// Phase 9 seed per SPEC_REQUIREMENTS §"Seed Data Required for Demo":
//   - 1 admin user   (demo@admin       / Demo123!@#)
//   - 2 owner users  (owner1@demo / Demo123!@#, owner2@demo / Demo123!@#)
//   - 2 tenant users (tenant1@demo / Demo123!@#, tenant2@demo / Demo123!@#)
// All owners + tenants have KYC_APPROVED.
//
// Idempotent: re-running upserts without producing duplicates. Admin is
// upserted separately so its role is always present.

import { config as loadDotenv } from 'dotenv';
loadDotenv();

import crypto from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';

import { PrismaClient } from '../src/generated/prisma/client';
import { disconnectPrisma } from '../src/lib/db';

interface DemoUser {
  email: string;
  password: string;
  role: 'ADMIN' | 'OWNER' | 'TENANT';
  displayName: string;
}

const DEMO_USERS: DemoUser[] = [
  { email: 'demo@admin.local', password: 'Demo123!@#', role: 'ADMIN', displayName: 'Demo Admin' },
  {
    email: 'owner1@demo.local',
    password: 'Demo123!@#',
    role: 'OWNER',
    displayName: 'Olivia Owner',
  },
  { email: 'owner2@demo.local', password: 'Demo123!@#', role: 'OWNER', displayName: 'Omar Owner' },
  {
    email: 'tenant1@demo.local',
    password: 'Demo123!@#',
    role: 'TENANT',
    displayName: 'Tara Tenant',
  },
  {
    email: 'tenant2@demo.local',
    password: 'Demo123!@#',
    role: 'TENANT',
    displayName: 'Theo Tenant',
  },
];

function buildPrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

async function upsertDemoUser(prisma: PrismaClient, u: DemoUser): Promise<string> {
  const existing = await prisma.user.findFirst({
    where: { email: u.email },
    select: { id: true },
  });
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const passwordHash = await argon2.hash(u.password);

  await prisma.user.create({
    data: {
      id,
      email: u.email,
      passwordHash,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  return id;
}

async function ensureRole(
  prisma: PrismaClient,
  userId: string,
  role: 'ADMIN' | 'OWNER' | 'TENANT'
): Promise<void> {
  await prisma.userRole.upsert({
    where: { user_roles_user_role_uniq: { userId, role } },
    create: { userId, role },
    update: {},
  });
}

async function ensureOwnerKyc(
  prisma: PrismaClient,
  userId: string,
  displayName: string
): Promise<void> {
  const now = new Date();
  await prisma.ownerProfile.upsert({
    where: { userId },
    create: {
      userId,
      displayName,
      kycStatus: 'APPROVED',
      kycBadgeGrantedAt: now,
    },
    update: {
      kycStatus: 'APPROVED',
      kycBadgeGrantedAt: now,
    },
  });
}

async function ensureTenantKyc(
  prisma: PrismaClient,
  userId: string,
  displayName: string
): Promise<void> {
  const now = new Date();
  await prisma.tenantProfile.upsert({
    where: { userId },
    create: {
      userId,
      displayName,
      kycStatus: 'APPROVED',
      kycBadgeGrantedAt: now,
    },
    update: {
      kycStatus: 'APPROVED',
      kycBadgeGrantedAt: now,
    },
  });
}

async function main(): Promise<void> {
  const prisma = buildPrisma();

  console.log('Seeding demo data…');

  for (const u of DEMO_USERS) {
    const id = await upsertDemoUser(prisma, u);
    await ensureRole(prisma, id, u.role);
    if (u.role === 'OWNER') await ensureOwnerKyc(prisma, id, u.displayName);
    if (u.role === 'TENANT') await ensureTenantKyc(prisma, id, u.displayName);
    console.log(`  ✓ ${u.email} (${u.role}, id=${id})`);
  }

  console.log('Done.');
  // Print the admin row verbatim rather than a hand-typed string — a
  // truncated address here is the first thing anyone copies and the
  // last thing anyone re-checks.
  const admin = DEMO_USERS.find((u) => u.role === 'ADMIN');
  if (admin) console.log(`Login with: ${admin.email} / ${admin.password}`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
