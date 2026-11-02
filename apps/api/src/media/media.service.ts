import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { loadConfig } from '../config/config';
import { DatabaseService } from '../infra/database.service';
import {
  OBJECT_STORAGE,
  ObjectStorageUnavailableError,
  PRESIGNED_URL_TTL_SECONDS,
  questionImageKey,
  type ObjectStorage,
} from '../infra/object-storage';
import { DATABASE_PROBE } from '../infra/tokens';
import { ImageQueueFullError, ImageRejectedError, processImage, type ProcessedImage } from './image';
import { parseImageUploadBody } from './validation';

export interface MediaAssetResult {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly createdAt: string;
}

export interface SignedUrlResult {
  readonly url: string;
  readonly expiresInSeconds: number;
}

/**
 * Images for question authoring.
 *
 * Nothing user-supplied reaches the store: the key is generated, the bytes are decoded
 * and re-encoded by `processImage`, and the row records what was actually written. The
 * bucket is private, so the only way out is a presigned URL, and only the person who
 * uploaded the image (or an administrator) can ask for one.
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private readonly logger = new Logger(MediaService.name);
  private readonly bucket: string;
  private readonly ensureAtBoot: boolean;

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    const config = loadConfig(process.env);
    this.bucket = config.S3_BUCKET;
    // Development and CI create their own bucket; production's is provisioned outside.
    this.ensureAtBoot = config.NODE_ENV !== 'production' && config.S3_ENDPOINT !== '';
  }

  private get prisma() {
    return this.database.prisma;
  }

  async onModuleInit(): Promise<void> {
    if (!this.ensureAtBoot) {
      return;
    }

    try {
      await this.storage.ensureBucket();
      this.logger.log(`Object storage ready (${this.bucket})`);
    } catch (error) {
      // A missing bucket must not take the API down: uploads answer 503 until it exists.
      this.logger.warn(
        `Could not prepare the object storage bucket: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async upload(actor: AuthenticatedUser, body: unknown, meta: RequestMetadata = {}): Promise<MediaAssetResult> {
    const input = parseImageUploadBody(body);

    let processed: ProcessedImage;
    try {
      processed = await processImage(Buffer.from(input.dataBase64, 'base64'));
    } catch (error) {
      if (error instanceof ImageQueueFullError) {
        // The decode queue is bounded, so a burst is refused rather than queued for ever.
        throw new ServiceUnavailableException('Image processing is busy. Please try again.');
      }
      if (error instanceof ImageRejectedError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const key = questionImageKey();

    try {
      await this.storage.put(key, processed.data);
    } catch (error) {
      this.logger.error(`Object storage refused an upload: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException('Image storage is unavailable. Please try again.');
    }

    const asset = await this.prisma.$transaction(async (tx) => {
      const created = await tx.mediaAsset.create({
        data: {
          bucket: this.bucket === '' ? 'unconfigured' : this.bucket,
          objectKey: key,
          mimeType: processed.mimeType,
          byteSize: processed.data.length,
          width: processed.width,
          height: processed.height,
          checksumSha256: createHash('sha256').update(processed.data).digest('hex'),
          uploadedBy: actor.id,
        },
        select: { id: true, width: true, height: true, byteSize: true, createdAt: true },
      });

      await writeIdentityAudit(tx, {
        action: 'MEDIA_UPLOADED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'media_asset',
        entityId: created.id,
        metadata: { objectKey: key, byteSize: created.byteSize },
        ip: meta.ip ?? null,
      });

      return created;
    });

    return {
      id: asset.id,
      width: asset.width,
      height: asset.height,
      byteSize: asset.byteSize,
      createdAt: asset.createdAt.toISOString(),
    };
  }

  async signedUrl(actor: AuthenticatedUser, id: string): Promise<SignedUrlResult> {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id },
      select: { id: true, objectKey: true, uploadedBy: true },
    });

    // An image somebody else uploaded is reported as missing, not as forbidden: an
    // editor cannot use this route to discover which ids exist.
    if (!asset || (actor.roleCode !== 'ADMIN' && asset.uploadedBy !== actor.id)) {
      throw new NotFoundException('Unknown image');
    }

    try {
      const url = await this.storage.presignedGetUrl(asset.objectKey);
      return { url, expiresInSeconds: PRESIGNED_URL_TTL_SECONDS };
    } catch (error) {
      if (error instanceof ObjectStorageUnavailableError) {
        throw new ServiceUnavailableException('Image storage is unavailable. Please try again.');
      }
      throw error;
    }
  }
}
