import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  parseChangePasswordBody,
  parseDeactivateBody,
  parseEmail,
  parseEmailToken,
  parseForgotPasswordBody,
  parseFullName,
  parseLoginBody,
  parsePassword,
  parseRefreshBody,
  parseRegisterBody,
  parseResetPasswordBody,
  parseRoleChangeBody,
  parseUuid,
} from './validation';

const TURNSTILE_TOKEN = 'abhyas-test-turnstile-token';

describe('auth input validation', () => {
  it('normalises an email address and refuses anything that is not one', () => {
    expect(parseEmail('  Student@Example.COM ')).toBe('student@example.com');
    expect(() => parseEmail('not-an-email')).toThrow(BadRequestException);
    expect(() => parseEmail('')).toThrow(BadRequestException);
    expect(() => parseEmail(undefined)).toThrow(BadRequestException);
  });

  it('trims a full name and refuses control characters', () => {
    expect(parseFullName('  Asha   Verma ')).toBe('Asha Verma');
    expect(() => parseFullName('A')).toThrow(BadRequestException);
    expect(() => parseFullName('Asha\u0000Verma')).toThrow(BadRequestException);
  });

  it('applies the password policy with a readable message', () => {
    expect(parsePassword('correct-horse-9battery')).toBe('correct-horse-9battery');
    expect(() => parsePassword('short')).toThrow(/at least 12 characters/);
    expect(() => parsePassword('alllettersonly')).toThrow(/letter and one digit/);
  });

  it('requires a body object and a human verification token', () => {
    expect(() => parseRegisterBody(null)).toThrow(/JSON object/);
    expect(() =>
      parseRegisterBody({ email: 'a@example.com', password: 'correct-horse-9battery', fullName: 'Asha Verma' }),
    ).toThrow(/Human verification is required/);
  });

  it('requires a verification token body', () => {
    expect(parseEmailToken({ token: ' abc ' })).toBe('abc');
    expect(() => parseEmailToken({})).toThrow(BadRequestException);
    expect(() => parseEmailToken([])).toThrow(BadRequestException);
  });

  it('accepts any non-empty password on login and never states the policy', () => {
    expect(
      parseLoginBody({ email: 'a@example.com', password: 'short', turnstileToken: TURNSTILE_TOKEN }),
    ).toEqual({
      email: 'a@example.com',
      password: 'short',
      turnstileToken: TURNSTILE_TOKEN,
    });

    // The human check is optional on sign-in: it is only demanded once the account
    // has too many recent failures, and demanding it always would cost every sign-in
    // a round trip to Cloudflare for nothing.
    expect(parseLoginBody({ email: 'a@example.com', password: 'short' })).toEqual({
      email: 'a@example.com',
      password: 'short',
      turnstileToken: undefined,
    });
    expect(parseLoginBody({ email: 'a@example.com', password: 'short', turnstileToken: '   ' }).turnstileToken).toBe(
      undefined,
    );

    expect(() => parseLoginBody({ email: 'a@example.com', turnstileToken: TURNSTILE_TOKEN })).toThrow(
      /Enter your password/,
    );
  });

  it('requires a refresh token and a session id that is really a uuid', () => {
    expect(parseRefreshBody({ refreshToken: ' abc ' })).toBe('abc');
    expect(() => parseRefreshBody({})).toThrow(/refresh token is required/);
    expect(() => parseRefreshBody({ refreshToken: '' })).toThrow(/refresh token is required/);

    expect(parseUuid(' 6f1d4a3e-0f0e-4a4c-9d6b-2f0a8f0b1c2d ', 'session id')).toBe(
      '6f1d4a3e-0f0e-4a4c-9d6b-2f0a8f0b1c2d',
    );
    expect(() => parseUuid('not-a-uuid', 'session id')).toThrow(/valid session id/);
    expect(() => parseUuid(undefined, 'session id')).toThrow(/valid session id/);
  });

  it('validates the password-reset and password-change bodies', () => {
    expect(parseForgotPasswordBody({ email: ' A@Example.com ', turnstileToken: TURNSTILE_TOKEN })).toEqual({
      email: 'a@example.com',
      turnstileToken: TURNSTILE_TOKEN,
    });
    expect(() => parseForgotPasswordBody({ email: 'a@example.com' })).toThrow(/Human verification is required/);

    expect(
      parseChangePasswordBody({ currentPassword: 'old-password-9x', newPassword: 'correct-horse-9battery' }),
    ).toEqual({ currentPassword: 'old-password-9x', newPassword: 'correct-horse-9battery' });
    expect(() => parseChangePasswordBody({ newPassword: 'correct-horse-9battery' })).toThrow(
      /current password/,
    );
    expect(() =>
      parseChangePasswordBody({ currentPassword: 'old-password-9x', newPassword: 'short' }),
    ).toThrow(/at least 12 characters/);

    expect(parseResetPasswordBody({ token: ' abc ', newPassword: 'correct-horse-9battery' })).toEqual({
      token: 'abc',
      newPassword: 'correct-horse-9battery',
    });
    expect(() => parseResetPasswordBody({ newPassword: 'correct-horse-9battery' })).toThrow(/verification token/);
  });

  it('requires the password before an account can be deactivated', () => {
    expect(parseDeactivateBody({ password: 'correct-horse-9battery' })).toEqual({
      password: 'correct-horse-9battery',
    });
    expect(() => parseDeactivateBody({})).toThrow(/Enter your password/);
  });

  it('normalises a role code and refuses anything that is not one', () => {
    expect(parseRoleChangeBody({ roleCode: ' editor ' })).toBe('EDITOR');
    expect(() => parseRoleChangeBody({})).toThrow(/Choose a role/);
    expect(() => parseRoleChangeBody({ roleCode: 'editor!' })).toThrow(/Choose a role/);
    expect(() => parseRoleChangeBody({ roleCode: 'E' })).toThrow(/Choose a role/);
  });
});
