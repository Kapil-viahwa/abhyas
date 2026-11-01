import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';

import type { AppEnv } from '@abhyas/shared';

/**
 * Object storage, behind one interface.
 *
 * The bucket is private: nothing here can produce a permanent address, only a presigned
 * URL with a short life. Keys are generated from a UUID, so a user-supplied file name can
 * never reach the store. Production configuration is validated by `validateEnv` (https
 * endpoint, no development credentials, no public bucket) before this module is built.
 */
export const OBJECT_STORAGE = 'OBJECT_STORAGE';

/** The only kind of object the platform stores today. */
export const QUESTION_IMAGE_PREFIX = 'question-image';

export const PRESIGNED_URL_TTL_SECONDS = 5 * 60;

export class ObjectStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStorageUnavailableError';
  }
}

export interface ObjectStorage {
  /** Creates the bucket when it is missing. Development and CI only. */
  ensureBucket(): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  presignedGetUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

/** A generated key, in the one shape the `media_assets` CHECK accepts. */
export function questionImageKey(): string {
  return `${QUESTION_IMAGE_PREFIX}/${randomUUID()}.webp`;
}

export function isQuestionImageKey(key: string): boolean {
  return /^question-image\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/.test(key);
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: AppEnv) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // No ACL is set on purpose: the bucket is private and policy decides access.
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = response.Body;
    if (body === undefined) {
      throw new ObjectStorageUnavailableError('The object is missing from storage');
    }
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignedGetUrl(key: string, expiresInSeconds = PRESIGNED_URL_TTL_SECONDS): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}

/**
 * What a development machine gets when it names no store. Uploads fail with a clear
 * 503 instead of pretending to work, and nothing is written anywhere.
 */
export class DisabledObjectStorage implements ObjectStorage {
  async ensureBucket(): Promise<void> {
    throw new ObjectStorageUnavailableError('Object storage is not configured (S3_ENDPOINT is empty)');
  }

  async put(): Promise<void> {
    throw new ObjectStorageUnavailableError('Object storage is not configured (S3_ENDPOINT is empty)');
  }

  async get(): Promise<Buffer> {
    throw new ObjectStorageUnavailableError('Object storage is not configured (S3_ENDPOINT is empty)');
  }

  async remove(): Promise<void> {
    throw new ObjectStorageUnavailableError('Object storage is not configured (S3_ENDPOINT is empty)');
  }

  async presignedGetUrl(): Promise<string> {
    throw new ObjectStorageUnavailableError('Object storage is not configured (S3_ENDPOINT is empty)');
  }
}

/**
 * `S3_ENDPOINT=memory:` — the database test job has no object store, and this is the one
 * stand-in the platform allows. `validateEnv` refuses it in production, and it is named
 * like a protocol rather than accepted as a host so it cannot be mistaken for one.
 */
export const MEMORY_ENDPOINT = 'memory:';

export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Buffer>();

  async ensureBucket(): Promise<void> {
    // Nothing to create: the map is the bucket.
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (value === undefined) {
      throw new ObjectStorageUnavailableError('The object is missing from memory storage');
    }
    return value;
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async presignedGetUrl(key: string, expiresInSeconds = PRESIGNED_URL_TTL_SECONDS): Promise<string> {
    if (!this.objects.has(key)) {
      throw new ObjectStorageUnavailableError('The object is missing from memory storage');
    }
    return `memory://${key}?expires=${String(expiresInSeconds)}`;
  }
}

export function createObjectStorage(config: AppEnv): ObjectStorage {
  if (config.S3_ENDPOINT === MEMORY_ENDPOINT) {
    return new InMemoryObjectStorage();
  }

  if (config.S3_ENDPOINT === '') {
    // validateEnv refuses this in production, so reaching it means development or test.
    return new DisabledObjectStorage();
  }

  return new S3ObjectStorage(config);
}
