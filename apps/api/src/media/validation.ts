import { BadRequestException } from '@nestjs/common';

import { MAX_UPLOAD_BYTES } from './image';

/**
 * The upload body is JSON with a base64 payload rather than a multipart form: it needs no
 * multipart parser, and the browser resizes before sending, so a 5 MB cap is generous.
 */
export interface ImageUploadInput {
  readonly dataBase64: string;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }
  return body as Record<string, unknown>;
}

export function parseImageUploadBody(body: unknown): ImageUploadInput {
  const record = asRecord(body);
  const raw = record.dataBase64;

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new BadRequestException('dataBase64 is required');
  }

  const value = raw.trim();
  // Base64 is 4/3 of the payload; refuse an over-long string before decoding it.
  if (value.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 8) {
    throw new BadRequestException('Images must be 5 MB or smaller');
  }

  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) {
    throw new BadRequestException('dataBase64 is not valid base64');
  }

  return { dataBase64: value.replace(/\s+/g, '') };
}
