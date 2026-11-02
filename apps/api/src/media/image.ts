import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Two limits live outside `sharp`'s per-call options because they are process-wide: the
// operation cache keeps decoded tiles after the request that needed them, and the thread
// count decides how far one decode may fan out. On the four-core VPS one thread per decode
// and no cache keeps the worst case (two 16-megapixel decodes) inside the container's
// memory; decision 0045 records the arithmetic.
sharp.cache(false);
sharp.concurrency(1);

/**
 * The one image pipeline. Every uploaded image passes through it, and so does every
 * image inside an import archive, so there is a single place that decides what is an
 * image and what the stored bytes look like.
 *
 * The type is decided by the first bytes of the file, never by the name or the declared
 * content type: a renamed executable is simply not an image. The image is then decoded
 * and re-encoded, which drops EXIF, appended payloads and anything else the original
 * container carried, and the stored object is always WebP.
 *
 * Decoding an untrusted file is the expensive and dangerous step, so it is bounded three
 * ways: a pixel limit (a decompression bomb is refused before it becomes memory), a
 * wall-clock limit (a decode that never finishes is abandoned), and a concurrency limit
 * (a burst of uploads cannot take every core and starve the rest of the API).
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_EDGE_PIXELS = 2000;
export const MAX_INPUT_PIXELS = 16_000_000;
export const OUTPUT_MIME_TYPE = 'image/webp';
export const OUTPUT_EXTENSION = 'webp';

/** A decode that runs longer than this is abandoned rather than allowed to finish. */
export const PROCESSING_TIMEOUT_MS = 10_000;

/** How many images may be decoded at the same time, whatever the request count. */
export const MAX_CONCURRENT_DECODES = 2;

/**
 * How many decodes may wait for a slot before the API answers "busy" instead of queueing.
 * A queue is memory that has not been taken yet, so it is bounded like everything else.
 */
export const MAX_QUEUED_DECODES = 20;

export type SniffedImageFormat = 'jpeg' | 'png' | 'webp';

export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

/**
 * The decode queue is full. Nothing is queued without limit: the request is refused with a
 * 503 and a `Retry-After`, which is honest about a server that is busy rather than silently
 * holding a promise that may never run.
 */
export class ImageQueueFullError extends Error {
  constructor(message = 'Too many images are waiting to be processed') {
    super(message);
    this.name = 'ImageQueueFullError';
  }
}

/**
 * The options every `sharp` call uses. `failOn: 'error'` makes a truncated stream an
 * error instead of a best-effort decode, and `animated: false` reads a single frame even
 * if a container somehow declares more (the frame count is rejected separately).
 */
const SHARP_INPUT_OPTIONS = {
  limitInputPixels: MAX_INPUT_PIXELS,
  failOn: 'error' as const,
  sequentialRead: true,
  animated: false,
};

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

/**
 * A counting semaphore over the decode. The queue sits above `sharp`, so the limit holds
 * for direct uploads and for the image entries of an import archive at the same time.
 *
 * A slot belongs to the decode itself, not to the caller waiting for it: `processImage`
 * gives up after the timeout, but the slot is released only when the native work settles,
 * so abandoning a decode never allows a second one to start beside it.
 */
export class DecodeLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number = MAX_CONCURRENT_DECODES,
    private readonly maxQueued: number = MAX_QUEUED_DECODES,
  ) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueued) {
        throw new ImageQueueFullError();
      }

      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }

    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next !== undefined) {
        next();
      }
    }
  }
}

export const imageLimiter = new DecodeLimiter();

const PNG_SIGNATURE_LENGTH = 8;
const PNG_CHUNK_HEADER = 8;
const PNG_CHUNK_OVERHEAD = 12;
const WEBP_RIFF_HEADER = 12;
const WEBP_CHUNK_HEADER = 8;

