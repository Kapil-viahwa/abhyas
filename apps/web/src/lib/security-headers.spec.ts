import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, headerRules } from './security-headers';

describe('security headers', () => {
  it('sends the four headers the phase asks for', () => {
    const keys = SECURITY_HEADERS.map((header) => header.key);

    expect(keys).toContain('Content-Security-Policy');
    expect(keys).toContain('X-Frame-Options');
    expect(keys).toContain('Referrer-Policy');
    expect(keys).toContain('X-Content-Type-Options');
  });

  it('denies framing and sniffing outright', () => {
    const byKey = new Map(SECURITY_HEADERS.map((header) => [header.key, header.value]));

    expect(byKey.get('X-Frame-Options')).toBe('DENY');
    expect(byKey.get('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('keeps the policy closed by default and opens only what the pages need', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("form-action 'self'");
    // The Turnstile widget is a script, a frame and a set of requests to Cloudflare.
    expect(CONTENT_SECURITY_POLICY).toContain('https://challenges.cloudflare.com');
  });

  it('applies the rules to every route', () => {
    const rules = headerRules();

    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe('/:path*');
    expect(rules[0]?.headers).toEqual([...SECURITY_HEADERS]);
  });
});
