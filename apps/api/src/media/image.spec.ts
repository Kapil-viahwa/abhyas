import { deflateSync } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  DecodeLimiter,
  ImageRejectedError,
  MAX_CONCURRENT_DECODES,
  MAX_EDGE_PIXELS,
  MAX_INPUT_PIXELS,
  MAX_UPLOAD_BYTES,
  assertSingleFrame,
  processImage,
  sniffImage,
  withProcessingTimeout,
} from './image';

async function png(width = 40, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 80, b: 160 } } })
    .png()
    .toBuffer();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * A real PNG header that declares a huge canvas while the file itself stays a few
 * kilobytes: a one-bit greyscale image whose pixel rows deflate almost to nothing. This
 * is the decompression bomb the pixel limit exists to refuse.
 */
function bombPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // bit depth: one bit per pixel
  header[9] = 0; // greyscale
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Every row is a filter byte followed by ceil(width / 8) bytes of zeroes.
  const rowBytes = Math.ceil(width / 8) + 1;
  const pixels = deflateSync(Buffer.alloc(rowBytes * height));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', pixels),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A two-frame GIF: the smallest genuinely animated container, made by hand. */
function animatedGif(): Buffer {
  const header = Buffer.from('GIF89a', 'ascii');
  const screen = Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
  const palette = Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00]);
  const graphicControl = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]);
  const imageDescriptor = Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const imageData = Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]);
  const trailer = Buffer.from([0x3b]);

  return Buffer.concat([
    header,
    screen,
    palette,
    graphicControl,
    imageDescriptor,
    imageData,
    graphicControl,
    imageDescriptor,
    imageData,
    trailer,
  ]);
}

