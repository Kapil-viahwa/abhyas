import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * The one image pipeline. Every uploaded image passes through it, and so does every
 * image inside an import archive, so there is a single place that decides what is an
 * image and what the stored bytes look like.
 *
 * The type is decided by the first bytes of the file, never by the name or the declared
 * content type: a renamed executable is simply not an image. The image is then decoded
 * and re-encoded, which drops EXIF, appended payloads and anything else the original
 * container carried, and the stored object is always WebP.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_EDGE_PIXELS = 2000;
export const MAX_INPUT_PIXELS = 40_000_000;
export const OUTPUT_MIME_TYPE = 'image/webp';
export const OUTPUT_EXTENSION = 'webp';

export type SniffedImageFormat = 'jpeg' | 'png' | 'webp';

export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

/** Magic bytes, not extensions. SVG is text and is rejected along with everything else. */
export function sniffImage(bytes: Buffer): SniffedImageFormat | null {
  if (bytes.length < 12) {
    return null;
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }

  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  return null;
}

export interface ProcessedImage {
  readonly data: Buffer;
  readonly mimeType: typeof OUTPUT_MIME_TYPE;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length === 0) {
    throw new ImageRejectedError('The upload is empty');
  }
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new ImageRejectedError('Images must be 5 MB or smaller');
  }

  const format = sniffImage(input);
  if (format === null) {
    throw new ImageRejectedError('Only JPEG, PNG and WebP images are accepted');
  }

  let output: { data: Buffer; info: { width: number; height: number } };

  try {
    const metadata = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (metadata.format !== format) {
      // The bytes claim one container and decode as another: a polyglot, not an image.
      throw new ImageRejectedError('The image could not be decoded as its declared type');
    }

    output = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_EDGE_PIXELS, height: MAX_EDGE_PIXELS, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof ImageRejectedError) {
      throw error;
    }
    throw new ImageRejectedError('The image is corrupt or too large to decode');
  }

  if (output.info.width > MAX_EDGE_PIXELS || output.info.height > MAX_EDGE_PIXELS) {
    throw new ImageRejectedError(`Images are resized to ${MAX_EDGE_PIXELS}px on the longest edge`);
  }

  return {
    data: output.data,
    mimeType: OUTPUT_MIME_TYPE,
    width: output.info.width,
    height: output.info.height,
    checksumSha256: createHash('sha256').update(output.data).digest('hex'),
  };
}
