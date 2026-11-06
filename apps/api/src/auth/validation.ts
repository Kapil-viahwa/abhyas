import { BadRequestException } from '@nestjs/common';

import type { EditorFlags } from '../admin/editor-flags';
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
  /** The current password, when the account has one it knows. */
  readonly currentPassword: string | undefined;
  readonly newPassword: string;
  /** A re-authentication code, the path for an account created with a mobile number. */
  readonly code: string | undefined;
}

export function parseChangePasswordBody(body: unknown): ChangePasswordInput {
  const record = asRecord(body);

  return {
    currentPassword: optionalSecret(record.currentPassword),
    newPassword: parsePassword(record.newPassword),
    code: parseOptionalOtpCode(record.code),
  };
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
  readonly password: string | undefined;
  readonly code: string | undefined;
}

export function parseDeactivateBody(body: unknown): DeactivateInput {
  const record = asRecord(body);

  return {
    password: optionalSecret(record.password),
    code: parseOptionalOtpCode(record.code),
  };
}

export interface ReauthenticationInput {
  readonly turnstileToken: string;
}

/** Asking for a re-authentication code. The destination is never taken from the client. */
export function parseReauthenticationBody(body: unknown): ReauthenticationInput {
  return { turnstileToken: parseTurnstileToken(asRecord(body).turnstileToken) };
}

/** An empty or absent secret means "not offered", never "empty string is fine". */
function optionalSecret(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A six-digit code, or nothing when none was offered: an empty proof is no proof. */
function parseOptionalOtpCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return parseOtpCode(value);
}

export interface EmailLinkInput {
  readonly email: string;
  readonly password: string | undefined;
  readonly code: string | undefined;
}

export function parseEmailLinkBody(body: unknown): EmailLinkInput {
  const record = asRecord(body);

  return {
    email: parseEmail(record.email),
    password: optionalSecret(record.password),
    code: parseOptionalOtpCode(record.code),
  };
}

export interface MobileLinkInput {
  readonly destination: string;
  readonly code: string;
  readonly password: string | undefined;
  /** The re-authentication code sent to the account's own number, when it has no password. */
  readonly reauthCode: string | undefined;
}

export function parseMobileLinkBody(body: unknown): MobileLinkInput {
  const record = asRecord(body);

  return {
    destination: parseDestination(record.destination),
    code: parseOtpCode(record.code),
    password: optionalSecret(record.password),
    reauthCode: parseOptionalOtpCode(record.reauthCode),
  };
}

export interface UnlinkMobileInput {
  readonly password: string | undefined;
  readonly code: string | undefined;
}

export function parseUnlinkMobileBody(body: unknown): UnlinkMobileInput {
  const record = asRecord(body);

  return {
    password: optionalSecret(record.password),
    code: parseOptionalOtpCode(record.code),
  };
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



// ---------------------------------------------------------------------------
// Phase 3: user administration
// ---------------------------------------------------------------------------

export const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const;

/** The role filters an account list may use; anything else is a typo, not a filter. */
export const USER_ROLE_FILTERS = ['ADMIN', 'EDITOR', 'USER'] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_LIST_DEFAULT_PAGE_SIZE = 20;
export const USER_LIST_MAX_PAGE_SIZE = 50;
export const USER_SEARCH_MAX_LENGTH = 120;

export interface UserListQueryInput {
  readonly search?: string;
  readonly roleCode?: string;
  readonly status?: UserStatus;
  readonly page: number;
  readonly pageSize: number;
}

function firstString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
}

function parsePositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = firstString(value).trim();
  if (raw === '') {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

/**
 * Query parameters are clamped rather than rejected: a hand-edited URL should show a
 * sensible page, not an error. Values that select *what* is returned are strict,
 * because a typo there would silently widen the result.
 */
export function parseUserListQuery(query: Record<string, unknown>): UserListQueryInput {
  const search = firstString(query.search).trim().slice(0, USER_SEARCH_MAX_LENGTH);

  const roleRaw = firstString(query.role).trim().toUpperCase();
  let roleCode: string | undefined;
  if (roleRaw !== '') {
    if (!(USER_ROLE_FILTERS as readonly string[]).includes(roleRaw)) {
      throw new BadRequestException('Choose a valid role filter');
    }
    roleCode = roleRaw;
  }

  const statusRaw = firstString(query.status).trim().toUpperCase();
  let status: UserStatus | undefined;
  if (statusRaw !== '') {
    if (!(USER_STATUSES as readonly string[]).includes(statusRaw)) {
      throw new BadRequestException('Choose a valid status filter');
    }
    status = statusRaw as UserStatus;
  }

  return {
    search: search === '' ? undefined : search,
    roleCode,
    status,
    page: parsePositiveInteger(query.page, 1, 1, 10_000),
    pageSize: parsePositiveInteger(query.pageSize, USER_LIST_DEFAULT_PAGE_SIZE, 1, USER_LIST_MAX_PAGE_SIZE),
  };
}

export interface CreateEditorInput {
  readonly email: string;
  readonly fullName: string;
  readonly password: string;
  readonly flags: EditorFlags;
}

/** A missing flag is a denial, so every key is normalised to a boolean here. */
export function parseEditorFlags(record: Record<string, unknown>): EditorFlags {
  return {
    manage_questions: record.manage_questions === true,
    manage_tests: record.manage_tests === true,
  };
}

export function parseCreateEditorBody(body: unknown): CreateEditorInput {
  const record = asRecord(body);

  return {
    email: parseEmail(record.email),
    fullName: parseFullName(record.fullName),
    password: parsePassword(record.password),
    flags: parseEditorFlags(record),
  };
}

export function parseEditorFlagsBody(body: unknown): EditorFlags {
  return parseEditorFlags(asRecord(body));
}

export function parseUserStatusBody(body: unknown): UserStatus {
  const status = asRecord(body).status;

  if (typeof status !== 'string') {
    throw new BadRequestException('Choose a status');
  }

  const normalised = status.trim().toUpperCase();
  if (!(USER_STATUSES as readonly string[]).includes(normalised)) {
    throw new BadRequestException('Choose a status');
  }

  return normalised as UserStatus;
}


const OTP_CODE_PATTERN = /^[0-9]{6}$/;

/**
 * A mobile destination and the code sent to it. The number is only checked for shape here:
 * `OtpService` normalises it to E.164 and enforces the country allowlist, so an unknown
 * country is refused with the message that belongs to that rule.
 */
function parseDestination(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException('Enter a valid mobile number');
  }

  return value.trim();
}

function parseOtpCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!OTP_CODE_PATTERN.test(code)) {
    throw new BadRequestException('Enter the 6-digit code');
  }

  return code;
}

export interface OtpRequestForm {
  readonly destination: string;
  readonly purpose: string;
  readonly turnstileToken: string;
  readonly deviceId?: string | undefined;
}

/** Asking for a code. The purpose is normalised here and validated by the OTP module. */
export function parseOtpRequestBody(body: unknown): OtpRequestForm {
  const record = asRecord(body);
  const purpose = typeof record.purpose === 'string' ? record.purpose.trim().toUpperCase() : '';

  if (purpose === '') {
    throw new BadRequestException('Choose why the code is being sent');
  }

  return {
    destination: parseDestination(record.destination),
    purpose,
    turnstileToken: parseTurnstileToken(record.turnstileToken),
    deviceId: typeof record.deviceId === 'string' && record.deviceId.trim() !== '' ? record.deviceId.trim() : undefined,
  };
}

export interface MobileRegisterInput {
  readonly destination: string;
  readonly code: string;
  readonly fullName: string;
}

export function parseMobileRegisterBody(body: unknown): MobileRegisterInput {
  const record = asRecord(body);

  return {
    destination: parseDestination(record.destination),
    code: parseOtpCode(record.code),
    fullName: parseFullName(record.fullName),
  };
}

export interface MobileLoginInput {
  readonly destination: string;
  readonly code: string;
}

export function parseMobileLoginBody(body: unknown): MobileLoginInput {
  const record = asRecord(body);

  return {
    destination: parseDestination(record.destination),
    code: parseOtpCode(record.code),
  };
}
