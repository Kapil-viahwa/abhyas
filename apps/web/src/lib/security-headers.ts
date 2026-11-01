/**
 * The headers every response carries, kept in one place so a test can read them
 * without booting Next.
 *
 * The Content-Security-Policy is deliberately explicit about what the pages load:
 * their own assets, Next's inline bootstrap scripts, and Cloudflare's Turnstile
 * widget (script, frame and network calls). Nothing else is allowed to run.
 */
export interface HeaderRule {
  readonly key: string;
  readonly value: string;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export const SECURITY_HEADERS: readonly HeaderRule[] = [
  { key: 'Content-Security-Policy', value: CONTENT_SECURITY_POLICY },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** `next.config.ts` shape: the same rules for every route. */
export function headerRules(): Array<{ source: string; headers: HeaderRule[] }> {
  return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }];
}
