import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The pure half of the OTP flow: codes, their HMAC, cooldowns, business dates and mobile
 * normalisation. Nothing here touches a database, a network or Nest, so every rule can be
 * proven by a unit test with no fixtures.
 */

export const OTP_CODE_LENGTH = 6;
export const OTP_CODE_PATTERN = /^[0-9]{6}$/;
/** A code lives for five minutes, counted from the moment the row is written. */
export const OTP_TTL_SECONDS = 5 * 60;
/** After this many wrong guesses the request is spent, even if the code is still live. */
export const OTP_MAX_ATTEMPTS = 5;

/** The cooldown before the next resend, indexed by requests already made in the last hour. */
export const OTP_RESEND_COOLDOWN_SECONDS = [30, 60, 120, 300, 600] as const;

export const OTP_LIMITS = {
  /** One number may ask three times an hour and eight times a day. */
  perNumberPerHour: 3,
  perNumberPerDay: 8,
  /** One address may ask ten times an hour, whatever numbers it names. */
  perIpPerHour: 10,
  /** One device may ask five times an hour. */
  perDevicePerHour: 5,
  /**
   * Checking a code is metered too. A live code is worth at most ten comparisons an hour
   * from any number, and one address may submit twenty codes an hour in total: guessing is
   * expensive before the five-attempt ceiling on a single row even comes into it.
   */
  verifyPerNumberPerHour: 10,
  verifyPerIpPerHour: 20,
} as const;

/** What one message is recorded as costing, so the ledger reconciles with an invoice. */
export const OTP_SMS_COST = 0.15;

export class InvalidMobileError extends Error {
  constructor(message = 'Enter a valid mobile number') {
    super(message);
    this.name = 'InvalidMobileError';
  }
}

/** A six-digit code, uniformly drawn. Injectable so a test can pin the sequence. */
export function generateCode(random: (min: number, max: number) => number = randomInt): string {
  const value = random(0, 1_000_000);
  return String(value).padStart(OTP_CODE_LENGTH, '0');
}

/**
 * The code is stored only as an HMAC bound to its destination: the same six digits sent to
 * two numbers produce two different digests, and a read of the table cannot recover a code.
 */
export function hashCode(secret: string, destination: string, code: string): string {
  return createHmac('sha256', secret).update(`${destination}:${code}`).digest('hex');
}

/** Constant-time comparison of the stored digest with the one the submitted code produces. */
export function codeMatches(expectedHex: string, secret: string, destination: string, code: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(hashCode(secret, destination, code), 'hex');

  if (expected.length === 0 || expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

/**
 * The wait before the next resend. The first request of the hour costs nothing extra; each
 * one after it doubles the wait, up to ten minutes.
 */
export function resendCooldownSeconds(requestsInLastHour: number): number {
  const index = Math.min(Math.max(requestsInLastHour, 0), OTP_RESEND_COOLDOWN_SECONDS.length - 1);
  return OTP_RESEND_COOLDOWN_SECONDS[index] ?? 30;
}

/** Asia/Kolkata is UTC+05:30 all year: the business day is the IST calendar day. */
const BUSINESS_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function businessDate(now: Date): string {
  return new Date(now.getTime() + BUSINESS_OFFSET_MS).toISOString().slice(0, 10);
}

export function startOfBusinessDay(now: Date): Date {
  const shifted = new Date(now.getTime() + BUSINESS_OFFSET_MS);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnight - BUSINESS_OFFSET_MS);
}

/**
 * An E.164 destination. A bare ten-digit number is Indian (the platform's home country); a
 * leading zero is the same number written the Indian way; `00` is the international prefix.
 * Anything outside the configured country allowlist is refused before an SMS is paid for.
 */
export function normaliseMobile(value: string, allowedCountryCodes: readonly string[]): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\s()\-.]/g, '');

  if (cleaned === '') {
    throw new InvalidMobileError();
  }

  let e164: string;
  if (cleaned.startsWith('+')) {
    e164 = cleaned;
  } else if (/^00[1-9][0-9]{6,}$/.test(cleaned)) {
    e164 = `+${cleaned.slice(2)}`;
  } else if (/^[0-9]{10}$/.test(cleaned)) {
    e164 = `+91${cleaned}`;
  } else if (/^0[0-9]{10}$/.test(cleaned)) {
    e164 = `+91${cleaned.slice(1)}`;
  } else {
    throw new InvalidMobileError();
  }

  if (!/^\+[1-9][0-9]{7,14}$/.test(e164)) {
    throw new InvalidMobileError();
  }

  if (!allowedCountryCodes.some((code) => e164.startsWith(code))) {
    throw new InvalidMobileError('We cannot send codes to that country yet');
  }

  return e164;
}

