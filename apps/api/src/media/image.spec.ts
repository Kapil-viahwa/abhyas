import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  ImageRejectedError,
  MAX_EDGE_PIXELS,
  MAX_UPLOAD_BYTES,
  processImage,
  sniffImage,
} from './image';

async function png(width = 40, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 80, b: 160 } } })
    .png()
    .toBuffer();
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
});
