import { describe, expect, it } from 'vitest';

import {
  InvalidMobileError,
  OTP_CODE_PATTERN,
  OTP_RESEND_COOLDOWN_SECONDS,
  businessDate,
  codeMatches,
  generateCode,
  hashCode,
  isSequentialDigits,
  nationalDigits,
  normaliseMobile,
  resendCooldownSeconds,
  startOfBusinessDay,
} from './otp-code';

describe('OTP codes', () => {
  it('is always six digits, including for a small draw', () => {
    expect(OTP_CODE_PATTERN.test(generateCode(() => 0))).toBe(true);
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 42)).toBe('000042');
    expect(OTP_CODE_PATTERN.test(generateCode())).toBe(true);
  });

  it('stores an HMAC bound to its destination, never the code', () => {
    const first = hashCode('secret', '+919876543210', '123456');
    const again = hashCode('secret', '+919876543210', '123456');
    const otherNumber = hashCode('secret', '+919876543211', '123456');
    const otherSecret = hashCode('another-secret', '+919876543210', '123456');

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain('123456');
    expect(again).toBe(first);
    expect(otherNumber).not.toBe(first);
    expect(otherSecret).not.toBe(first);
  });

  it('compares in constant time and refuses a malformed stored digest', () => {
    const digest = hashCode('secret', '+919876543210', '123456');

    expect(codeMatches(digest, 'secret', '+919876543210', '123456')).toBe(true);
    expect(codeMatches(digest, 'secret', '+919876543210', '654321')).toBe(false);
    expect(codeMatches(digest, 'secret', '+919876543211', '123456')).toBe(false);
    expect(codeMatches(digest, 'another-secret', '+919876543210', '123456')).toBe(false);
    expect(codeMatches('not-hex', 'secret', '+919876543210', '123456')).toBe(false);
    expect(codeMatches('', 'secret', '+919876543210', '123456')).toBe(false);
  });

  it('escalates the resend cooldown and then holds it', () => {
    const seconds = Array.from({ length: 8 }, (_unused, index) => resendCooldownSeconds(index));

    expect(seconds.slice(0, OTP_RESEND_COOLDOWN_SECONDS.length)).toEqual([...OTP_RESEND_COOLDOWN_SECONDS]);
    expect(seconds.at(-1)).toBe(600);
    for (let index = 1; index < seconds.length; index += 1) {
      expect(seconds[index] ?? 0).toBeGreaterThanOrEqual(seconds[index - 1] ?? 0);
    }
  });

  it('reads the business day in Asia/Kolkata, not UTC', () => {
    // 2025-01-01T00:00Z is 05:30 IST on the same date.
    expect(businessDate(new Date('2025-01-01T00:00:00Z'))).toBe('2025-01-01');
    // 2025-01-01T20:00Z is 01:30 IST on 2025-01-02.
    expect(businessDate(new Date('2025-01-01T20:00:00Z'))).toBe('2025-01-02');

    const start = startOfBusinessDay(new Date('2025-01-01T20:00:00Z'));
    expect(start.toISOString()).toBe('2025-01-01T18:30:00.000Z');
  });

  it('detects a sequential number', () => {
    expect(isSequentialDigits('+919876543210')).toBe(true);
    expect(isSequentialDigits('+911234567890')).toBe(true);
    expect(isSequentialDigits('+919812345678')).toBe(true);
    expect(isSequentialDigits('+919162738495')).toBe(false);
  });
});

describe('mobile normalisation', () => {
  it('accepts the ways an Indian number is written and stores E.164', () => {
    expect(normaliseMobile('9876543210', ['+91'])).toBe('+919876543210');
    expect(normaliseMobile('+91 98765 43210', ['+91'])).toBe('+919876543210');
    expect(normaliseMobile('098765 43210', ['+91'])).toBe('+919876543210');
    expect(normaliseMobile('0091-98765-43210', ['+91'])).toBe('+919876543210');
    expect(normaliseMobile('+44 7911 123456', ['+91', '+44'])).toBe('+447911123456');
  });

  it('refuses a country that is not on the allowlist', () => {
    expect(() => normaliseMobile('+44 7911 123456', ['+91'])).toThrow(InvalidMobileError);
    expect(() => normaliseMobile('+44 7911 123456', ['+91'])).toThrow(/cannot send codes to that country/);
  });

  it('refuses a number that is not a number', () => {
    for (const value of ['', '   ', 'abc', '12345', '+', '+0123456789', '12345678901234567890']) {
      expect(() => normaliseMobile(value, ['+91']), value).toThrow(InvalidMobileError);
    }
  });

  it('keeps the ten national digits the identity trigger stores', () => {
    expect(nationalDigits('+919876543210')).toBe('9876543210');
  });
});
