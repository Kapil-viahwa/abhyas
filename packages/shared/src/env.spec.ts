import { describe, expect, it } from 'vitest';

import { EnvValidationError, validateEnv } from './env';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://abhyas:abhyas@localhost:5432/abhyas',
  REDIS_URL: 'redis://localhost:6379',
};

const production = {
  NODE_ENV: 'production',
  PORT: '3001',
  DATABASE_URL: 'postgresql://abhyas:secret@postgres:5432/abhyas',
  REDIS_URL: 'redis://redis:6379',
  AUTH_SECRET: 'a'.repeat(48),
  TURNSTILE_SECRET_KEY: 'live-turnstile-secret',
  SMS_PROVIDER: 'msg91',
  EMAIL_PROVIDER: 'smtp',
  REVALIDATE_SECRET: 'r'.repeat(32),
  S3_ENDPOINT: 'https://storage.example.com',
  S3_BUCKET: 'abhyas-media',
  S3_ACCESS_KEY_ID: 'live-access-key',
  S3_SECRET_ACCESS_KEY: 'live-secret-value-0123456789',
};

describe('validateEnv', () => {
  it('accepts a development environment with dev shortcuts', () => {
    const env = validateEnv({
      ...base,
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      SMS_PROVIDER: 'fake',
      ALLOW_DEV_LOGIN: 'true',
    });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
    expect(env.SMS_PROVIDER).toBe('fake');
    expect(env.ALLOW_DEV_LOGIN).toBe(true);
  });

  it('accepts a complete production environment', () => {
    const env = validateEnv(production);

    expect(env.NODE_ENV).toBe('production');
    expect(env.SMS_PROVIDER).toBe('msg91');
    expect(env.ALLOW_DEV_LOGIN).toBe(false);
  });

  it('requires a database and redis URL', () => {
    expect(() => validateEnv({})).toThrow(EnvValidationError);
    expect(() => validateEnv({})).toThrow(/DATABASE_URL: is required/);
    expect(() => validateEnv({})).toThrow(/REDIS_URL: is required/);
  });

  it('refuses non-postgres database URLs', () => {
    expect(() => validateEnv({ ...base, DATABASE_URL: 'mysql://localhost/abhyas' })).toThrow(
      /DATABASE_URL: must be a postgres/,
    );
  });

  it('rejects an invalid PORT', () => {
    expect(() => validateEnv({ ...base, PORT: 'not-a-port' })).toThrow(/PORT: must be an integer/);
  });

  it('refuses a Turnstile test key in production', () => {
    expect(() =>
      validateEnv({ ...production, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }),
    ).toThrow(/TURNSTILE_SECRET_KEY: Cloudflare test keys are refused in production/);
  });

  it('refuses the fake SMS provider in production', () => {
    expect(() => validateEnv({ ...production, SMS_PROVIDER: 'fake' })).toThrow(
      /SMS_PROVIDER: fake and console SMS providers are refused in production/,
    );
  });

  it('refuses the console email outbox in production', () => {
    expect(() => validateEnv({ ...production, EMAIL_PROVIDER: 'console' })).toThrow(
      /EMAIL_PROVIDER: the console outbox is refused in production/,
    );
    expect(() => validateEnv({ ...production, EMAIL_PROVIDER: '' })).toThrow(
      /EMAIL_PROVIDER: is required in production/,
    );
  });

  it('refuses dev login in production', () => {
    expect(() => validateEnv({ ...production, ALLOW_DEV_LOGIN: 'true' })).toThrow(
      /ALLOW_DEV_LOGIN: must not be enabled in production/,
    );
  });

  it('refuses a short or well-known auth secret in production', () => {
    expect(() => validateEnv({ ...production, AUTH_SECRET: 'short' })).toThrow(
      /AUTH_SECRET: must be at least 32 characters/,
    );
    expect(() =>
      validateEnv({ ...production, AUTH_SECRET: 'dev-only-insecure-secret-please-change-32chars' }),
    ).toThrow(/AUTH_SECRET: must not be a well-known default value/);
  });

  it('requires a revalidation secret of a usable length in production', () => {
    expect(() => validateEnv({ ...production, REVALIDATE_SECRET: '' })).toThrow(
      /REVALIDATE_SECRET: is required in production/,
    );
    expect(() => validateEnv({ ...production, REVALIDATE_SECRET: 'too-short' })).toThrow(
      /REVALIDATE_SECRET: must be at least 16 characters/,
    );
  });

  it('reports every problem at once', () => {
    try {
      validateEnv({ NODE_ENV: 'production' });
      throw new Error('expected validateEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues;
      expect(issues.map((issue) => issue.variable)).toEqual(
        expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'AUTH_SECRET', 'TURNSTILE_SECRET_KEY', 'SMS_PROVIDER']),
      );
    }
  });

  it('accepts the development stack pointing at a local MinIO', () => {
    const env = validateEnv({
      ...base,
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'abhyas-media',
      S3_ACCESS_KEY_ID: 'abhyas-dev',
      S3_SECRET_ACCESS_KEY: 'abhyas-dev-secret',
      S3_FORCE_PATH_STYLE: 'true',
    });

    expect(env.S3_ENDPOINT).toBe('http://minio:9000');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.S3_PUBLIC_READ).toBe(false);
  });

  it('allows the in-memory store for the database tests', () => {
    const env = validateEnv({
      ...base,
      S3_ENDPOINT: 'memory:',
      S3_BUCKET: 'abhyas-media',
      S3_ACCESS_KEY_ID: 'abhyas-dev',
      S3_SECRET_ACCESS_KEY: 'abhyas-dev-secret',
    });

    expect(env.S3_ENDPOINT).toBe('memory:');
  });

  it('refuses the in-memory store in production', () => {
    expect(() => validateEnv({ ...production, S3_ENDPOINT: 'memory:' })).toThrow(
      /S3_ENDPOINT: the in-memory store is refused in production/,
    );
  });

  it('requires an https S3 endpoint and its bucket in production', () => {
    expect(() => validateEnv({ ...production, S3_ENDPOINT: 'http://minio:9000' })).toThrow(
      /S3_ENDPOINT: must be an https endpoint in production/,
    );
    expect(() => validateEnv({ ...production, S3_ENDPOINT: '' })).toThrow(
      /S3_ENDPOINT: is required in production/,
    );
    expect(() => validateEnv({ ...production, S3_BUCKET: '' })).toThrow(
      /S3_BUCKET: is required in production/,
    );
  });

  it('refuses the development S3 credentials in production', () => {
    expect(() => validateEnv({ ...production, S3_ACCESS_KEY_ID: 'minioadmin' })).toThrow(
      /S3_ACCESS_KEY_ID: development credentials are refused in production/,
    );
    expect(() =>
      validateEnv({ ...production, S3_SECRET_ACCESS_KEY: 'abhyas-dev-secret-0123456789' }),
    ).toThrow(/S3_SECRET_ACCESS_KEY: must be at least 16 characters and not a development credential/);
  });

  it('refuses a public bucket in every environment', () => {
    expect(() => validateEnv({ ...base, S3_PUBLIC_READ: 'true' })).toThrow(
      /S3_PUBLIC_READ: a public bucket is refused/,
    );
  });

  it('refuses a half-configured store in development', () => {
    expect(() => validateEnv({ ...base, S3_ENDPOINT: 'http://minio:9000' })).toThrow(
      /S3_BUCKET: is required whenever S3_ENDPOINT is set/,
    );
  });
});
