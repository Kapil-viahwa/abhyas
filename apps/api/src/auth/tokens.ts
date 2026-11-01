import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque tokens only. Nothing in this repository signs a JWT: an access token is
 * 32 random bytes kept in one place (the session row, hashed), so revoking the
 * session revokes the token with no cache to invalidate.
 */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const EMAIL_TOKEN_TTL_MS = 30 * 60 * 1000;

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed; the plain value only ever exists in the response. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function isExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !expiresAt || expiresAt.getTime() <= now.getTime();
}
