import { afterEach, describe, expect, it } from 'vitest';

import { webConfig } from './config';
import { clientIpFrom } from './upstream';

/**
 * The browser tier and the client address (decision 0052).
 *
 * The API's per-IP limits are only as good as the address it is handed. A browser can send
 * any `X-Forwarded-For` it likes, so this tier must believe one only when the edge proxy in
 * front of it is named — or, in development and CI only, when the browser suite is allowed
 * to choose a fresh address per test.
 */

const KEYS = ['TRUST_PROXY', 'TRUST_FORWARDED_IP_FOR_TESTS', 'NODE_ENV', 'TURNSTILE_SITE_KEY', 'WEB_URL'];

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
});

function request(): Request {
  return new Request('http://localhost:3000/login', {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-real-ip': '203.0.113.10' },
  });
}

describe('the web tier and the client address', () => {
  it('ignores a browser-supplied header when no proxy is trusted', () => {
    expect(clientIpFrom(request())).toBeUndefined();
    expect(webConfig().trustForwardedIp).toBe(false);
  });

  it('reads the left-most address when the edge proxy is named', () => {
    process.env.TRUST_PROXY = '172.17.0.0/16';

    expect(clientIpFrom(request())).toBe('203.0.113.9');
    expect(webConfig().trustForwardedIp).toBe(true);
  });

  it('allows it only outside production for the browser suite, and refuses it in production', () => {
    process.env.TRUST_FORWARDED_IP_FOR_TESTS = 'true';
    expect(clientIpFrom(request())).toBe('203.0.113.9');

    process.env.NODE_ENV = 'production';
    process.env.TURNSTILE_SITE_KEY = 'live-site-key';
    process.env.WEB_URL = 'https://abhyas.example.com';

    expect(() => webConfig()).toThrow(/TRUST_FORWARDED_IP_FOR_TESTS is refused in production/);
  });
});
