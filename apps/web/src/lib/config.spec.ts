import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
      REVALIDATE_SECRET: 'r'.repeat(32),
    });

    expect(config.turnstileTestMode).toBe(false);
    expect(config.turnstileSiteKey).toBe('live-site-key');
    expect(config.revalidateSecret).toBe('r'.repeat(32));
  });

  it('keeps the mobile screens off unless the switch is set', () => {
    expect(webConfig({ NODE_ENV: 'test' }).otpEnabled).toBe(false);
    expect(webConfig({ NODE_ENV: 'test', OTP_ENABLED: 'false' }).otpEnabled).toBe(false);
    expect(webConfig({ NODE_ENV: 'test', OTP_ENABLED: 'true' }).otpEnabled).toBe(true);
    expect(webConfig({ NODE_ENV: 'test', OTP_ENABLED: ' TRUE ' }).otpEnabled).toBe(true);
  });

  it('requires a revalidation secret of a usable length in production', () => {
    const base = {
      NODE_ENV: 'production',
      WEB_URL: 'https://abhyas.example.com',
      TURNSTILE_SITE_KEY: 'live-site-key',
    };

    expect(() => webConfig(base)).toThrow(/REVALIDATE_SECRET is required in production/);
    expect(() => webConfig({ ...base, REVALIDATE_SECRET: 'short' })).toThrow(
      /REVALIDATE_SECRET must be at least 16 characters/,
    );
  });
});


/**
 * The web service of the production compose boots through this validator.
 *
 * The API's half of the same check lives in `apps/api/test/compose-env.test.ts`; this half
 * proves that the `web` service hands this tier an environment `webConfig` accepts in
 * production, including the one client-address header (decision 0055). The block is read
 * without a YAML dependency, so only the two levels this file uses are recognised.
 */
const COMPOSE_FILE = join(process.cwd(), '../../docker-compose.prod.yml');

const DUMMIES: Record<string, string> = {
  WEB_URL: 'https://abhyas.example.com',
  TURNSTILE_SITE_KEY: 'compose-check-turnstile-site-key',
  REVALIDATE_SECRET: 'compose-check-revalidate-secret',
};

function webServiceEnvironment(source: string): Record<string, string> | undefined {
  const environment: Record<string, string> = {};
  let inWebService = false;
  let inEnvironment = false;
  let found = false;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const text = line.trim();
    const indent = line.length - line.trimStart().length;

    if (text === '' || text.startsWith('#')) {
      continue;
    }

    if (indent === 2 && text.endsWith(':')) {
      inWebService = text.slice(0, -1) === 'web';
      inEnvironment = false;
      continue;
    }

    if (indent === 4 && text === 'environment:') {
      inEnvironment = inWebService;
      found = found || inEnvironment;
      continue;
    }

    if (indent <= 4) {
      inEnvironment = false;
      continue;
    }

    if (!inEnvironment || indent !== 6) {
      continue;
    }

    const match = /^([A-Z0-9_]+):\s*(.*)$/.exec(text);

    if (match !== null) {
      environment[match[1] as string] = unquote(String(match[2]).trim());
    }
  }

  return found ? environment : undefined;
}

/** A quoted YAML scalar is the value without its quotes. */
function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')));

  return quoted ? value.slice(1, -1) : value;
}

function resolvedEnvironment(entries: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, raw] of Object.entries(entries)) {
    resolved[key] = raw.replace(
      /\$\{([A-Za-z0-9_]+)(?::([?-])([^}]*))?\}/g,
      (_whole, variable: string, kind: string | undefined, fallback: string | undefined) => {
        if (kind === '-' && DUMMIES[variable] === undefined) {
          return String(fallback ?? '');
        }

        const value = DUMMIES[variable];

        if (value === undefined) {
          throw new Error(`docker-compose.prod.yml leaves ${variable} to the host and the test has no value for it`);
        }

        return value;
      },
    );
  }

  return resolved;
}

describe('the web service in the production compose', () => {
  it('carries an environment webConfig accepts in production', () => {
    const entries = webServiceEnvironment(readFileSync(COMPOSE_FILE, 'utf8'));

    expect(entries).toBeDefined();

    // Throws, naming the variable, when the file is one variable short for this tier.
    const config = webConfig(resolvedEnvironment(entries ?? {}));

    expect(config.nodeEnv).toBe('production');
    expect(config.forwardedIpHops).toBe(1);
    expect(config.clientIpHeader).toBe('x-real-ip');
  });
});
