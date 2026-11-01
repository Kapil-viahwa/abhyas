import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseEmail, parseEmailToken, parseFullName, parsePassword, parseRegisterBody } from './validation';

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
});
