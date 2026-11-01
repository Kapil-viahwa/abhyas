import { BadRequestException } from '@nestjs/common';

import { passwordIssues } from './password';

/**
 * Hand-rolled validation rather than a validation library: every rule here is a
 * sentence the student reads, and an added dependency would have to earn its place
 * in docs/decisions.md. Nothing is coerced: an unexpected type is a 400, never a
 * quiet conversion.
 */

export const MIN_FULL_NAME_LENGTH = 2;
export const MAX_FULL_NAME_LENGTH = 80;
export const MAX_EMAIL_LENGTH = 254;

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }
  return body as Record<string, unknown>;
}

export function parseEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Enter a valid email address');
  }

  const email = value.trim().toLowerCase();
  if (email === '' || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new BadRequestException('Enter a valid email address');
  }

  return email;
}

export function parseFullName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Enter your full name');
  }

  const name = value.trim().replace(/\s+/g, ' ');
  if (
    name.length < MIN_FULL_NAME_LENGTH ||
    name.length > MAX_FULL_NAME_LENGTH ||
    CONTROL_CHARACTERS.test(name)
  ) {
    throw new BadRequestException(
      `Enter your full name (${MIN_FULL_NAME_LENGTH}-${MAX_FULL_NAME_LENGTH} characters)`,
    );
  }

  return name;
}

export function parsePassword(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Enter a password');
  }

  const [first] = passwordIssues(value);
  if (first !== undefined) {
    throw new BadRequestException(`Password ${first}`);
  }

  return value;
}

export function parseTurnstileToken(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException('Human verification is required');
  }
  return value.trim();
}

export function parseEmailToken(body: unknown): string {
  const token = asRecord(body).token;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new BadRequestException('A verification token is required');
  }
  return token.trim();
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
  readonly turnstileToken: string;
}

export function parseRegisterBody(body: unknown): RegisterInput {
  const record = asRecord(body);

  return {
    email: parseEmail(record.email),
    password: parsePassword(record.password),
    fullName: parseFullName(record.fullName),
    turnstileToken: parseTurnstileToken(record.turnstileToken),
  };
}
