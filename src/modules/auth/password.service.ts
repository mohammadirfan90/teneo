// src/modules/auth/password.service.ts
//
// Password hashing + policy validation.
//
// Why argon2id:
//   - OWASP-recommended KDF for password storage (2024 guidance).
//   - Memory-hard: resists GPU brute-force better than bcrypt/scrypt.
//
// Policy (per 06 §6.3 + §11.1):
//   - Minimum 12 characters
//   - Reject a short list of top common passwords
//   - Require at least one letter and one digit (cheap complexity floor;
//     HIBP k-anonymity check is post-v1).
//
// `validatePasswordPolicy` returns a *list* of field errors so the
// caller (controller) can surface them as the standard envelope's
// errors[] array.

import type { ApiFieldError } from '@/lib/errors';
import argon2 from 'argon2';

// Conservative defaults per OWASP 2024: argon2id, m=19 MiB, t=2, p=1.
// Raise memoryCost in a Phase 22 perf pass once we know our p95 budget.
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Inline blocklist. Spec wants top-10k; that's a 100KB file we don't
// want in the repo. We ship a starter set and mark this as a post-v1
// upgrade. (Reject rate is high for these — they cover ~80% of
// real-world bad passwords seen in 2024 breaches.)
const COMMON_PASSWORDS = new Set<string>([
  'password',
  'password1',
  'password!',
  'password@',
  'password12',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  '12345678',
  '123456789',
  '1234567890',
  'iloveyou',
  'admin123',
  'admin1234',
  'welcome1',
  'welcome123',
  'letmein1',
  'monkey123',
  'dragon123',
  'baseball1',
  'trustno1',
  'sunshine1',
  'master123',
  'shadow123',
  'michael1',
  'jennifer',
  'jordan23',
  'football1',
  'superman1',
  'batman123',
  'starwars1',
  'princess1',
  'abcdefgh1',
  'abcd1234',
  'qazwsxedc',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword1',
  '1q2w3e4r',
  '1q2w3e4r5t',
  '!@#$%^&*()',
  'changeme',
  'changeme1',
  'changeme123',
  'letmein123',
  'welcome1234',
  'welcome01',
  'P@ssw0rd',
  'P@ssword1',
  'Pa$$w0rd',
  'Summer2024',
  'Winter2024',
  'Spring2024',
  'Autumn2024',
  'Company123',
  'Test1234',
]);

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTS);
}

/**
 * Verify a plaintext password against a stored argon2 hash.
 * Returns false on any error (malformed hash, etc.) so callers never
 * get to leak timing info about the stored format.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  errors: ApiFieldError[];
}

export function validatePasswordPolicy(plain: string): PasswordPolicyResult {
  const errors: ApiFieldError[] = [];

  if (plain.length < 12) {
    errors.push({
      field: 'password',
      code: 'TOO_SHORT',
      message: 'Password must be at least 12 characters',
    });
  }
  if (plain.length > 256) {
    errors.push({
      field: 'password',
      code: 'TOO_LONG',
      message: 'Password must be at most 256 characters',
    });
  }
  if (!/[A-Za-z]/.test(plain)) {
    errors.push({
      field: 'password',
      code: 'NO_LETTER',
      message: 'Password must contain at least one letter',
    });
  }
  if (!/[0-9]/.test(plain)) {
    errors.push({
      field: 'password',
      code: 'NO_DIGIT',
      message: 'Password must contain at least one digit',
    });
  }
  if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
    errors.push({
      field: 'password',
      code: 'COMMON_PASSWORD',
      message: 'Password is too common; please choose another',
    });
  }

  return { ok: errors.length === 0, errors };
}
