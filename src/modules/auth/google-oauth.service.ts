// src/modules/auth/google-oauth.service.ts
//
// Google "Sign in with Google" — JS SDK variant.
//
// Flow:
//   1. Client loads Google Identity Services (GIS) JS SDK.
//   2. Client calls `google.accounts.id.initialize` + `prompt`.
//   3. GIS returns an idToken (a JWT signed by accounts.google.com).
//   4. Client POSTs `{ idToken }` to /api/v1/auth/oauth/google/callback.
//   5. This module verifies the JWT against Google's JWKS using the
//      configured `GOOGLE_CLIENT_ID` as audience.
//
// We do NOT implement a redirect-callback flow (no state cookie, no
// /authorize redirect). The JS-SDK flow is the recommended v1 path
// for SPAs and is fully CSRF-safe because the audience is bound to
// our client id.

import { type LoginTicket, OAuth2Client } from 'google-auth-library';

import { env } from '@/lib/env';
import { ApiError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/** Canonical Google profile fields, normalized. */
export interface GoogleProfile {
  providerUserId: string; // `sub` claim
  email: string;
  emailVerified: boolean; // `email_verified` claim
  name?: string;
  picture?: string;
}

let cachedClient: OAuth2Client | null = null;

/** True when the server has a GOOGLE_CLIENT_ID configured. */
export function isGoogleConfigured(): boolean {
  return env.GOOGLE_CLIENT_ID.length > 0;
}

/**
 * Lazily build the OAuth2 client. Throws 503 if GOOGLE_CLIENT_ID is
 * missing so the endpoint can short-circuit with a useful message
 * instead of a less-actionable "Invalid Google ID token".
 */
function getClient(): OAuth2Client {
  if (!isGoogleConfigured()) {
    throw new ApiError(
      503,
      'SERVICE_UNAVAILABLE',
      'Google OAuth is not configured on this server (GOOGLE_CLIENT_ID is unset)'
    );
  }
  if (!cachedClient) {
    cachedClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);
  }
  return cachedClient;
}

/**
 * Verify a Google idToken and return the canonical profile.
 *
 * Throws:
 *   - 503 SERVICE_UNAVAILABLE if GOOGLE_CLIENT_ID env is unset.
 *   - 401 UNAUTHENTICATED on any verification failure (bad signature,
 *     expired token, audience mismatch, malformed payload).
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleProfile> {
  const client = getClient();

  let ticket: LoginTicket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
  } catch (err) {
    logger.warn({ err }, 'google_id_token_verify_failed');
    throw new UnauthorizedError('Invalid Google ID token');
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new UnauthorizedError('Google ID token payload missing');
  }

  const sub = payload.sub;
  const email = payload.email;

  if (typeof sub !== 'string' || sub.length === 0) {
    throw new UnauthorizedError('Google ID token missing subject');
  }
  if (typeof email !== 'string' || email.length === 0) {
    throw new UnauthorizedError('Google ID token missing email');
  }

  return {
    providerUserId: sub,
    email: email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
