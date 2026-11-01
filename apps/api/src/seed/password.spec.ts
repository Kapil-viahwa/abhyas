import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('verifies a password against its stored hash', () => {
    const stored = hashPassword('correct-horse-battery-9');

    expect(stored).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(verifyPassword('correct-horse-battery-9', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct-horse-battery-9');

    expect(verifyPassword('correct-horse-battery-8', stored)).toBe(false);
  });

  it('uses a fresh salt for every hash', () => {
    expect(hashPassword('same-password-1')).not.toBe(hashPassword('same-password-1'));
  });

  it('refuses malformed stored values instead of throwing', () => {
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'plaintext')).toBe(false);
    expect(verifyPassword('anything', 'bcrypt$1$2$3$4$5')).toBe(false);
    expect(verifyPassword('anything', 'scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(false);
  });
});
