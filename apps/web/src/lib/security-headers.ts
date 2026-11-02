/**
 * The headers every response carries, kept in one place so a test can read them
 * without booting Next.
 *
 * The Content-Security-Policy is deliberately explicit about what the pages load:
 * their own assets, Next's inline bootstrap scripts, and Cloudflare's Turnstile
 * widget (script, frame and network calls). Nothing else is allowed to run.
 *
 * Question images are the one addition: they are stored in a private S3-compatible
 * bucket and reach the browser through a signed URL, so that bucket's origin — and only
 * that origin, exactly — joins `img-src` when it is configured (decision 0045).
 */
export interface HeaderRule {
  readonly key: string;
  readonly value: string;
}

/**
 * Accepts an origin and nothing else: no path, no query, no fragment, and only http or
 * https. Anything else is a configuration mistake and stops the build rather than
 * quietly widening the policy.
 */
export function mediaOrigin(value: string | undefined): string {
  const raw = value?.trim() ?? '';
  if (raw === '') {
    return '';
  }

  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('MEDIA_ORIGIN must be an http or https origin');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('MEDIA_ORIGIN must be an origin, without a path or credentials');
  }

  return url.origin;
}

export function contentSecurityPolicy(origin: string | undefined = ''): string {
  const media = mediaOrigin(origin);

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    media === '' ? "img-src 'self' data:" : `img-src 'self' data: ${media}`,
    "font-src 'self'",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function securityHeaders(origin: string | undefined = ''): HeaderRule[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(origin) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}

/** The policy with no storage origin configured. */
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

export const SECURITY_HEADERS: readonly HeaderRule[] = securityHeaders();

/** `next.config.ts` shape: the same rules for every route. */
export function headerRules(origin: string | undefined = ''): Array<{ source: string; headers: HeaderRule[] }> {
  return [{ source: '/:path*', headers: securityHeaders(origin) }];
}
