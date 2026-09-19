// src/modules/auth/auth.schemas.ts
//
// Zod schemas for the auth router. Names match the route path so they're
// easy to grep from the controller.
//
// Length bounds:
//   - email: 254 (RFC 5321 max), no regex beyond `z.string().email()`
//   - password: 12–256 (policy lives in password.service.ts; this is
//     just a cheap pre-filter so we don't even attempt to hash garbage)
//   - refresh token / reset token: 20–256 (matches base64url 32B + a
//     little slack)

import { z } from 'zod';

export const signupSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
});

export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(256),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

/**
 * Google OAuth callback (Phase 7). The client posts a Google Identity
 * Services idToken (a signed JWT, typically 800–1200 chars). 4 KiB
 * headroom covers any future claim bloat.
 */
export const googleOAuthCallbackSchema = z.object({
  idToken: z.string().min(20).max(4096),
});

export type GoogleOAuthCallbackInput = z.infer<typeof googleOAuthCallbackSchema>;
