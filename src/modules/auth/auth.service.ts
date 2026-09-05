// src/modules/auth/auth.service.ts
//
// Auth business logic. Pure orchestration: composes password.service +
// token.service + Prisma + Redis, throws typed errors for the controller
// to surface as the standard envelope.
//
// AuthResponse shape (returned from every flow that issues tokens):
//   { accessToken, refreshToken, expiresIn: 900, user: { id, email, roles[] } }
//
// Error model:
//   - 400 VALIDATION for password-policy failures (via password.service)
//   - 401 UNAUTHENTICATED for bad credentials / reused refresh
//   - 403 FORBIDDEN for suspended/deactivated accounts
//   - 404 NOT_FOUND is intentionally NEVER thrown on login (would leak
//     account existence; see §11.3.3).
//   - 409 CONFLICT for duplicate signup (P2002)
//   - 429 RATE_LIMITED for login throttle (locked out)

import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { AppRole } from '@/middleware/auth';

import type {
  GoogleOAuthCallbackInput,
  LoginInput,
  PasswordResetConfirmInput,
  PasswordResetRequestInput,
  RefreshInput,
  SignupInput,
  VerifyEmailResendInput,
} from './auth.schemas';
import { verifyGoogleIdToken } from './google-oauth.service';
import { validatePasswordPolicy } from './password.service';
import {
  incrementLoginFails,
  isLoginLocked,
  killAccess,
  mintAccessToken,
  mintRefreshToken,
  resetLoginFails,
  revokeAllRefreshForUser,
  revokeRefreshByRaw,
} from './token.service';

export interface AuthUserView {
  id: string;
  email: string;
  roles: AppRole[];
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUserView;
}

interface RequestMeta {
  userAgent?: string;
  ip?: string;
}

/** Map a Prisma user + roles to the public AuthUserView (no PII leak). */
function toAuthUserView(user: {
  id: string;
  email: string;
  roles?: Array<{ role: AppRole }>;
}): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    roles: (user.roles ?? []).map((r) => r.role),
  };
}

// ──────────────────────────────────────────────────────────────────────
// signup
// ──────────────────────────────────────────────────────────────────────

export async function signupUser(
  input: SignupInput,
  meta: RequestMeta = {}
): Promise<AuthResponse> {
  const policy = validatePasswordPolicy(input.password);
  if (!policy.ok) {
    throw new ValidationError('Password does not meet policy', policy.errors);
  }

  const { hashPassword } = await import('./password.service');
  const passwordHash = await hashPassword(input.password);

  // Create user + mint first refresh token. If two parallel signups race
  // on the same email, the partial unique index `users_email_active_uniq`
  // rejects the loser as P2002 (Caught by error-handler → 409 CONFLICT).
  type CreatedUser = {
    id: string;
    email: string;
    roles: Array<{ role: AppRole }>;
  };
  let created: CreatedUser;
  try {
    created = await prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash,
        // §6.2: a brand-new user is USER-only (no tenant/owner role rows).
        // KYC promotes them later via /users/kyc (Phase 8).
        roles: {
          create: [],
        },
      },
      select: {
        id: true,
        email: true,
        roles: { select: { role: true } },
      },
    });
  } catch (err) {
    if (isPrismaUniqueViolation(err)) {
      throw new ConflictError('CONFLICT', 'Email already registered');
    }
    throw err;
  }

  const access = await mintAccessToken(created.id);
  const refresh = await mintRefreshToken(created.id, {
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    user: toAuthUserView(created),
  };
}

// ──────────────────────────────────────────────────────────────────────
// login
// ──────────────────────────────────────────────────────────────────────

