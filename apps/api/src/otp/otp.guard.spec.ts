import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { OtpGuard } from './otp.guard';

/**
 * The master switch, at the door: with OTP off every OTP route answers 404 — the same answer
 * as a route that does not exist — and with it on the guard lets the request through.
 */
describe('the OTP master switch guard', () => {
  afterEach(() => {
    delete process.env.OTP_ENABLED;
  });

  function prepare(enabled: boolean): void {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??= 'postgresql://abhyas:abhyas@localhost:5432/abhyas';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.OTP_ENABLED = enabled ? 'true' : 'false';
    process.env.OTP_HMAC_SECRET = enabled ? 'h'.repeat(32) : '';
  }

  it('answers 404, not 403, when the switch is off', () => {
    prepare(false);
    const guard = new OtpGuard();

    expect(() => guard.canActivate()).toThrow(NotFoundException);
    try {
      guard.canActivate();
    } catch (error) {
      expect((error as NotFoundException).getStatus()).toBe(404);
    }
  });

  it('lets a request through when the switch is on', () => {
    prepare(true);

    expect(new OtpGuard().canActivate()).toBe(true);
  });

  it('reads the switch at boot, so toggling it needs a restart', () => {
    prepare(true);
    const guard = new OtpGuard();

    process.env.OTP_ENABLED = 'false';

    expect(guard.canActivate()).toBe(true);
  });
});
