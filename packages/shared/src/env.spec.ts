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
    expect(() => validateEnv({ ...production, S3_SECRET_ACCESS_KEY: 'abhyas-dev' })).toThrow(
      /S3_SECRET_ACCESS_KEY: development credentials are refused in production/,
    );
    expect(() => validateEnv({ ...production, S3_SECRET_ACCESS_KEY: 'short' })).toThrow(
      /S3_SECRET_ACCESS_KEY: must be at least 16 characters/,
    );
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

/** A production environment that turns mobile OTP on through the generic gateway. */
const otpProduction = {
  ...production,
  SMS_PROVIDER: 'http',
  OTP_ENABLED: 'true',
  OTP_HMAC_SECRET: 'o'.repeat(48),
  OTP_SENDER_ID: 'ABHYAS',
  OTP_DLT_ENTITY_ID: '1000000000000000000',
  OTP_TEMPLATE_ID: '1107160000000000000',
  OTP_GATEWAY_URL: 'https://sms.example.com/send',
  OTP_GATEWAY_BODY_TEMPLATE: '{"to":"{{to}}","message":"{{body}}","template":"{{templateId}}"}',
};

describe('validateEnv and the OTP master switch', () => {
  it('keeps mobile OTP off unless it is asked for', () => {
    const env = validateEnv(base);

    expect(env.OTP_ENABLED).toBe(false);
    expect(env.OTP_ALLOWED_COUNTRY_CODES).toEqual(['+91']);
    expect(env.OTP_SMS_DAILY_BUDGET).toBe(100);
    // Off is not the same as absent: the boundaries are still present and bounded.
    expect(env.OTP_GATEWAY_TIMEOUT_MS).toBe(5000);
  });

  it('accepts an OTP-enabled development configuration with the fake provider', () => {
    const env = validateEnv({ ...base, OTP_ENABLED: 'true', OTP_HMAC_SECRET: 'h'.repeat(32), SMS_PROVIDER: 'fake' });

    expect(env.OTP_ENABLED).toBe(true);
    expect(env.SMS_PROVIDER).toBe('fake');
  });

  it('requires an HMAC secret whenever OTP is on', () => {
    expect(() => validateEnv({ ...base, OTP_ENABLED: 'true' })).toThrow(
      /OTP_HMAC_SECRET: is required when OTP_ENABLED is true/,
    );
    expect(() => validateEnv({ ...otpProduction, OTP_HMAC_SECRET: 'short' })).toThrow(
      /OTP_HMAC_SECRET: must be at least 32 characters in production/,
    );
    expect(() =>
      validateEnv({ ...otpProduction, OTP_HMAC_SECRET: 'dev-only-insecure-secret-please-change-32chars' }),
    ).toThrow(/OTP_HMAC_SECRET: must not be a well-known default value/);
  });

  it('refuses the fake provider for an OTP-enabled production boot', () => {
    // The fake provider already refuses itself; the environment refuses first, so the
    // process never even reaches the constructor.
    expect(() => validateEnv({ ...otpProduction, SMS_PROVIDER: 'fake' })).toThrow(
      /SMS_PROVIDER: fake and console SMS providers are refused in production/,
    );
    expect(() => validateEnv({ ...otpProduction, SMS_PROVIDER: 'console' })).toThrow(
      /SMS_PROVIDER: fake and console SMS providers are refused in production/,
    );
  });

  it('refuses a provider with no adapter for an OTP-enabled production boot', () => {
    expect(() => validateEnv({ ...otpProduction, SMS_PROVIDER: 'msg91' })).toThrow(
      /SMS_PROVIDER: must be "http" when OTP_ENABLED is true in production/,
    );
  });

  it('requires the sender id, DLT entity id and template id in production', () => {
    expect(() => validateEnv({ ...otpProduction, OTP_SENDER_ID: '' })).toThrow(
      /OTP_SENDER_ID: is required in production when OTP is enabled/,
    );
    expect(() => validateEnv({ ...otpProduction, OTP_DLT_ENTITY_ID: '' })).toThrow(
      /OTP_DLT_ENTITY_ID: is required in production when OTP is enabled/,
    );
    expect(() => validateEnv({ ...otpProduction, OTP_TEMPLATE_ID: '' })).toThrow(
      /OTP_TEMPLATE_ID: is required in production when OTP is enabled/,
    );
  });

  it('requires an https gateway and its body template for the generic adapter', () => {
    expect(() => validateEnv({ ...otpProduction, OTP_GATEWAY_URL: '' })).toThrow(
      /OTP_GATEWAY_URL: is required when SMS_PROVIDER is http/,
    );
    expect(() => validateEnv({ ...otpProduction, OTP_GATEWAY_URL: 'http://sms.example.com/send' })).toThrow(
      /OTP_GATEWAY_URL: must be an https URL in production/,
    );
    expect(() => validateEnv({ ...otpProduction, OTP_GATEWAY_BODY_TEMPLATE: '' })).toThrow(
      /OTP_GATEWAY_BODY_TEMPLATE: is required when SMS_PROVIDER is http/,
    );
  });

  it('refuses a country prefix that is not E.164', () => {
    expect(() => validateEnv({ ...base, OTP_ALLOWED_COUNTRY_CODES: '91' })).toThrow(
      /OTP_ALLOWED_COUNTRY_CODES: "91" is not an E.164 country prefix/,
    );
    expect(() => validateEnv({ ...base, OTP_ALLOWED_COUNTRY_CODES: ' , ' })).toThrow(
      /OTP_ALLOWED_COUNTRY_CODES: must name at least one country prefix/,
    );
  });

  it('bounds the timeout and the daily budget', () => {
    expect(() => validateEnv({ ...base, OTP_GATEWAY_TIMEOUT_MS: '10' })).toThrow(
      /OTP_GATEWAY_TIMEOUT_MS: must be an integer between 1000 and 30000/,
    );
    expect(() => validateEnv({ ...base, OTP_SMS_DAILY_BUDGET: '0' })).toThrow(
      /OTP_SMS_DAILY_BUDGET: must be an integer between 1 and 100000/,
    );
  });
});


