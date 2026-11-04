import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { capturedOutbox, clearCapturedOutbox } from '../src/infra/email-sender';
import { RedisService } from '../src/infra/redis.service';
import { REDIS_PROBE } from '../src/infra/tokens';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';
import { OTP_SMS_PROVIDER, type FakeSmsProvider, type SmsProvider } from '../src/otp/sms-provider';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Linking and unlinking an identifier on an existing account.
 *
 * The rules these tests exist for:
 * 1. A link is a single-use token, owned by the account that asked, and writing the address
 *    happens only when that person confirms it.
 * 2. A link never merges two accounts: an identifier that belongs to somebody else is
 *    refused, and the answer does not say so.
 * 3. The last identifier cannot be removed.
 * 4. Email linking works with the OTP switch off; every mobile route answers 404 with it off.
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

describe('linking an identifier', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;
  let provider!: FakeSmsProvider;

  let numberCounter = 0;
  let ipCounter = 0;

  function nextNumber(): string {
    numberCounter += 1;
    return `+9188${String(numberCounter).padStart(8, '0')}`;
  }

  function nextIp(): string {
    ipCounter += 1;
    return `203.0.113.${String(ipCounter)}`;
  }

  function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  function codeFor(destination: string): string {
    const match = /([0-9]{6})/.exec(provider.lastTo(destination)?.body ?? '');
    if (match?.[1] === undefined) {
      throw new Error('the fake outbox has no code for that destination');
    }
    return match[1];
  }

  function linkTokenFor(address: string): string {
    const message = capturedOutbox()
      .filter((entry) => entry.to === address)
      .at(-1);
    const match = /token=([^\s&]+)/.exec(message?.text ?? '');
    if (match?.[1] === undefined) {
      throw new Error('the console outbox has no link token for that address');
    }
    return decodeURIComponent(match[1]);
  }

  async function makeEmailAccount(): Promise<{ email: string; token: string; id: string }> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const email = `person-${randomUUID().slice(0, 8)}@example.com`;
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Email Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { email, token: issued.accessToken, id: user.id };
  }

  async function makeMobileOnlyAccount(): Promise<{ number: string; token: string; id: string }> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const number = nextNumber();
    const user = await db.client.user.create({
      data: {
        email: null,
        mobile: number.slice(-10),
        firstVerifiedMobile: number,
        mobileVerifiedAt: new Date(),
        fullName: 'Mobile Person',
        passwordHash: await hashPassword(randomUUID()),
        roleId: role.id,
      },
      select: { id: true },
    });
    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { number, token: issued.accessToken, id: user.id };
  }

  async function requestLinkCode(destination: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { destination, purpose: 'LINK', turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    expect(response.statusCode, response.body).toBe(202);
  }

  /** A confirmation code to the account's own number, for an account with no password. */
  async function reauthCode(account: { readonly number: string; readonly token: string }): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/reauth/otp',
      headers: bearer(account.token),
      payload: { turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    expect(response.statusCode, response.body).toBe(202);

    return codeFor(account.number);
  }

  beforeAll(async () => {
    db = await createMigratedTestDatabase('linking');

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

  it('adds an email address with a single-use link the account asked for', async () => {
    await redis.flushdb();
    clearCapturedOutbox();
    const account = await makeMobileOnlyAccount();
    const address = `link-${randomUUID().slice(0, 8)}@example.com`;

    const requested = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link',
      headers: bearer(account.token),
      payload: { email: address, code: await reauthCode(account) },
    });
    expect(requested.statusCode, requested.body).toBe(202);
    expect(requested.json<{ status: string }>().status).toBe('ACCEPTED');

    const token = linkTokenFor(address);
    const confirmed = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link/verify',
      headers: bearer(account.token),
      payload: { token },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json<{ status: string }>().status).toBe('EMAIL_LINKED');

    const row = await db.client.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.email).toBe(address);
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(await db.client.auditLog.count({ where: { action: 'IDENTITY_EMAIL_LINKED' } })).toBe(1);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link/verify',
      headers: bearer(account.token),
      payload: { token },
    });
    expect(replay.statusCode).toBe(400);
  });

  it('refuses a link token that belongs to a different account', async () => {
    await redis.flushdb();
    clearCapturedOutbox();
    const first = await makeMobileOnlyAccount();
    const second = await makeMobileOnlyAccount();
    const address = `theirs-${randomUUID().slice(0, 8)}@example.com`;

    await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link',
      headers: bearer(first.token),
      payload: { email: address, code: await reauthCode(first) },
    });
    const token = linkTokenFor(address);

    const stolen = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link/verify',
      headers: bearer(second.token),
      payload: { token },
    });
    expect(stolen.statusCode).toBe(400);
    expect((await db.client.user.findUniqueOrThrow({ where: { id: second.id } })).email).toBeNull();
  });

  it('answers an address that belongs to somebody else exactly like a link that was sent', async () => {
    await redis.flushdb();
    clearCapturedOutbox();
    const owner = await makeEmailAccount();
    const account = await makeMobileOnlyAccount();
    const mailsBefore = capturedOutbox().length;

    const requested = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link',
      headers: bearer(account.token),
      payload: { email: owner.email, code: await reauthCode(account) },
    });

    expect(requested.statusCode).toBe(202);
    expect(requested.json<{ status: string }>().status).toBe('ACCEPTED');
    expect(capturedOutbox().length).toBe(mailsBefore);
    expect((await db.client.user.findUniqueOrThrow({ where: { id: account.id } })).email).toBeNull();
    expect(
      await db.client.auditLog.count({
        where: { action: 'IDENTITY_EMAIL_LINK_REFUSED', metadata: { path: ['reason'], equals: 'ADDRESS_TAKEN' } },
      }),
    ).toBe(1);
  });

  it('refuses to add an email to an account that already has one', async () => {
    await redis.flushdb();
    const account = await makeEmailAccount();

    const requested = await app.inject({
      method: 'POST',
      url: '/v1/auth/email/link',
      headers: bearer(account.token),
      payload: { email: `another-${randomUUID().slice(0, 8)}@example.com`, password: PASSWORD },
    });

    expect(requested.statusCode).toBe(400);
    expect(requested.body).toMatch(/already has an email/);
  });

  it('adds a mobile number with a code, after proving the account with its password', async () => {
    await redis.flushdb();
    const account = await makeEmailAccount();
    const number = nextNumber();

    await requestLinkCode(number);
    const linked = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/link',
      headers: bearer(account.token),
      payload: { destination: number, code: codeFor(number), password: PASSWORD },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json<{ status: string }>().status).toBe('MOBILE_LINKED');

    const row = await db.client.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.firstVerifiedMobile).toBe(number);
    expect(row.mobile).toBe(number.slice(-10));
    expect(await db.client.auditLog.count({ where: { action: 'IDENTITY_MOBILE_LINKED' } })).toBe(1);
  });

  it('refuses the attempt when the password proof is wrong', async () => {
    await redis.flushdb();
    const account = await makeEmailAccount();
    const number = nextNumber();

    await requestLinkCode(number);
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/link',
      headers: bearer(account.token),
      payload: { destination: number, code: codeFor(number), password: 'not-the-password-1' },
    });
    expect(refused.statusCode).toBe(400);
    expect((await db.client.user.findUniqueOrThrow({ where: { id: account.id } })).firstVerifiedMobile).toBeNull();
  });

  it('refuses a number another account already owns, and audits the refusal', async () => {
    await redis.flushdb();
    const owner = await makeMobileOnlyAccount();
    const account = await makeEmailAccount();

    await requestLinkCode(owner.number);
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/link',
      headers: bearer(account.token),
      payload: { destination: owner.number, code: codeFor(owner.number), password: PASSWORD },
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatch(/cannot be added to this account/);
    expect(
      await db.client.auditLog.count({
        where: { action: 'IDENTITY_MOBILE_LINK_REFUSED', metadata: { path: ['reason'], equals: 'NUMBER_TAKEN' } },
      }),
    ).toBe(1);
  });

  it('removes a mobile number with the password, and refuses to remove the last identifier', async () => {
    await redis.flushdb();
    const account = await makeEmailAccount();
    const number = nextNumber();

    await requestLinkCode(number);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/link',
      headers: bearer(account.token),
      payload: { destination: number, code: codeFor(number), password: PASSWORD },
    });

    const unlinked = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/mobile/link',
      headers: bearer(account.token),
      payload: { password: PASSWORD },
    });
    expect(unlinked.statusCode, unlinked.body).toBe(200);
    const row = await db.client.user.findUniqueOrThrow({ where: { id: account.id } });
    expect(row.firstVerifiedMobile).toBeNull();
    expect(row.mobile).toBeNull();
    expect(await db.client.auditLog.count({ where: { action: 'IDENTITY_MOBILE_UNLINKED' } })).toBe(1);

    // An account whose only identifier is the number cannot lose it.
    const mobileOnly = await makeMobileOnlyAccount();
    const lastOne = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/mobile/link',
      headers: bearer(mobileOnly.token),
      payload: { code: await reauthCode(mobileOnly) },
    });
    expect(lastOne.statusCode).toBe(400);
    expect(lastOne.body).toMatch(/only way to sign in/);
  });

  it('keeps email linking with the switch off, and answers 404 on every mobile link route', async () => {
    const previous = { ...process.env };
    process.env.OTP_ENABLED = 'false';

    const disabled = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter({ trustProxy: true }),
      { logger: ['error'] },
    );
    await disabled.init();

    try {
      const account = await makeMobileOnlyAccount();
      const token = await app.get<SessionsService>(SESSIONS_SERVICE).issue(account.id);
      const headers = bearer(token.accessToken);

      for (const [method, url] of [
        ['POST', '/v1/auth/mobile/link'],
        ['DELETE', '/v1/auth/mobile/link'],
      ] as const) {
        const response = await disabled.inject({ method, url, headers, payload: {} });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }

      // Email linking does not depend on OTP, so it stays available.
      clearCapturedOutbox();
      const emailLink = await disabled.inject({
        method: 'POST',
        url: '/v1/auth/email/link',
        headers,
        payload: { email: `switch-off-${randomUUID().slice(0, 8)}@example.com` },
      });
      expect(emailLink.statusCode, emailLink.body).toBe(202);
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