/** `users.mobile` stores the ten national digits, the same shape the identity trigger uses. */
export function nationalDigits(e164: string): string {
  return e164.replace(/[^0-9]/g, '').slice(-10);
}

/**
 * Sequential numbers are a classic smishing pattern ("+919876543210", "…3211", "…3212"),
 * so a run of six consecutive digits up or down is worth an audit row.
 */
export function isSequentialDigits(value: string, run = 6): boolean {
  const digits = value.replace(/[^0-9]/g, '');

  for (let start = 0; start + run <= digits.length; start += 1) {
    let ascending = true;
    let descending = true;

    for (let index = 1; index < run; index += 1) {
      const previous = Number(digits[start + index - 1]);
      const current = Number(digits[start + index]);
      if (current !== previous + 1) {
        ascending = false;
      }
      if (current !== previous - 1) {
        descending = false;
      }
    }

    if (ascending || descending) {
      return true;
    }
  }

  return false;
}

export function otpNumberLimitKey(purpose: string, destinationDigest: string, window: 'hour' | 'day'): string {
  return `ratelimit:otp:number:${window}:${purpose}:${destinationDigest}`;
}

export function otpDeviceLimitKey(deviceDigest: string): string {
  return `ratelimit:otp:device:${deviceDigest}`;
}

/** Guesses at one destination's live codes, whatever purpose asked for them. */
export function otpVerifyNumberKey(destinationDigest: string): string {
  return `ratelimit:otp:verify:number:${destinationDigest}`;
}

/** Guesses submitted from one address, using the address the API resolved for the request. */
export function otpVerifyIpKey(ip: string): string {
  const value = ip.trim();
  return `ratelimit:otp:verify:ip:${value === '' ? 'unknown' : value}`;
}

export function otpBudgetKey(day: string): string {
  return `otp:budget:closed:${day}`;
}

export function otpAlertKey(action: string, day: string): string {
  return `otp:alerts:${action}:${day}`;
}


/** Six digits: the only shape a fixed code is allowed to take. */
export const FIXED_CODE_PATTERN = /^[0-9]{6}$/;

export interface FixedCodeConfig {
  readonly otpEnabled: boolean;
  readonly nodeEnv: string;
  readonly smsProvider: string;
  readonly fixedCode: string;
}

/**
 * The code to send instead of a random one, or `null` for the real thing.
 *
 * A browser test cannot read an SMS, and adding an HTTP route that hands out live codes —
 * even a development-only one — would be a new way to obtain somebody's code. A fixed code
 * is the smaller risk: it only works where nothing real is sent. Three conditions, all
 * necessary: the switch is on, the process is not production, and the provider is the fake
 * one, which refuses to exist in production anyway.
 *
 * `validateEnv` refuses the same combinations at boot, so this function is the second lock
 * on the same door rather than the only one (decision 0051).
 */
export function fixedCodeFor(config: FixedCodeConfig): string | null {
  if (!config.otpEnabled || config.nodeEnv === 'production' || config.smsProvider !== 'fake') {
    return null;
  }

  const code = config.fixedCode.trim();
  return FIXED_CODE_PATTERN.test(code) ? code : null;
}
