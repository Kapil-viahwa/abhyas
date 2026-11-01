import { describe, expect, it } from 'vitest';

import { EnvValidationError } from '@abhyas/shared';

import { loadConfig } from './config';

const productionEnv = {
  NODE_ENV: 'production',
  PORT: '3001',
  DATABASE_URL: 'postgresql://abhyas:secret@postgres:5432/abhyas',
  REDIS_URL: 'redis://redis:6379',
  AUTH_SECRET: 'b'.repeat(48),
  TURNSTILE_SECRET_KEY: 'live-turnstile-secret',
  SMS_PROVIDER: 'msg91',
};

describe('loadConfig', () => {
  it('boots a complete production configuration', () => {
    const config = loadConfig(productionEnv);

    expect(config.NODE_ENV).toBe('production');
    expect(config.PORT).toBe(3001);
  });

  it('refuses to boot in production with development shortcuts', () => {
    expect(() =>
      loadConfig({
        ...productionEnv,
        TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        SMS_PROVIDER: 'fake',
        ALLOW_DEV_LOGIN: 'true',
      }),
    ).toThrow(EnvValidationError);
  });

  it('names every offending variable when it refuses to boot', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      throw new Error('expected loadConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const variables = (error as EnvValidationError).issues.map((issue) => issue.variable);
      expect(variables).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'REDIS_URL',
          'AUTH_SECRET',
          'TURNSTILE_SECRET_KEY',
          'SMS_PROVIDER',
        ]),
      );
    }
  });
});