describe('image pipeline', () => {
  it('decides the type from the first bytes, not the name', async () => {
    const bytes = await png();
    expect(sniffImage(bytes)).toBe('png');

    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    expect(sniffImage(jpeg)).toBe('jpeg');

    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .webp()
      .toBuffer();
    expect(sniffImage(webp)).toBe('webp');
  });

  it('refuses an executable that was renamed to .png', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2048, 0x90)]);

    await expect(processImage(exe)).rejects.toThrow(ImageRejectedError);
    await expect(processImage(exe)).rejects.toThrow(/Only JPEG, PNG and WebP/);
  });

  it('refuses an SVG, which is text and can carry script', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    );

    await expect(processImage(svg)).rejects.toThrow(/Only JPEG, PNG and WebP/);
  });

  it('strips an appended payload by re-encoding, so a polyglot becomes a plain image', async () => {
    const payload = Buffer.from('PK\x03\x04 hidden archive payload', 'binary');
    const polyglot = Buffer.concat([await png(), payload]);

    const processed = await processImage(polyglot);

    expect(processed.mimeType).toBe('image/webp');
    expect(processed.data.includes(payload)).toBe(false);
    expect(processed.data.includes(Buffer.from('PK\x03\x04', 'binary'))).toBe(false);
  });

  it('refuses an oversized file before decoding it', async () => {
    const oversized = Buffer.concat([await png(), Buffer.alloc(MAX_UPLOAD_BYTES)]);

    await expect(processImage(oversized)).rejects.toThrow(/5 MB or smaller/);
  });

  it('refuses a corrupt image that has the right magic bytes', async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 0x00),
    ]);

    await expect(processImage(corrupt)).rejects.toThrow(ImageRejectedError);
  });

  it('caps the longest edge and reports the stored dimensions', async () => {
    const wide = await sharp({ create: { width: 4000, height: 40, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();

    const processed = await processImage(wide);

    expect(processed.width).toBeLessThanOrEqual(MAX_EDGE_PIXELS);
    expect(processed.height).toBeLessThanOrEqual(MAX_EDGE_PIXELS);
    expect(processed.width).toBe(MAX_EDGE_PIXELS);
    expect(processed.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a decompression bomb: a few kilobytes that declare 64 megapixels', async () => {
    const bomb = bombPng(8000, 8000);

    // The file is tiny because the pixels are uniform; the canvas is not.
    expect(bomb.length).toBeLessThan(200_000);

    await expect(processImage(bomb)).rejects.toThrow(/corrupt or too large to decode/);
  });

  it('refuses a truncated image rather than decoding what is left', async () => {
    const full = await png(200, 150);
    const truncated = full.subarray(0, Math.floor(full.length / 2));

    await expect(processImage(truncated)).rejects.toThrow(ImageRejectedError);
  });

  it('refuses a genuinely animated container', async () => {
    const gif = animatedGif();

    // The fixture is animated: sharp itself counts the two frames.
    const metadata = await sharp(gif, { animated: true }).metadata();
    expect(metadata.pages).toBe(2);

    // GIF is not one of the accepted types, so it never reaches the decoder at all.
    await expect(processImage(gif)).rejects.toThrow(/Only JPEG, PNG and WebP/);
  });

  it('refuses a multi-frame image instead of quietly storing one frame of it', () => {
    expect(() => assertSingleFrame(undefined)).not.toThrow();
    expect(() => assertSingleFrame(1)).not.toThrow();
    expect(() => assertSingleFrame(2)).toThrow(/Animated images are not accepted/);
  });

  it('writes a bare WebP with no EXIF, ICC, IPTC or XMP', async () => {
    const processed = await processImage(await png(120, 90));
    const metadata = await sharp(processed.data).metadata();

    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.iptc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it('abandons a decode that runs past the limit', async () => {
    const never = new Promise<never>(() => undefined);

    await expect(withProcessingTimeout(never, 5)).rejects.toThrow(/took too long to process/);
  });

  it('leaves a decode that finishes in time alone', async () => {
    await expect(withProcessingTimeout(Promise.resolve('done'), 5_000)).resolves.toBe('done');
  });

  it('bounds how many images decode at the same time', async () => {
    const limiter = new DecodeLimiter(2);
    let active = 0;
    let peak = 0;

    const work = Array.from({ length: 8 }, () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }),
    );

    await Promise.all(work);

    expect(peak).toBe(2);
    expect(limiter.running).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it('keeps the slot of an abandoned decode until the real work settles', async () => {
    const limiter = new DecodeLimiter(1);
    let release: () => void = () => undefined;

    const decode = limiter.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('late');
        }),
    );

    // The caller stops waiting after 5ms, exactly as `processImage` does after its own
    // timeout, but the decode inside sharp is still running and still uses memory.
    await expect(withProcessingTimeout(decode, 5)).rejects.toThrow(/took too long/);

    expect(limiter.running).toBe(1);

    // A second upload queues behind it: the abandoned decode did not hand its slot over.
    let secondStarted = false;
    const second = limiter.run(async () => {
      secondStarted = true;
      return 'second';
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondStarted).toBe(false);
    expect(limiter.queued).toBe(1);

    release();
    await expect(decode).resolves.toBe('late');
    await expect(second).resolves.toBe('second');
    expect(secondStarted).toBe(true);
    expect(limiter.running).toBe(0);
  });

  it('refuses an animated PNG: a PNG container that declares an animation', async () => {
    const still = await png(40, 30);
    // The signature and the IHDR chunk are 8 + 25 bytes; an APNG declares its animation
    // in an acTL chunk that must precede the first frame.
    const ihdrEnd = 8 + 25;
    const acTl = pngChunk('acTL', Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00]));
    const apng = Buffer.concat([still.subarray(0, ihdrEnd), acTl, still.subarray(ihdrEnd)]);

    expect(sniffImage(apng)).toBe('png');
    await expect(processImage(apng)).rejects.toThrow(/Animated images are not accepted/);
  });

  it('refuses a real animated WebP, not just a container that calls itself one', async () => {
    const animatedWebp = await sharp(animatedGif(), { animated: true }).webp({ loop: 0 }).toBuffer();

    // The fixture is genuinely animated before the pipeline is asked about it.
    const metadata = await sharp(animatedWebp, { animated: true }).metadata();
    expect(metadata.pages ?? 1).toBeGreaterThan(1);

    expect(sniffImage(animatedWebp)).toBe('webp');
    await expect(processImage(animatedWebp)).rejects.toThrow(/Animated images are not accepted/);
  });

  it('keeps the decode budget small enough for one small VPS', () => {
    // 16 megapixels at 4 bytes per pixel is 64 MB per decode; two decodes and no cache
    // stays inside the container's memory (decision 0045).
    expect(MAX_INPUT_PIXELS).toBe(16_000_000);
    expect(MAX_CONCURRENT_DECODES).toBe(2);
  });
});
