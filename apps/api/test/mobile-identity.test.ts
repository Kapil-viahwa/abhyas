import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { RedisService } from '../src/infra/redis.service';
import { REDIS_PROBE } from '../src/infra/tokens';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';
import { OTP_SMS_PROVIDER, type FakeSmsProvider, type SmsProvider } from '../src/otp/sms-provider';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Mobile sign-up and sign-in over real HTTP, against the real database, the real Redis and
 * the fake provider.
 *
 * The rules these tests exist for:
 * 1. A verified number is enough to create an account, and the session it gets is the same
 *    opaque session password sign-in issues, with the same revocation.
 * 2. One phone, one account — enforced by the database, not only by a lookup.
 * 3. With `OTP_ENABLED=false` every mobile route is a 404 and no provider exists at all.
 * 4. The sign-up protections that do not need OTP still hold: the human check, the per-IP
 *    limit that already existed, and the disposable-inbox blocklist.
 * 5. `signup_grant_requirement` is stored with its own allowed values and audited.
 */

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

const PASSWORD = 'correct-horse-9battery';

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

describe('mobile sign-up and sign-in', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;
  let provider!: FakeSmsProvider;

  let numberCounter = 0;
  let ipCounter = 0;

  /** A fresh Indian number per test, so one test's cooldown cannot stall another. */
  function nextNumber(): string {
    numberCounter += 1;
    return `+9198${String(numberCounter).padStart(8, '0')}`;
  }

  /** A fresh address per request, so the per-IP ceiling never depends on test order. */
  function nextIp(): string {
    ipCounter += 1;
    return `203.0.113.${String(ipCounter)}`;
  }

  function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function requestCode(destination: string, purpose: 'SIGNUP' | 'LOGIN'): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { destination, purpose, turnstileToken: TURNSTILE_TEST_TOKEN },
    });

    expect(response.statusCode, response.body).toBe(202);
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

  /** Moves this number's history into the past, so the escalating cooldown is satisfied. */
  async function backdate(destination: string): Promise<void> {
    await db.client.otpRequest.updateMany({
      where: { destination },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
  }

  async function registerPerson(fullName: string): Promise<string> {
    const destination = nextNumber();
    await requestCode(destination, 'SIGNUP');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/register',
      payload: { destination, code: codeFor(destination), fullName },
    });
    expect(response.statusCode, response.body).toBe(201);

    return destination;
  }

  beforeAll(async () => {
    db = await createMigratedTestDatabase('mobile');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.OTP_ENABLED = 'true';
    process.env.OTP_HMAC_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
    process.env.SMS_PROVIDER = 'fake';
    process.env.OTP_ALLOWED_COUNTRY_CODES = '+91';
    process.env.OTP_SMS_DAILY_BUDGET = '1000';
    process.env.OTP_TEMPLATE_ID = 'TPL-TEST';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitForRedis(app);

    provider = app.get<SmsProvider>(OTP_SMS_PROVIDER) as FakeSmsProvider;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await db?.dispose();

    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  it('creates an account from a verified number and signs it in on a normal session', async () => {
    await redis.flushdb();
    const destination = nextNumber();

    await requestCode(destination, 'SIGNUP');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/register',
      payload: { destination, code: codeFor(destination), fullName: 'Mobile Student' },
    });

    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{
      accessToken: string;
      user: { id: string; email: string | null; roleCode: string };
    }>();
    expect(body.user.email).toBeNull();
    expect(body.user.roleCode).toBe('USER');

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(body.accessToken) });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json<{ email: string | null }>().email).toBeNull();

    const row = await db.client.user.findUniqueOrThrow({ where: { id: body.user.id } });
    expect(row.email).toBeNull();
    expect(row.mobile).toBe(destination.slice(-10));
    expect(row.firstVerifiedMobile).toBe(destination);
    expect(row.mobileVerifiedAt).not.toBeNull();
    expect(row.emailVerifiedAt).toBeNull();

    const audits = await db.client.auditLog.findMany({
      where: { action: { in: ['IDENTITY_MOBILE_REGISTERED', 'IDENTITY_LOGIN_SUCCEEDED'] } },
      select: { action: true },
    });
    expect(audits.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['IDENTITY_MOBILE_REGISTERED', 'IDENTITY_LOGIN_SUCCEEDED']),
    );

    // Signing out is the same revocation password sign-in gets: the token dies at once.
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: bearer(body.accessToken) });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(body.accessToken) });
    expect(after.statusCode).toBe(401);
  });

  it('refuses a second account for one number, and audits the attempt', async () => {
    await redis.flushdb();
    const destination = await registerPerson('First Owner');

    await backdate(destination);
    await requestCode(destination, 'SIGNUP');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/register',
      payload: { destination, code: codeFor(destination), fullName: 'Second Claim' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.body).toMatch(/already has an account/);
    expect(await db.client.user.count({ where: { firstVerifiedMobile: destination } })).toBe(1);
    expect(
      await db.client.auditLog.count({ where: { action: 'IDENTITY_MOBILE_REGISTER_REFUSED' } }),
    ).toBeGreaterThan(0);
  });

  it('signs in with a code, and tells the holder of an unregistered number so', async () => {
    await redis.flushdb();
    const destination = await registerPerson('Returning Student');

    await requestCode(destination, 'LOGIN');
    const signedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/login',
      payload: { destination, code: codeFor(destination) },
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);

    const token = signedIn.json<{ accessToken: string }>().accessToken;
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);

    const stranger = nextNumber();
    await requestCode(stranger, 'LOGIN');
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/login',
      payload: { destination: stranger, code: codeFor(stranger) },
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.body).toMatch(/not registered/);
  });

  it('burns the code after five wrong guesses', async () => {
    await redis.flushdb();
    const destination = await registerPerson('Lockout Student');

    await requestCode(destination, 'LOGIN');
    const code = codeFor(destination);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await app.inject({
        method: 'POST',
        url: '/v1/auth/mobile/login',
        payload: { destination, code: wrong },
      });
      expect(refused.statusCode).toBe(400);
    }

    const late = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/login',
      payload: { destination, code },
    });
    expect(late.statusCode).toBe(400);

    const row = await db.client.otpRequest.findFirst({
      where: { destination, purpose: 'LOGIN' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row?.attempts).toBe(5);
    expect(row?.consumedAt).not.toBeNull();
  });

  it('refuses a throwaway inbox at signup, before any mail is sent', async () => {
    await redis.flushdb();
    const before = await db.client.user.count();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'x-forwarded-for': nextIp() },
      payload: {
        email: `throwaway-${randomUUID().slice(0, 8)}@mailinator.com`,
        password: PASSWORD,
        fullName: 'Throwaway Person',
        turnstileToken: TURNSTILE_TEST_TOKEN,
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toMatch(/permanent email/);
    expect(await db.client.user.count()).toBe(before);
  });

  it('stores which identifier earns the signup grant, and refuses any other value', async () => {
    const setting = await db.client.setting.findUniqueOrThrow({ where: { key: 'signup_grant_requirement' } });
    expect(setting.valueType).toBe('string');
    expect(setting.valueText).toBe('email');

    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'ADMIN' }, select: { id: true } });
    const admin = await db.client.user.create({
      data: {
        email: `grant-admin-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Grant Admin',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(admin.id);

    const changed = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/settings/signup_grant_requirement',
      headers: bearer(issued.accessToken),
      payload: { value: 'mobile' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<{ valueText: string }>().valueText).toBe('mobile');

    const refused = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/settings/signup_grant_requirement',
      headers: bearer(issued.accessToken),
      payload: { value: 'sms' },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(
      (await db.client.setting.findUniqueOrThrow({ where: { key: 'signup_grant_requirement' } })).valueText,
    ).toBe('mobile');

    expect(
      await db.client.auditLog.count({
        where: { action: 'SETTINGS_CHANGED', metadata: { path: ['key'], equals: 'signup_grant_requirement' } },
      }),
    ).toBeGreaterThan(0);
  });

  it('answers 404 on every mobile route while the switch is off, and builds no provider', async () => {
    const previous = { ...process.env };
    process.env.OTP_ENABLED = 'false';

    const disabled = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ trustProxy: true }),
      { logger: ['error'] },
    );
    await disabled.init();

    try {
      const routes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['/v1/auth/otp', { destination: '+919876543210', purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN }],
        ['/v1/auth/mobile/register', { destination: '+919876543210', code: '123456', fullName: 'Nobody Here' }],
        ['/v1/auth/mobile/login', { destination: '+919876543210', code: '123456' }],
      ];

      for (const [url, payload] of routes) {
        const response = await disabled.inject({ method: 'POST', url, payload });
        expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
      }

      // The switch is not only in front of the routes: with it off the factory returns
      // before constructing anything, so there is no object that could send a message.
      expect(disabled.get<SmsProvider | null>(OTP_SMS_PROVIDER)).toBeNull();
    } finally {
      await disabled.close();
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    }
  }, 60_000);
});
