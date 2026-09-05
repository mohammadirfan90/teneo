// prisma.config.ts
// Prisma 7 configuration. Replaces bits that used to live in schema.prisma.
// - Where to find the schema
// - Where to put migrations
// - How to load the database URL from the environment
//
// Reference: https://www.prisma.io/blog/announcing-prisma-orm-7-0-0

import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
  // The DATABASE_URL must already be in process.env (dotenv loaded above).
  // For migrations in production, Render injects it directly.
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
