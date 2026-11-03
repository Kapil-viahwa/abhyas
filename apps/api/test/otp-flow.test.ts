import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { RedisService } from '../src/infra/redis.service';
import { REDIS_PROBE } from '../src/infra/tokens';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';
import { OTP_ALERTS, OtpService, OtpThrottledException } from '../src/otp/otp.service';
import { OTP_SMS_PROVIDER, type FakeSmsProvider, type SmsProvider } from '../src/otp/sms-provider';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The OTP service against the real database, the real Redis and the fake provider.
 *
 * Nothing here is mocked: the codes, the HMACs, the constraints, the rate limits and the
 * budget breaker are the ones the process would use. The fake provider's outbox is the only
 * place a code is ever readable — which is also how these tests read one.
 */

const saved = { ...process.env };

/**
 * A freshly booted API reports itself degraded until its Redis connection is established,
 * and its client refuses commands until then (`enableOfflineQueue: false`). Every OTP route
 * needs Redis, so the boot waits for it instead of racing it.
 */
async function waitForRedis(app: NestFastifyApplication): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await app.get<RedisService>(REDIS_PROBE).ping();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('the API Redis connection did not become ready');
}

/** One boot of the API. The budget is a boot-time setting, so a test that needs a small
 * breaker gets its own process-like instance rather than lowering the limit for everyone. */
async function bootApp(budget: number): Promise<{
  app: NestFastifyApplication;
  otp: OtpService;
  provider: FakeSmsProvider;
}> {
  process.env.OTP_SMS_DAILY_BUDGET = String(budget);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
    logger: ['error'],
  });
  await app.init();
  await waitForRedis(app);

  return {
    app,
    otp: app.get(OtpService),
    provider: app.get<SmsProvider>(OTP_SMS_PROVIDER) as FakeSmsProvider,
  };
}

const BUDGET = 1000;

