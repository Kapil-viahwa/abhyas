import { describe, expect, it } from 'vitest';

import {
  assertPasswordAcceptable,
  hashPassword,
  passwordIssues,
  PasswordPolicyError,
  verifyPassword,
} from './password';

describe('password policy', () => {
  it('accepts a long password with a letter and a digit', () => {
    expect(passwordIssues('first-admin-2026')).toEqual([]);
  });

  it('rejects short, letter-only and well-known passwords', () => {
    expect(passwordIssues('short1')).toContain('must be at least 12 characters');
    expect(passwordIssues('onlyletterslong')).toContain('must contain at least one letter and one digit');
    expect(passwordIssues('changeme')).toContain('must not be a well-known password');
    expect(() => assertPasswordAcceptable('changeme')).toThrow(PasswordPolicyError);
  });
});

describe('argon2id hashing', () => {
  it('round-trips a password and never stores it in clear', async () => {
    const stored = await hashPassword('first-admin-2026');

    expect(stored).toContain('$argon2id$');
    expect(stored).not.toContain('first-admin-2026');
    expect(await verifyPassword(stored, 'first-admin-2026')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('first-admin-2026');
    expect(await verifyPassword(stored, 'first-admin-2027')).toBe(false);
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'first-admin-2026')).toBe(false);
    expect(await verifyPassword('', 'first-admin-2026')).toBe(false);
  });

  it('produces a different hash each time (unique salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('first-admin-2026'), hashPassword('first-admin-2026')]);
    expect(a).not.toBe(b);
  });
});
