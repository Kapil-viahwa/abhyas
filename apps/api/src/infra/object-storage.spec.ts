import { describe, expect, it } from 'vitest';

import type { AppEnv } from '@abhyas/shared';

import {
  DisabledObjectStorage,
  InMemoryObjectStorage,
  ObjectStorageUnavailableError,
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
    REVALIDATE_SECRET: 'dev-only-revalidate-secret',
    S3_ENDPOINT: '',
    S3_REGION: 'us-east-1',
    S3_BUCKET: '',
    S3_ACCESS_KEY_ID: '',
    S3_SECRET_ACCESS_KEY: '',
    S3_FORCE_PATH_STYLE: true,
    S3_PUBLIC_READ: false,
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
    await expect(storage.put(questionImageKey(), Buffer.from('x'), 'image/webp')).rejects.toThrow(
      ObjectStorageUnavailableError,
    );
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
    await storage.put(key, Buffer.from('bytes'), 'image/webp');

    expect((await storage.get(key)).toString()).toBe('bytes');
    await expect(storage.get(questionImageKey())).rejects.toThrow(ObjectStorageUnavailableError);
    expect(await storage.presignedGetUrl(key)).toMatch(/^memory:\/\/question-image\//);
  });
});
