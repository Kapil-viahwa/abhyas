import { describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_TTL_MS, generateToken, hashToken, tokenEquals } from './tokens';

describe('opaque tokens', () => {
  it('is long enough and URL safe', () => {
    const token = generateToken();

    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateToken()).not.toBe(token);
  });

  it('hashes deterministically and never returns the token itself', () => {
    const token = generateToken();
    const hash = hashToken(token);

    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });

  it('compares without leaking length differences', () => {
    const token = generateToken();

    expect(tokenEquals(token, token)).toBe(true);
    expect(tokenEquals(token, `${token}x`)).toBe(false);
    expect(tokenEquals(hashToken(token), hashToken(`${token}x`))).toBe(false);
  });

  it('keeps the access token window short', () => {
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  });
});
