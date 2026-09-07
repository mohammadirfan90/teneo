// src/lib/stripe.ts
//
// Lazy Stripe SDK singleton. Mirrors src/lib/redis.ts: hot-reload safe via
// globalThis cache; one client per process.
//
// Why lazy (not eager at module load):
//   - env.STRIPE_SECRET_KEY is OPTIONAL — Phase 15 ship without keys in
//     dev. /payments/stripe/intent returns 503 instead of crashing boot.
//   - Webhook signature verification still works without the SDK instance
//     because the SDK's `webhooks.constructEvent` is just an HMAC+JSON
//     helper. The intent-handler is the only thing that needs the live
//     client.
//
// API version pinning:
//   - Stripe-PACKAGE_VERSION is 17.7.0 (baked-in default '2025-02-24.acacia').
//   - env.STRIPE_API_VERSION overrides the default when set; required
//     for production so SDK upgrades don't silently change behavior.
//
// Deployment note:
//   - No special handling for `rediss://` URLs etc — the SDK is HTTP-only.
//   - Webhook tolerance is hardcoded to 300s (5 min) per spec §7.4.

import { config as loadDotenv } from 'dotenv';
import Stripe from 'stripe';

import { env } from '@/lib/env';

if (!process.env.STRIPE_SECRET_KEY) {
  // Best-effort; safe to call multiple times.
  loadDotenv();
}

type GlobalWithStripe = typeof globalThis & { __stripe?: Stripe | null };
const g = globalThis as GlobalWithStripe;

/// Pinned default mirrors the version baked into stripe@17.7.0. Override
/// at deploy time via STRIPE_API_VERSION if we need newer behavior.
const DEFAULT_API_VERSION = '2025-02-24.acacia';
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Returns the cached Stripe SDK instance, or null when STRIPE_SECRET_KEY
 * is unset (i.e. demo mode). The cache survives tsx watch reloads via
 * globalThis — same pattern as src/lib/redis.ts:54-58.
 */
export function getStripeClient(): Stripe | null {
  if (g.__stripe !== undefined) return g.__stripe;

  const secret = env.STRIPE_SECRET_KEY.trim();
  if (secret.length === 0) {
    g.__stripe = null;
    return null;
  }

  const apiVersion = env.STRIPE_API_VERSION.trim() || DEFAULT_API_VERSION;
  // The Stripe SDK types `apiVersion` as a string literal union for the
  // pinned default; custom dates require a cast.
  g.__stripe = new Stripe(secret, { apiVersion: apiVersion as Stripe.LatestApiVersion });
  return g.__stripe;
}

/**
 * Returns true iff a Stripe SDK instance is available. Convenience for
 * routes that want a fast-path 503 check before any DB lookup.
 */
export function isStripeEnabled(): boolean {
  return getStripeClient() !== null;
}

/**
 * Verifies a Stripe webhook signature. Wraps Stripe.webhooks.constructEvent
 * with a 5-minute tolerance and an explicit "stale" re-check for logging.
 *
 * Throws Error (NOT ApiError) — the webhook handler converts to 400.
 *
 * `rawBody` must be the unmodified request payload as a string. We don't
 * JSON.parse before this call: Stripe HMACs the exact bytes, and we
 * already capture them as utf-8 in src/server.ts:64-72 via the global
 * express.json({ verify }) parser.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): Stripe.Event {
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
  }
  if (!signature) {
    throw new Error('Missing stripe-signature header');
  }
  if (!rawBody || rawBody.length === 0) {
    throw new Error('Empty webhook body');
  }

  // Stripe.webhooks.constructEvent uses crypto.createHmac('sha256', secret)
  // with the parsed signature header. It accepts a string payload and
  // returns the verified Stripe.Event. The tolerance option bounds the
  // timestamp drift — events older than this are rejected.
  const event = Stripe.webhooks.constructEvent(rawBody, signature, secret, WEBHOOK_TOLERANCE_SECONDS);

  // Extra belt: re-check age in case Stripe changes its tolerance
  // semantics in a future API version.
  const ageSec = (Date.now() / 1000) - event.created;
  if (ageSec > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error(`Webhook event too old: age=${ageSec}s`);
  }

  return event;
}

/**
 * No-op for API symmetry with disconnectRedis. Stripe SDK has no
 * explicit close; the underlying HTTP keep-alive sockets are GC'd.
 */
export function disconnectStripe(): void {
  // intentionally empty
}
