// src/lib/env.ts
// Strict, typed environment loader. Fails fast on boot if required vars are missing.

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),

  // Comma-separated origin allowlist; empty = same-origin only
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  ACCESS_TOKEN_SECRET: z.string().min(16, 'ACCESS_TOKEN_SECRET must be ≥16 chars'),
  REFRESH_TOKEN_SECRET: z.string().min(16, 'REFRESH_TOKEN_SECRET must be ≥16 chars'),

  // Optional in dev — features that need them return 503 if missing.
  STRIPE_SECRET_KEY: z.string().optional().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(''),
  STRIPE_PUBLISHABLE_KEY: z.string().optional().default(''),
  /// Pinned Stripe API version. Defaults to SDK 17.5.0's baked-in version
  /// when empty. Set explicitly in production to lock behavior.
  STRIPE_API_VERSION: z.string().optional().default(''),

  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),

  // Cloudinary object storage (room photos + KYC/lease documents).
  // Optional in dev — upload routes return 503 STORAGE_DISABLED when unset,
  // same contract as the Stripe keys above.
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  /// Root folder every asset is namespaced under, so one Cloudinary
  /// account can host dev/staging/prod without collisions.
  CLOUDINARY_FOLDER: z.string().optional().default('teneo'),

  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
});

const parsed = Env.safeParse(process.env);

if (!parsed.success) {
  // Fail loud, fail fast.
  console.error('\n[env] Invalid environment configuration:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  console.error('\nFix your .env (see .env.example) and retry.\n');
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof Env>;

export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
