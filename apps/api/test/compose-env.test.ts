import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateEnv } from '@abhyas/shared';

/**
 * Every service in the production compose boots through the shared validator.
 *
 * `docker-compose.prod.yml` is the deployment contract, and a service whose environment is
 * one variable short does not fail the compose file: it fails at boot, on the server, at the
 * worst possible moment. `scripts/validate-compose-prod.mjs` proves that every required
 * secret is *named*; this test proves that what the file actually hands each service is an
 * environment `validateEnv` accepts in production.
 *
 * The environment block is read without a YAML dependency, because adding one to run a test
 * is a bigger change than the test. Only the two service/environment levels this file uses
 * are recognised; anything else is ignored.
 */

const COMPOSE_FILE = join(process.cwd(), '../../docker-compose.prod.yml');

/** A value per variable the compose file requires, strong and distinct per variable. */
const DUMMIES: Record<string, string> = {
  POSTGRES_USER: 'abhyas',
  POSTGRES_PASSWORD: 'compose-check-postgres-password',
  POSTGRES_DB: 'abhyas',
  DATABASE_URL: 'postgresql://abhyas_app:compose-check-app-password@postgres:5432/abhyas',
  MIGRATION_DATABASE_URL: 'postgresql://abhyas:compose-check-owner-password@postgres:5432/abhyas',
  REDIS_URL: 'redis://redis:6379',
  REDIS_PASSWORD: 'compose-check-redis-password',
  AUTH_SECRET: 'compose-check-auth-secret-0123456789abcdef',
  OTP_HMAC_SECRET: 'compose-check-otp-secret-0123456789abcdef',
  REVALIDATE_SECRET: 'compose-check-revalidate-secret',
  TURNSTILE_SECRET_KEY: 'compose-check-turnstile-secret',
  TURNSTILE_SITE_KEY: 'compose-check-turnstile-site-key',
  WEB_URL: 'https://abhyas.example.com',
  SMS_PROVIDER: 'msg91',
  EMAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtps://user:password@smtp.example.com:465',
  S3_ENDPOINT: 'https://storage.example.com',
  S3_BUCKET: 'abhyas-media',
  S3_ACCESS_KEY_ID: 'compose-check-access-key',
  S3_SECRET_ACCESS_KEY: 'compose-check-secret-value',
};

/** Each service's `environment:` block, as written (still carrying its `${VAR}` placeholders). */
export function serviceEnvironments(source: string): Record<string, Record<string, string>> {
  const environments: Record<string, Record<string, string>> = {};
  let service: string | null = null;
  let inEnvironment = false;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const text = line.trim();
    const indent = line.length - line.trimStart().length;

    if (text === '' || text.startsWith('#')) {
      continue;
    }

    if (indent === 2 && text.endsWith(':')) {
      service = text.slice(0, -1);
      inEnvironment = false;
      continue;
    }

    if (indent === 4 && text === 'environment:') {
      inEnvironment = service !== null;

      if (service !== null) {
        environments[service] = {};
      }

      continue;
    }

    if (indent <= 4) {
      inEnvironment = false;
      continue;
    }

    if (!inEnvironment || service === null || indent !== 6) {
      continue;
    }

    const match = /^([A-Z0-9_]+):\s*(.*)$/.exec(text);

    if (match !== null) {
      environments[service]![match[1] as string] = unquote(String(match[2]).trim());
    }
  }

  return environments;
}

/** A quoted YAML scalar is the value without its quotes. */
function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')));

  return quoted ? value.slice(1, -1) : value;
}

/** Fills every `${VAR:?message}` and `${VAR:-default}` the compose file leaves to the host. */
export function resolvedEnvironment(
  name: string,
  entries: Record<string, string>,
): Record<string, string> {
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
          throw new Error(
            `docker-compose.prod.yml names ${variable} in service "${name}" and the test has no value for it`,
          );
        }

        return value;
      },
    );
  }

  return resolved;
}

describe('the production compose environment', () => {
  const source = readFileSync(COMPOSE_FILE, 'utf8');
  const environments = serviceEnvironments(source);

  it('has an environment block for every service that takes one', () => {
    // `redis` takes no environment in this file yet, so it is not asserted here.
    for (const name of ['postgres', 'migrations', 'api', 'web', 'worker']) {
      expect(Object.keys(environments)).toContain(name);
    }
  });

  it('gives the api and the worker an environment the shared validator accepts in production', () => {
    const failures: string[] = [];

    for (const name of ['api', 'worker']) {
      const entries = environments[name];
      expect(entries, `service "${name}" has no environment block`).toBeDefined();

      try {
        validateEnv(resolvedEnvironment(name, entries ?? {}));
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // One assertion, so a missing variable is named once rather than one test per service.
    expect(failures).toEqual([]);
  });

  it('leaves no placeholder unresolved in the api or the worker environment', () => {
    for (const name of ['api', 'worker']) {
      const resolved = resolvedEnvironment(name, environments[name] ?? {});
      expect(JSON.stringify(resolved)).not.toContain('${');
    }
  });
});
