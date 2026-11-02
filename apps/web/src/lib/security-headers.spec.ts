import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, contentSecurityPolicy, headerRules, mediaOrigin } from './security-headers';

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

  it('adds the storage origin to img-src and to nothing else', () => {
    const origin = 'https://media.example.com';
    const policy = contentSecurityPolicy(origin);
    const directives = new Map(policy.split('; ').map((directive) => [directive.split(' ')[0], directive]));

    expect(directives.get('img-src')).toBe(`img-src 'self' data: ${origin}`);

    // Every other directive is unchanged: the storage origin is not a script, frame or
    // connection host, only a place an image may be loaded from.
    for (const [name, directive] of directives) {
      if (name !== 'img-src') {
        expect(CONTENT_SECURITY_POLICY).toContain(directive);
      }
    }
  });

  it('accepts an origin and refuses a URL that carries more than one', () => {
    expect(mediaOrigin('  https://media.example.com  ')).toBe('https://media.example.com');
    expect(mediaOrigin('')).toBe('');
    expect(mediaOrigin(undefined)).toBe('');

    expect(() => mediaOrigin('https://media.example.com/bucket')).toThrow(/without a path/);
    expect(() => mediaOrigin('data:text/html,alert(1)')).toThrow(/http or https/);
    expect(() => mediaOrigin('https://user:pass@media.example.com')).toThrow(/without a path/);
  });

  it('leaves img-src without a third-party host when no origin is configured', () => {
    const imgSrc = contentSecurityPolicy().split('; ').find((directive) => directive.startsWith('img-src'));

    expect(imgSrc).toBe("img-src 'self' data:");
  });
});