/**
 * The fixed code exists so a browser test can type a code it already knows. It is a
 * development shortcut in the strictest sense: it must be impossible to turn on where a
 * real message could go out, and the boot refusal is the proof (decision 0051).
 */
describe('the fixed OTP code', () => {
  const fakeOtp = {
    ...base,
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    SMS_PROVIDER: 'fake',
    OTP_ENABLED: 'true',
    OTP_HMAC_SECRET: 'h'.repeat(32),
    OTP_TEMPLATE_ID: 'TPL-DEV',
  };

  it('is accepted with the fake provider outside production', () => {
    const env = validateEnv({ ...fakeOtp, OTP_FAKE_FIXED_CODE: '123456' });

    expect(env.OTP_FAKE_FIXED_CODE).toBe('123456');
    expect(env.SMS_PROVIDER).toBe('fake');
  });

  it('is empty when it is not asked for, so codes stay random', () => {
    expect(validateEnv(fakeOtp).OTP_FAKE_FIXED_CODE).toBe('');
  });

  it('is refused in production, and the fake provider with it', () => {
    expect(() =>
      validateEnv({
        ...production,
        OTP_ENABLED: 'true',
        OTP_HMAC_SECRET: 'h'.repeat(32),
        OTP_SENDER_ID: 'ABHYAS',
        OTP_DLT_ENTITY_ID: '1201159000000000000',
        OTP_TEMPLATE_ID: 'TPL-LIVE',
        SMS_PROVIDER: 'http',
        OTP_GATEWAY_URL: 'https://sms.example.com/send',
        OTP_GATEWAY_BODY_TEMPLATE: '{"to":"{{to}}","body":"{{body}}"}',
        OTP_FAKE_FIXED_CODE: '123456',
      }),
    ).toThrow(/OTP_FAKE_FIXED_CODE: is refused in production/);

    expect(() => validateEnv({ ...production, SMS_PROVIDER: 'fake', OTP_FAKE_FIXED_CODE: '123456' })).toThrow(
      /SMS_PROVIDER: fake and console SMS providers are refused in production/,
    );
  });

  it('is refused with a provider that would really send, and when it is not six digits', () => {
    expect(() => validateEnv({ ...fakeOtp, SMS_PROVIDER: 'msg91', OTP_FAKE_FIXED_CODE: '123456' })).toThrow(
      /OTP_FAKE_FIXED_CODE: may only be set while SMS_PROVIDER is fake/,
    );
    expect(() => validateEnv({ ...fakeOtp, OTP_FAKE_FIXED_CODE: '12345' })).toThrow(
      /OTP_FAKE_FIXED_CODE: must be six digits/,
    );
    expect(() => validateEnv({ ...fakeOtp, OTP_FAKE_FIXED_CODE: 'abcdef' })).toThrow(
      /OTP_FAKE_FIXED_CODE: must be six digits/,
    );
  });
});
