import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * The single password module for the whole repository: the API and the admin seed
 * both use it, so there is exactly one hashing algorithm and one parser for it.
 *
 * Argon2id with the OWASP baseline (19 MiB, 2 iterations, 1 lane). The parameters
 * are encoded in the hash string, so raising them later does not invalidate old
 * hashes; verify() reads the parameters from the stored value.
 */

export const MIN_PASSWORD_LENGTH = 12;

export const FORBIDDEN_PASSWORDS: readonly string[] = [
  'password',
  'password123',
  'password1234',
  'changeme',
  'change-me',
  'admin',
  'admin123',
  'administrator',
  'letmein',
  'secret',
  'dev-secret',
  'abhyas',
  'qwerty123456',
];

export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export class PasswordPolicyError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Password rejected:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'PasswordPolicyError';
    this.issues = issues;
  }
}

/** Pure policy check, so it can be tested and reused without hashing anything. */
export function passwordIssues(password: string): string[] {
  const issues: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    issues.push('must contain at least one letter and one digit');
  }
  if (FORBIDDEN_PASSWORDS.includes(password.toLowerCase())) {
    issues.push('must not be a well-known password');
  }

  return issues;
}

export function assertPasswordAcceptable(password: string): void {
  const issues = passwordIssues(password);
  if (issues.length > 0) {
    throw new PasswordPolicyError(issues);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * False for a wrong password and false for a malformed stored hash: the caller must
 * never distinguish the two to a client.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}
