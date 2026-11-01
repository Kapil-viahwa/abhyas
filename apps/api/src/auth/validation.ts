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

/** Control characters are invisible in a name and a classic log-injection trick. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

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
    hasControlCharacter(name)
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

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /**
   * Optional, and only enforced once the account has too many recent failures. The
   * sign-in form sends it every time; an API client that skipped it is asked for it
   * when the throttle demands one (see AuthService.login).
   */
  readonly turnstileToken?: string | undefined;
}

export function parseLoginBody(body: unknown): LoginInput {
  const record = asRecord(body);
  const password = record.password;

  // The policy is deliberately not re-checked here: a sign-in must not explain
  // which passwords are acceptable, and an old account may hold any value.
  if (typeof password !== 'string' || password === '') {
    throw new BadRequestException('Enter your password');
  }

  return {
    email: parseEmail(record.email),
    password,
    turnstileToken: parseOptionalTurnstileToken(record.turnstileToken),
  };
}

/** An empty or absent token means "none offered", never "empty string is fine". */
function parseOptionalTurnstileToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path ids are checked before they reach the database, so a typo is a 400, not a 500. */
export function parseUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException(`Enter a valid ${label}`);
  }
  return value.trim();
}

export function parseRefreshBody(body: unknown): string {
  const token = asRecord(body).refreshToken;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new BadRequestException('A refresh token is required');
  }
  return token.trim();
}

export interface ForgotPasswordInput {
  readonly email: string;
  readonly turnstileToken: string;
}

export function parseForgotPasswordBody(body: unknown): ForgotPasswordInput {
  const record = asRecord(body);

  return {
    email: parseEmail(record.email),
    turnstileToken: parseTurnstileToken(record.turnstileToken),
  };
}

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export function parseChangePasswordBody(body: unknown): ChangePasswordInput {
  const record = asRecord(body);
  const currentPassword = record.currentPassword;

  if (typeof currentPassword !== 'string' || currentPassword === '') {
    throw new BadRequestException('Enter your current password');
  }

  return { currentPassword, newPassword: parsePassword(record.newPassword) };
}

export interface ResetPasswordInput {
  readonly token: string;
  readonly newPassword: string;
}

export function parseResetPasswordBody(body: unknown): ResetPasswordInput {
  const record = asRecord(body);

  // The same token reader the verification link uses: one shape for one kind of
  // single-use email link.
  return { token: parseEmailToken(record), newPassword: parsePassword(record.newPassword) };
}

export interface DeactivateInput {
  readonly password: string;
}

export function parseDeactivateBody(body: unknown): DeactivateInput {
  const password = asRecord(body).password;

  if (typeof password !== 'string' || password === '') {
    throw new BadRequestException('Enter your password');
  }

  return { password };
}

const ROLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

export function parseRoleChangeBody(body: unknown): string {
  const code = asRecord(body).roleCode;

  if (typeof code !== 'string') {
    throw new BadRequestException('Choose a role');
  }

  const normalised = code.trim().toUpperCase();
  if (!ROLE_CODE_PATTERN.test(normalised)) {
    throw new BadRequestException('Choose a role');
  }

  return normalised;
}