export async function loginUser(input: LoginInput, meta: RequestMeta = {}): Promise<AuthResponse> {
  const email = input.email.toLowerCase();

  // 1. Throttle gate — cheap fail (no DB lookup, no argon2 cost).
  if (await isLoginLocked(email)) {
    // Reuse RateLimitedError with a 15min hint via SemanticError
    // so the envelope carries a retry-after field.
    const { RateLimitedError } = await import('@/lib/errors');
    throw new RateLimitedError('Too many login attempts; try again in 15 minutes', 15 * 60);
  }

  // 2. Look up user. We DON'T 404 — that would leak account existence
  //    per §11.3.3. We treat "not found" the same as "wrong password".
  //
  //    Note: `findFirst` because the unique index on email is partial
  //    (WHERE deleted_at IS NULL), which Prisma's type system doesn't
  //    recognize as a regular unique key.
  const user = await prisma.user.findFirst({
    where: { email },
    select: {
      id: true,
      email: true,
      status: true,
      deletedAt: true,
      passwordHash: true,
      roles: { select: { role: true } },
    },
  });

  const { verifyPassword } = await import('./password.service');

  const credentialsInvalid =
    !user ||
    !user.passwordHash ||
    user.deletedAt !== null ||
    user.status === 'DEACTIVATED' ||
    user.status === 'SUSPENDED' ||
    !(await verifyPassword(user.passwordHash, input.password));

  if (credentialsInvalid) {
    // Increment throttle on ANY failed credential check (including
    // unknown email — otherwise an attacker can probe without rate).
    await incrementLoginFails(email);
    throw new UnauthorizedError('Invalid credentials');
  }

  // 3. Success — reset throttle, issue tokens.
  await resetLoginFails(email);

  const access = await mintAccessToken(user.id);
  const refresh = await mintRefreshToken(user.id, {
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    user: toAuthUserView(user),
  };
}

// ──────────────────────────────────────────────────────────────────────
// refresh (rotation)
// ──────────────────────────────────────────────────────────────────────

export async function refreshSession(
  input: RefreshInput,
  meta: RequestMeta = {}
): Promise<AuthResponse> {
  // CAS revoke: if the token was already revoked, `reuse-detected`
  // comes back and we kill the family.
  const result = await revokeRefreshByRaw(input.refreshToken);

  switch (result.kind) {
    case 'not-found':
    case 'expired':
      throw new UnauthorizedError('Refresh token expired or invalid');

    case 'reuse-detected':
      logger.warn(
        { familyId: result.familyId, userId: result.userId, revokedCount: result.revokedCount },
        'Refresh token reuse detected; family revoked'
      );
      throw new UnauthorizedError('Refresh token reuse detected; please sign in again');

    case 'rotated': {
      // Mint a fresh access token and a fresh refresh token in the SAME family.
      const access = await mintAccessToken(result.userId);
      const refresh = await mintRefreshToken(result.userId, {
        familyId: result.familyId,
        userAgent: meta.userAgent,
        ip: meta.ip,
      });

      const user = await prisma.user.findUnique({
        where: { id: result.userId },
        select: {
          id: true,
          email: true,
          roles: { select: { role: true } },
        },
      });
      if (!user) {
        // The user was deleted between rotation and read — unusual.
        throw new UnauthorizedError('Refresh token expired or invalid');
      }

      return {
        accessToken: access.token,
        refreshToken: refresh.token,
        expiresIn: access.expiresIn,
        user: toAuthUserView(user),
      };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// logout
// ──────────────────────────────────────────────────────────────────────

/**
 * Log out the current session.
 *
 * Phase 6 simplification: revokes ALL of the user's refresh tokens
 * rather than just the "current" one. Reason: identifying "current"
 * requires parsing the access token's user + family tuple, which is
 * more machinery than we want in Phase 6. `/auth/logout/all` is the
 * strict version of this; /auth/logout is the convenience shortcut.
 *
 * If `accessRaw` is provided, we also delete the matching Redis key
 * so the access token stops working immediately (otherwise the caller
 * is still authenticated until the 15min TTL expires).
 */
export async function logoutCurrentSession(
  userId: string,
  accessRaw: string | undefined
): Promise<void> {
  await revokeAllRefreshForUser(userId);
  if (accessRaw) await killAccess(accessRaw);
}

/** Strict logout-everywhere. Returns the count of revoked refresh rows. */
export async function logoutAll(userId: string): Promise<number> {
  return revokeAllRefreshForUser(userId);
}

// ──────────────────────────────────────────────────────────────────────
// password reset (stubs)
// ──────────────────────────────────────────────────────────────────────

/**
 * Request a password-reset email. Phase 6 stub: we accept any email and
 * log a single line. Phase 7/22 will wire the actual email send.
 *
 * We deliberately do NOT 404 on unknown emails — that would leak
 * account existence (§11.3.3). Same generic "ok" for everyone.
 */
export async function requestPasswordReset(input: PasswordResetRequestInput): Promise<void> {
  logger.info(
    { email: input.email.toLowerCase(), kind: 'password_reset_request' },
    'password reset requested (stub — email not actually sent)'
  );
}

/**
 * Confirm a password-reset token. Phase 6 stub: always rejects because
 * we haven't minted any tokens yet. Phase 7/22 will:
 *   1. look up the token row
 *   2. validate the new password against policy
 *   3. update user.passwordHash + revoke all refresh tokens for that user
 */
export async function confirmPasswordReset(input: PasswordResetConfirmInput): Promise<void> {
  const policy = validatePasswordPolicy(input.newPassword);
  if (!policy.ok) {
    throw new ValidationError('Password does not meet policy', policy.errors);
  }
  logger.info(
    { tokenPrefix: input.token.slice(0, 8), kind: 'password_reset_confirm' },
    'password reset confirm attempted (stub — no token table yet)'
  );
  throw new UnauthorizedError('Password reset is not available yet');
}

// ──────────────────────────────────────────────────────────────────────
// verify email (stubs)
// ──────────────────────────────────────────────────────────────────────

export async function resendVerification(input: VerifyEmailResendInput): Promise<void> {
  logger.info(
    { email: input.email.toLowerCase(), kind: 'verify_email_resend' },
    'verify-email resend requested (stub — email not actually sent)'
  );
}

/** GET /verify-email?token=… handler. Stub: always 200, never consumes. */
export async function verifyEmail(token: string | undefined): Promise<void> {
  logger.info(
    { tokenPrefix: token ? token.slice(0, 8) : null, kind: 'verify_email' },
    'verify-email link visited (stub — token not actually consumed)'
  );
}

// ──────────────────────────────────────────────────────────────────────
// google oauth (Phase 7)
// ──────────────────────────────────────────────────────────────────────

/**
 * Verify a Google idToken and either:
 *   - log the user into an existing Google-linked account, OR
 *   - link the Google identity to an existing password account (when
 *     the email matches AND the Google email is verified), OR
 *   - create a brand-new OAuth-only account.
 *
 * Privacy guard (§6.3): we never auto-link to a password account when
 * the Google email is unverified — that would let an attacker claim
 * any unverified email by registering it at Google first. We 401
 * instead, and the user can verify with Google (or sign in with their
 * password).
 */
export async function loginOrLinkGoogle(
  input: GoogleOAuthCallbackInput,
  meta: RequestMeta = {}
): Promise<AuthResponse> {
  // 1. Verify the idToken. Throws 503 (env unset) or 401 (bad token).
  const profile = await verifyGoogleIdToken(input.idToken);

  // 2. Look up an existing user by the canonical OAuth identity first.
  //
  //    Note: findFirst, not findUnique, because (oauth_provider,
  //    oauth_subject) is a *partial* unique index (WHERE oauth_provider
  //    IS NOT NULL) and Prisma doesn't type partial uniques.
  let user = await prisma.user.findFirst({
    where: {
      oauthProvider: 'google',
      oauthSubject: profile.providerUserId,
    },
    select: {
      id: true,
      email: true,
      status: true,
      deletedAt: true,
      oauthProvider: true,
      oauthSubject: true,
      roles: { select: { role: true } },
    },
  });

  // 3. Identity not found — try linking to an existing password account.
  if (!user) {
    if (!profile.emailVerified) {
      // We will NOT auto-link to a password account on an unverified
      // Google email. Throw before the email-lookup so we don't even
      // leak whether the password account exists.
      throw new UnauthorizedError('Google email is not verified; please verify with Google first');
    }

    const passwordAccount = await prisma.user.findFirst({
      where: { email: profile.email },
      select: {
        id: true,
        email: true,
        status: true,
        deletedAt: true,
        oauthProvider: true,
        oauthSubject: true,
        roles: { select: { role: true } },
      },
    });

    if (passwordAccount) {
      if (passwordAccount.oauthProvider === 'google') {
        // Two different Google subs racing for the same email. The
        // partial unique index would have prevented creating a second
        // row; the only way to land here is if data was hand-edited.
        // Treat as a hard conflict so the operator notices.
        throw new ConflictError('CONFLICT', 'Google account already linked to a different subject');
      }

      // Link the password account to the Google identity. We stamp
      // emailVerifiedAt too — Google's JWT confirms mailbox ownership,
      // which is strictly stronger evidence than our outbound verification
      // emails (§11.7).
      try {
        user = await prisma.user.update({
          where: { id: passwordAccount.id },
          data: {
            oauthProvider: 'google',
            oauthSubject: profile.providerUserId,
            emailVerifiedAt: new Date(),
          },
          select: {
            id: true,
            email: true,
            status: true,
            deletedAt: true,
            oauthProvider: true,
            oauthSubject: true,
            roles: { select: { role: true } },
          },
        });
        logger.info(
          { userId: user.id, googleSub: profile.providerUserId },
          'google_oauth_account_linked'
        );
      } catch (err) {
        if (isPrismaUniqueViolation(err)) {
          // Race: a parallel OAuth login linked the same `sub` first.
          throw new ConflictError('CONFLICT', 'Google account already linked');
        }
        throw err;
      }
    } else {
      // Brand-new OAuth-only user. No password hash, no role rows.
      // §6.2 still applies — new users are USER-only.
      try {
        user = await prisma.user.create({
          data: {
            email: profile.email,
            passwordHash: null,
            oauthProvider: 'google',
            oauthSubject: profile.providerUserId,
            emailVerifiedAt: new Date(),
            roles: { create: [] },
          },
          select: {
            id: true,
            email: true,
            status: true,
            deletedAt: true,
            oauthProvider: true,
            oauthSubject: true,
            roles: { select: { role: true } },
          },
        });
        logger.info({ userId: user.id }, 'google_oauth_user_created');
      } catch (err) {
        if (isPrismaUniqueViolation(err)) {
          // Race: a parallel password signup used the same email first.
          throw new ConflictError('CONFLICT', 'Email already registered');
        }
        throw err;
      }
    }
  }

  // 4. Defensive status check — loginUser already does this for the
  //    password path; we mirror it for OAuth so the same envelope
  //    surfaces for suspended/deactivated accounts.
  if (user.deletedAt !== null || user.status !== 'ACTIVE') {
    throw new ForbiddenError('FORBIDDEN', 'Account is not available');
  }

  // 5. Mint tokens. Same shape as password login.
  const access = await mintAccessToken(user.id);
  const refresh = await mintRefreshToken(user.id, {
    userAgent: meta.userAgent,
    ip: meta.ip,
  });

  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    user: toAuthUserView(user),
  };
}

// ──────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
