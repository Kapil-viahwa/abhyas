import { NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import type { DatabaseService } from '../infra/database.service';
import type { RateLimiter } from '../infra/rate-limiter';
import type { TurnstileVerifier } from '../infra/turnstile-verifier';
import { OtpService } from './otp.service';
import type { SmsMessage, SmsProvider } from './sms-provider';

/**
 * The disabled mode, proven from the service itself: with `OTP_ENABLED=false` no entry point
 * reaches a provider, so no SMS can be sent from any code path even if one is wired in.
 */
describe('OTP disabled', () => {
  afterEach(() => {
    delete process.env.OTP_ENABLED;
    delete process.env.OTP_HMAC_SECRET;
  });

  function prepare(): void {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??= 'postgresql://abhyas:abhyas@localhost:5432/abhyas';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.OTP_ENABLED = 'false';
    process.env.OTP_HMAC_SECRET = '';
  }

  it('answers 404 on both entry points and never touches a provider, even a real one', async () => {
    prepare();

    const sent: SmsMessage[] = [];
    const spy: SmsProvider = {
      name: 'spy',
      send: async (message: SmsMessage) => {
        sent.push(message);
        return { providerMessageId: 'spy-1' };
      },
    };

    // Deliberately the wrong wiring: a provider on a disabled service must still be
    // unreachable, because the switch is checked before the provider is ever consulted.
    const service = new OtpService(
      { prisma: {} } as unknown as DatabaseService,
      { consumeAll: async () => null } as unknown as RateLimiter,
      { verify: async () => true } as unknown as TurnstileVerifier,
      spy,
    );

    await expect(
      service.requestCode({ destination: '+919876543210', purpose: 'LOGIN', turnstileToken: 'token' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.verifyCode({ destination: '+919876543210', purpose: 'LOGIN', code: '123456' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(sent).toEqual([]);
  });
});
