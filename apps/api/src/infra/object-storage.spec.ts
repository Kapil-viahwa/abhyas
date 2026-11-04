import { describe, expect, it } from 'vitest';

import type { AppEnv } from '@abhyas/shared';

import {
  DisabledObjectStorage,
  InMemoryObjectStorage,
  MEDIA_CACHE_CONTROL,
  MEDIA_CONTENT_TYPE,
  ObjectStorageUnavailableError,
  PRESIGNED_URL_TTL_SECONDS,
  SIGNED_URL_CACHE_CONTROL,
  S3ObjectStorage,
  createObjectStorage,
  isQuestionImageKey,
  questionImageKey,
} from './object-storage';

function config(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    NODE_ENV: 'development',
    PORT: 3001,
    DATABASE_URL: 'postgresql://abhyas_app:abhyas_app@localhost:5432/abhyas',
    REDIS_URL: 'redis://localhost:6379',
    AUTH_SECRET: '',
    TURNSTILE_SECRET_KEY: '',
    SMS_PROVIDER: 'fake',
    EMAIL_PROVIDER: 'console',
    ALLOW_DEV_LOGIN: true,
    TRUST_PROXY: false,
    TRUST_CLIENT_IP_HEADER: 'x-real-ip',
    TRUST_FORWARDED_IP_FOR_TESTS: false,
    REVALIDATE_SECRET: 'dev-only-revalidate-secret',
    S3_ENDPOINT: '',
    S3_REGION: 'us-east-1',
    S3_BUCKET: '',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    S3_FORCE_PATH_STYLE: true,
    S3_PUBLIC_READ: false,
    OTP_ENABLED: false,
    OTP_HMAC_SECRET: '',
    OTP_ALLOWED_COUNTRY_CODES: ['+91'],
    OTP_SMS_DAILY_BUDGET: 100,
    OTP_SENDER_ID: '',
    OTP_DLT_ENTITY_ID: '',
    OTP_TEMPLATE_ID: '',
    OTP_FAKE_FIXED_CODE: '',
    OTP_GATEWAY_URL: '',
    OTP_GATEWAY_AUTH_HEADER: '',
    OTP_GATEWAY_AUTH_VALUE: '',
    OTP_GATEWAY_BODY_TEMPLATE: '',
    OTP_GATEWAY_TIMEOUT_MS: 5000,
    ...overrides,
  };
}

describe('object storage', () => {
  it('generates keys in the one shape the database accepts', () => {
    const key = questionImageKey();

    expect(isQuestionImageKey(key)).toBe(true);
    expect(key).toMatch(/^question-image\/[0-9a-f-]{36}\.webp$/);
    expect(questionImageKey()).not.toBe(key);
  });

  it('refuses a key that is not one of ours, so a supplied name cannot pass a CHECK', () => {
    expect(isQuestionImageKey('question-image/../../etc/passwd')).toBe(false);
    expect(isQuestionImageKey('question-image/photo of me.png')).toBe(false);
    expect(isQuestionImageKey('avatars/1234.webp')).toBe(false);
  });

  it('is disabled, not pretending, when development names no store', async () => {
    const storage = createObjectStorage(config());

    expect(storage).toBeInstanceOf(DisabledObjectStorage);
    await expect(storage.put(questionImageKey(), Buffer.from('x'))).rejects.toThrow(ObjectStorageUnavailableError);
    await expect(storage.presignedGetUrl('question-image/elsewhere.webp')).rejects.toThrow(/not configured/);
    await expect(storage.ensureBucket()).rejects.toThrow(ObjectStorageUnavailableError);
  });

  it('builds a real client when an endpoint is named', () => {
    const storage = createObjectStorage(
      config({ S3_ENDPOINT: 'http://minio:9000', S3_BUCKET: 'abhyas-media', S3_ACCESS_KEY_ID: 'abhyas-dev', S3_SECRET_ACCESS_KEY: 'abhyas-dev-secret' }),
    );

    expect(storage).toBeInstanceOf(S3ObjectStorage);
  });

  it('keeps the in-memory store honest about missing keys', async () => {
    const storage = createObjectStorage(
      config({ S3_ENDPOINT: 'memory:', S3_BUCKET: 'abhyas-media', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' }),
    );

    expect(storage).toBeInstanceOf(InMemoryObjectStorage);

    const key = questionImageKey();
    await storage.put(key, Buffer.from('bytes'));

    expect((await storage.get(key)).toString()).toBe('bytes');
    await expect(storage.get(questionImageKey())).rejects.toThrow(ObjectStorageUnavailableError);
    expect(await storage.presignedGetUrl(key)).toMatch(/^memory:\/\/question-image\//);
  });

  it('signs a five-minute URL whose expiry and signature are in the query string', async () => {
    expect(PRESIGNED_URL_TTL_SECONDS).toBe(5 * 60);

    const storage = createObjectStorage(
      config({
        S3_ENDPOINT: 'https://storage.example.com',
        S3_BUCKET: 'abhyas-media',
        S3_ACCESS_KEY_ID: 'live-access-key',
        S3_SECRET_ACCESS_KEY: 'live-secret-value-0123456789',
        S3_FORCE_PATH_STYLE: false,
      }),
    );

    const key = questionImageKey();
    const url = new URL(await storage.presignedGetUrl(key));

    // The key is ours, and the only way in is the signature.
    expect(url.pathname).toContain(key);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('live-access-key');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');

    // The store is told what the object is and how it may be cached, so a proxy cannot
    // decide either. Both are private and short; neither is a bucket-wide setting.
    expect(url.searchParams.get('response-content-type')).toBe('image/webp');
    expect(url.searchParams.get('response-cache-control')).toBe('private, max-age=300');
  });

  it('writes every object as WebP with a private cache rule', () => {
    // The pipeline writes WebP only, so the store's content type is a constant, not a
    // parameter a caller could set to something else.
    expect(MEDIA_CONTENT_TYPE).toBe('image/webp');
    expect(MEDIA_CACHE_CONTROL.startsWith('private')).toBe(true);
    expect(SIGNED_URL_CACHE_CONTROL).toBe(MEDIA_CACHE_CONTROL);
  });
});
