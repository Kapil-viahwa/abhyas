import { afterEach, describe, expect, it } from 'vitest';

import { webConfig } from './config';
import { clientAddress, clientIpFrom } from './upstream';

/**
 * The web tier and the client address (decision 0052).
 *
 * The API's per-IP limits are only as good as the address it is handed. A browser can send
 * a forwarding header of its own, so this tier reads only the entry the trusted edge wrote —
 * from the right of the chain, never the left-most one — and forwards nothing that is not
 * exactly one IP address.
 */

const KEYS = ['TRUST_PROXY', 'TRUST_FORWARDED_IP_FOR_TESTS', 'NODE_ENV', 'TURNSTILE_SITE_KEY', 'WEB_URL'];

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

function request(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/login', { headers });
}

/** A production environment that passes every other check, so the policy is what is tested. */
const PRODUCTION = {
  NODE_ENV: 'production',
  TURNSTILE_SITE_KEY: 'live-site-key',
  WEB_URL: 'https://abhyas.example.com',
  REVALIDATE_SECRET: 'production-revalidate-secret',
} as const;

describe('the web tier and the client address', () => {
  it('believes no header until an edge is named', () => {
    expect(clientIpFrom(request({ 'x-real-ip': '198.51.100.7' }))).toBeUndefined();
    expect(clientIpFrom(request({ 'x-forwarded-for': '198.51.100.7' }))).toBeUndefined();
    expect(webConfig().forwardedIpHops).toBeNull();
    expect(webConfig().trustForwardedIp).toBe(false);
  });

  it('reads the entry at the named hop from the right, so a prepended fake is ignored', () => {
    process.env.TRUST_PROXY = '1';

    expect(clientIpFrom(request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }))).toBe('198.51.100.7');

    process.env.TRUST_PROXY = '2';

    expect(clientIpFrom(request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.9' }))).toBe('198.51.100.7');
  });

  it('prefers X-Real-IP, the single value the edge overwrites, over a chain', () => {
    process.env.TRUST_PROXY = '1';

    // Both headers are valid single addresses: the one the edge writes to directly wins,
    // because a chain is the header a client can grow and this one it cannot.
    expect(clientIpFrom(request({ 'x-forwarded-for': '198.51.100.7', 'x-real-ip': '203.0.113.9' }))).toBe(
      '203.0.113.9',
    );

    // And the hop-counted chain is the answer when that is all the edge wrote.
    expect(clientIpFrom(request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('forwards nothing that is not exactly one address', () => {
    process.env.TRUST_PROXY = '1';

    const hostile = [
      'not-an-address',
      '203.0.113.9, 10.0.0.1',
      '999.999.999.999',
      '=HYPERLINK("http://example.com")',
      '<script>alert(1)</script>',
      '203.0.113.9\n198.51.100.7',
      '1'.repeat(4000),
    ];

    for (const value of hostile) {
      expect(clientAddress(value)).toBeUndefined();
      expect(clientIpFrom(request({ 'x-forwarded-for': value }))).toBeUndefined();
      expect(clientIpFrom(request({ 'x-real-ip': value }))).toBeUndefined();
    }

    expect(clientAddress(' 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('lets the browser suite choose an address only outside production', () => {
    process.env.TRUST_FORWARDED_IP_FOR_TESTS = 'true';

    expect(clientIpFrom(request({ 'x-forwarded-for': '198.51.100.7' }))).toBe('198.51.100.7');

    expect(() => webConfig({ ...PRODUCTION, TRUST_FORWARDED_IP_FOR_TESTS: 'true' })).toThrow(
      /TRUST_FORWARDED_IP_FOR_TESTS is refused in production/,
    );
  });

  it('refuses to let production enable an unnamed edge, and accepts a named hop', () => {
    expect(() => webConfig({ ...PRODUCTION, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY is refused in production/);
    expect(() => webConfig({ ...PRODUCTION, TRUST_PROXY: '*' })).toThrow(/TRUST_PROXY is refused in production/);

    expect(webConfig({ ...PRODUCTION, TRUST_PROXY: '1' }).forwardedIpHops).toBe(1);
  });
});
