import { describe, expect, it } from 'vitest';

import { TURNSTILE_TEST_SITE_KEY, TURNSTILE_TEST_TOKEN, webConfig } from './config';

describe('web configuration', () => {
  it('falls back to the local stack and the Cloudflare test widget in development', () => {
    const config = webConfig({ NODE_ENV: 'development' });

    expect(config.apiInternalUrl).toBe('http://localhost:3001');
    expect(config.webUrl).toBe('http://localhost:3000');
    expect(config.turnstileSiteKey).toBe(TURNSTILE_TEST_SITE_KEY);
    expect(config.turnstileTestMode).toBe(true);
    expect(TURNSTILE_TEST_TOKEN).not.toBe('');
  });

  it('strips trailing slashes from both URLs', () => {
    const config = webConfig({
      NODE_ENV: 'test',
      API_INTERNAL_URL: 'http://api:3001/',
      WEB_URL: 'https://abhyas.example.com//',
    });

    expect(config.apiInternalUrl).toBe('http://api:3001');
    expect(config.webUrl).toBe('https://abhyas.example.com');
  });

  it('refuses a production build without a real site key', () => {
    expect(() => webConfig({ NODE_ENV: 'production', WEB_URL: 'https://abhyas.example.com' })).toThrow(
      /TURNSTILE_SITE_KEY is required/,
    );
  });

  it('refuses a Cloudflare test site key in production', () => {
    expect(() =>
      webConfig({
        NODE_ENV: 'production',
        WEB_URL: 'https://abhyas.example.com',
        TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
      }),
    ).toThrow(/test site keys are refused/);
  });

  it('refuses a plaintext web origin in production', () => {
    expect(() =>
      webConfig({
        NODE_ENV: 'production',
        WEB_URL: 'http://abhyas.example.com',
        TURNSTILE_SITE_KEY: 'live-site-key',
      }),
    ).toThrow(/must use https/);
  });

  it('accepts a real production configuration and does not pre-fill a test token', () => {
    const config = webConfig({
      NODE_ENV: 'production',
      WEB_URL: 'https://abhyas.example.com',
      API_INTERNAL_URL: 'http://api:3001',
      TURNSTILE_SITE_KEY: 'live-site-key',
    });

    expect(config.turnstileTestMode).toBe(false);
    expect(config.turnstileSiteKey).toBe('live-site-key');
  });
});