describe('OTP codes and abuse controls', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;
  let otp!: OtpService;
  let provider!: FakeSmsProvider;

  let counter = 0;

  /** A fresh Indian number per test, so one test's cooldown cannot stall another. */
  function nextNumber(): string {
    counter += 1;
    return `+9199${String(counter).padStart(8, '0')}`;
  }

  function codeFor(destination: string): string {
    const message = provider.lastTo(destination);
    const match = /([0-9]{6})/.exec(message?.body ?? '');
    const code = match?.[1];
    if (code === undefined) {
      throw new Error('the fake outbox has no code for that destination');
    }
    return code;
  }

  async function request(destination: string, ip = '198.51.100.7', purpose = 'LOGIN'): Promise<void> {
    await otp.requestCode({ destination, purpose, turnstileToken: TURNSTILE_TEST_TOKEN }, { ip });
  }

  /** Moves this number's history into the past, so the escalating cooldown is satisfied. */
  async function backdate(destination: string): Promise<void> {
    await db.client.otpRequest.updateMany({
      where: { destination },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
  }

  beforeAll(async () => {
    db = await createMigratedTestDatabase('otpflow');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.OTP_ENABLED = 'true';
    process.env.OTP_HMAC_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
    process.env.SMS_PROVIDER = 'fake';
    process.env.OTP_ALLOWED_COUNTRY_CODES = '+91';
    // Comfortably more than this file sends, so one test's messages cannot trip the breaker
    // that another test is testing on purpose.
    process.env.OTP_SMS_DAILY_BUDGET = String(BUDGET);
    process.env.OTP_TEMPLATE_ID = 'TPL-TEST';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    const booted = await bootApp(BUDGET);
    app = booted.app;
    otp = booted.otp;
    provider = booted.provider;
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await db?.dispose();

    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, saved);
  }, 60_000);

  it('sends a code that verifies once and never again', async () => {
    await redis.flushdb();
    const destination = nextNumber();

    await request(destination);
    const code = codeFor(destination);

    const verified = await otp.verifyCode({ destination, purpose: 'LOGIN', code });
    expect(verified.destination).toBe(destination);

    await expect(otp.verifyCode({ destination, purpose: 'LOGIN', code })).rejects.toThrow(/not valid/);

    const audits = await db.client.auditLog.findMany({
      where: { action: { in: ['OTP_REQUESTED', 'OTP_VERIFIED'] } },
      select: { action: true },
    });
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(['OTP_REQUESTED', 'OTP_VERIFIED']));
  });

  it('never stores the code, in the row or in the audit trail', async () => {
    await redis.flushdb();
    const destination = nextNumber();

    await request(destination);
    const code = codeFor(destination);

    const row = await db.client.otpRequest.findFirst({ where: { destination }, orderBy: { createdAt: 'desc' } });
    expect(row).not.toBeNull();
    expect(row?.codeHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row?.codeHmac).not.toBe(code);

    const alerts = await db.client.auditLog.findMany({ select: { metadata: true, action: true } });
    expect(JSON.stringify(alerts)).not.toContain(code);
  });

  it('spends the code after five wrong guesses', async () => {
    await redis.flushdb();
    const destination = nextNumber();

    await request(destination);
    const code = codeFor(destination);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(otp.verifyCode({ destination, purpose: 'LOGIN', code: wrong })).rejects.toThrow(/not valid/);
    }

    const row = await db.client.otpRequest.findFirst({ where: { destination }, orderBy: { createdAt: 'desc' } });
    expect(row?.attempts).toBe(5);
    expect(row?.consumedAt).not.toBeNull();

    await expect(otp.verifyCode({ destination, purpose: 'LOGIN', code })).rejects.toThrow(/not valid/);
  });

  it('refuses an expired code', async () => {
    await redis.flushdb();
    const destination = nextNumber();

    await request(destination);
    const code = codeFor(destination);

    // A row cannot be "expired" by moving only its expiry before its creation: the table
    // refuses that pairing. Move the pair back in time, keeping the order the CHECK wants.
    await db.client.otpRequest.updateMany({
      where: { destination },
      data: { createdAt: new Date(Date.now() - 10 * 60_000), expiresAt: new Date(Date.now() - 5 * 60_000) },
    });

    await expect(otp.verifyCode({ destination, purpose: 'LOGIN', code })).rejects.toThrow(/not valid/);
  });

  it('caps one number at three codes an hour', async () => {
    await redis.flushdb();
    const destination = nextNumber();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(destination);
      await backdate(destination);
    }

    await expect(request(destination)).rejects.toBeInstanceOf(OtpThrottledException);
    expect(await otp.alertCount(OTP_ALERTS.requestLimited)).toBeGreaterThan(0);
  });

  it('caps one address at ten codes an hour, whatever numbers it names', async () => {
    await redis.flushdb();
    const ip = '203.0.113.44';

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(nextNumber(), ip);
    }

    await expect(request(nextNumber(), ip)).rejects.toBeInstanceOf(OtpThrottledException);
  });

  it('stops sending when the daily budget is gone, and says so with an alert', async () => {
    await redis.flushdb();
    // The ledger is the count, so it starts from zero for this test (owner connection).
    await db.client.smsCostLedger.deleteMany({});

    // A budget of one, on its own boot: the breaker is a boot-time setting, and lowering it
    // for the shared app would make every other test in this file depend on this one.
    const second = await bootApp(1);
    try {
      const first = nextNumber();
      await second.otp.requestCode(
        { destination: first, purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
        { ip: '203.0.113.100' },
      );
      expect(second.provider.lastTo(first)).toBeDefined();

      const refused = nextNumber();
      await expect(
        second.otp.requestCode(
          { destination: refused, purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
          { ip: '203.0.113.101' },
        ),
      ).rejects.toThrow(/paused for today/);
      expect(second.provider.lastTo(refused)).toBeUndefined();
      expect(await second.otp.alertCount(OTP_ALERTS.budgetExhausted)).toBe(1);

      // The breaker is latched: the next request is refused without another alert row.
      await expect(
        second.otp.requestCode(
          { destination: nextNumber(), purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
          { ip: '203.0.113.102' },
        ),
      ).rejects.toThrow(/paused for today/);
      expect(await second.otp.alertCount(OTP_ALERTS.budgetExhausted)).toBe(1);
    } finally {
      await second.app.close();
      process.env.OTP_SMS_DAILY_BUDGET = String(BUDGET);
    }

    const audited = await db.client.auditLog.findMany({ where: { action: 'OTP_ALERT' }, select: { metadata: true } });
    expect(JSON.stringify(audited)).toContain(OTP_ALERTS.budgetExhausted);
  }, 60_000);

  it('sends nothing when the human check fails', async () => {
    await redis.flushdb();
    const destination = nextNumber();
    const before = provider.outbox.length;

    await expect(
      otp.requestCode({ destination, purpose: 'LOGIN', turnstileToken: 'not-the-token' }, { ip: '198.51.100.8' }),
    ).rejects.toThrow(/human verification/);

    expect(provider.outbox.length).toBe(before);
    await expect(db.client.otpRequest.count({ where: { destination } })).resolves.toBe(0);
  });

  it('answers a number nobody has the same way as one that has an account', async () => {
    await redis.flushdb();
    const known = nextNumber();
    const unknown = nextNumber();

    const first = await otp.requestCode(
      { destination: known, purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
      { ip: '198.51.100.9' },
    );
    const second = await otp.requestCode(
      { destination: unknown, purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
      { ip: '198.51.100.9' },
    );

    expect(first).toEqual(second);
    expect(first).toEqual({ status: 'accepted', resendAfterSeconds: 60 });
  });

  it('refuses a country that is not on the allowlist before any SMS is paid for', async () => {
    await redis.flushdb();
    const before = provider.outbox.length;

    await expect(
      otp.requestCode({ destination: '+447911123456', purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN }),
    ).rejects.toThrow(/cannot send codes to that country/);

    expect(provider.outbox.length).toBe(before);
  });
});
