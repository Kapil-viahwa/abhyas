import { afterEach, describe, expect, it } from 'vitest';

import { webConfig } from './config';
import { clientAddress, clientIpFrom } from './upstream';

/**
 * The web tier and the client address (decisions 0052/0055).
 *
 * The API's per-IP limits are only as good as the address it is handed. A browser can send
 * a forwarding header of its own, so this tier reads exactly one header — the one
 * `TRUST_CLIENT_IP_HEADER` names — at the named hop from the right, and forwards nothing that
 * is not exactly one IP address. The header it does not name is never opened.
 */

const KEYS = [
  'TRUST_PROXY',
  'TRUST_CLIENT_IP_HEADER',
  'TRUST_FORWARDED_IP_FOR_TESTS',
  'NODE_ENV',
  'TURNSTILE_SITE_KEY',
  'WEB_URL',
];

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
    process.env.TRUST_CLIENT_IP_HEADER = 'x-forwarded-for';

    expect(clientIpFrom(request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }))).toBe('198.51.100.7');

    process.env.TRUST_PROXY = '2';

    expect(clientIpFrom(request({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.9' }))).toBe('198.51.100.7');
  });

  it('reads x-real-ip when it is the configured header, and ignores a spoofed X-Forwarded-For', () => {
    process.env.TRUST_PROXY = '1';
    // The default: an edge that overwrites X-Real-IP leaves X-Forwarded-For to the browser.
    expect(webConfig().clientIpHeader).toBe('x-real-ip');

    expect(
      clientIpFrom(
        request({
          'x-forwarded-for': '203.0.113.9',
          'x-real-ip': '198.51.100.7',
        }),
      ),
    ).toBe('198.51.100.7');

    // Only the forged header: nothing is forwarded, because the one configured is absent.
    expect(clientIpFrom(request({ 'x-forwarded-for': '203.0.113.9' }))).toBeUndefined();
  });

  it('reads X-Forwarded-For when it is configured, and ignores a spoofed X-Real-IP', () => {
    process.env.TRUST_PROXY = '1';
    process.env.TRUST_CLIENT_IP_HEADER = 'x-forwarded-for';

    expect(
      clientIpFrom(
        request({
          'x-real-ip': '203.0.113.9',
          'x-forwarded-for': '198.51.100.7',
        }),
      ),
    ).toBe('198.51.100.7');

    expect(clientIpFrom(request({ 'x-real-ip': '203.0.113.9' }))).toBeUndefined();
  });

  it('forwards only the one address the hop names, never a raw header', () => {
    process.env.TRUST_PROXY = '1';
    process.env.TRUST_CLIENT_IP_HEADER = 'x-forwarded-for';

    const rejected = [
      'not-an-address',
      '999.999.999.999',
      '=HYPERLINK("http://example.com")',
      '<script>alert(1)</script>',
      '1'.repeat(4000),
    ];

    for (const value of rejected) {
      expect(clientAddress(value)).toBeUndefined();
      expect(clientIpFrom(request({ 'x-forwarded-for': value }))).toBeUndefined();
      expect(clientIpFrom(request({ 'x-real-ip': value }))).toBeUndefined();
    }

    // A newline cannot even become a header: the platform refuses to build the request,
    // which is the first of the two gates such a value has to pass.
    expect(() => request({ 'x-forwarded-for': '203.0.113.9\n198.51.100.7' })).toThrow();
    expect(clientAddress('203.0.113.9\n198.51.100.7')).toBeUndefined();

    // A list is never forwarded as written: only the entry at the trusted hop is, so the API
    // receives one address — the one the proxy wrote — and never the header itself.
    const fromChain = clientIpFrom(request({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));

    expect(fromChain).toBe('10.0.0.1');
    expect(fromChain).not.toContain(',');

    expect(clientAddress(' 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('lets the browser suite choose an address only outside production', () => {
    process.env.TRUST_FORWARDED_IP_FOR_TESTS = 'true';

    expect(clientIpFrom(request({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
    // Still only the configured header: the switch loosens who may state an address, not which
    // header carries it.
    expect(clientIpFrom(request({ 'x-forwarded-for': '198.51.100.7' }))).toBeUndefined();

    expect(() => webConfig({ ...PRODUCTION, TRUST_FORWARDED_IP_FOR_TESTS: 'true' })).toThrow(
      /TRUST_FORWARDED_IP_FOR_TESTS is refused in production/,
    );
  });

  it('refuses to let production enable an unnamed edge, and accepts a named hop', () => {
    expect(() => webConfig({ ...PRODUCTION, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY is refused in production/);
    expect(() => webConfig({ ...PRODUCTION, TRUST_PROXY: '*' })).toThrow(/TRUST_PROXY is refused in production/);

    expect(
      webConfig({ ...PRODUCTION, TRUST_PROXY: '1', TRUST_CLIENT_IP_HEADER: 'x-real-ip' }).forwardedIpHops,
    ).toBe(1);
  });

  it('requires the one header to be named when production names a hop', () => {
    expect(() => webConfig({ ...PRODUCTION, TRUST_PROXY: '1' })).toThrow(
      /TRUST_CLIENT_IP_HEADER must name the one header/,
    );

    expect(webConfig({ ...PRODUCTION, TRUST_PROXY: '1', TRUST_CLIENT_IP_HEADER: 'x-forwarded-for' }).clientIpHeader).toBe(
      'x-forwarded-for',
    );

    expect(() => webConfig({ ...PRODUCTION, TRUST_CLIENT_IP_HEADER: 'forwarded' })).toThrow(
      /TRUST_CLIENT_IP_HEADER must be one of/,
    );
  });
});