/**
 * An APNG is a PNG whose animation control chunk (`acTL`) comes before the first frame
 * (`IDAT`). Walking the chunks says exactly that; searching the bytes for "acTL" would also
 * match a text chunk or a comment that merely mentions it, and would let a real animation
 * through whenever the four bytes happened to be split across a chunk boundary.
 */
export function pngIsAnimated(bytes: Buffer): boolean {
  let offset = PNG_SIGNATURE_LENGTH;

  while (offset + PNG_CHUNK_HEADER <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);

    if (type === 'acTL') {
      return true;
    }
    // The animation control chunk must precede the first frame; once a frame is here,
    // nothing later can make this file an APNG.
    if (type === 'IDAT' || type === 'IEND') {
      return false;
    }
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return false;
    }

    offset += PNG_CHUNK_OVERHEAD + length;
  }

  return false;
}

/** A WebP is animated when its RIFF chunk list holds an `ANIM` or `ANMF` chunk. */
export function webpIsAnimated(bytes: Buffer): boolean {
  let offset = WEBP_RIFF_HEADER;

  while (offset + WEBP_CHUNK_HEADER <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);

    if (type === 'ANIM' || type === 'ANMF') {
      return true;
    }
    if (!/^[A-Za-z ]{4}$/.test(type)) {
      return false;
    }

    // RIFF chunks are padded to an even length.
    const padded = length + (length % 2);
    if (padded < 0 || offset + WEBP_CHUNK_HEADER + padded <= offset) {
      return false;
    }
    offset += WEBP_CHUNK_HEADER + padded;
  }

  return false;
}

/**
 * The container's own declaration, read before any of it is decoded.
 *
 * The chunk lists are parsed rather than scanned, so the decision follows the format and not
 * a coincidence of bytes. The rule is rejection, not flattening: a question image is one
 * still picture, and a container that describes more is not one.
 */
export function assertNotAnimatedContainer(bytes: Buffer, format: SniffedImageFormat): void {
  if (format === 'png' && pngIsAnimated(bytes)) {
    throw new ImageRejectedError('Animated images are not accepted');
  }
  if (format === 'webp' && webpIsAnimated(bytes)) {
    throw new ImageRejectedError('Animated images are not accepted');
  }
}

/**
 * One image is stored as one frame. A multi-frame container would let an upload become a
 * short video or blow up the stored size for the same declared dimensions, and a question
 * image has no use for frames.
 */
export function assertSingleFrame(pageCount: number | undefined): void {
  if (pageCount !== undefined && pageCount > 1) {
    throw new ImageRejectedError('Animated images are not accepted');
  }
}

/**
 * Abandons work that takes longer than the limit. The losing promise is still handled by
 * `Promise.race`, so an abandoned decode cannot raise an unhandled rejection later.
 */
export async function withProcessingTimeout<T>(work: Promise<T>, timeoutMs: number = PROCESSING_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ImageRejectedError('The image took too long to process'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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

  assertNotAnimatedContainer(input, format);

  const decode = async (): Promise<{ data: Buffer; info: { width: number; height: number } }> => {
    const metadata = await sharp(input, SHARP_INPUT_OPTIONS).metadata();
    if (metadata.format !== format) {
      // The bytes claim one container and decode as another: a polyglot, not an image.
      throw new ImageRejectedError('The image could not be decoded as its declared type');
    }
    assertSingleFrame(metadata.pages);

    // No `withMetadata()` call anywhere: the encoder writes a bare WebP, so EXIF,
    // ICC, IPTC and XMP from the upload never reach the stored object.
    return sharp(input, SHARP_INPUT_OPTIONS)
      .rotate()
      .resize({ width: MAX_EDGE_PIXELS, height: MAX_EDGE_PIXELS, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  };

  // The slot is taken around the decode, never around the wait: the timeout stops this
  // caller, and the native work keeps its slot until it has really finished.
  const decoding = imageLimiter.run(decode);

  let output: { data: Buffer; info: { width: number; height: number } };

  try {
    output = await withProcessingTimeout(decoding);
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
