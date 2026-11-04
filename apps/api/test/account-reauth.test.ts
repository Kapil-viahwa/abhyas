import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { REAUTH_WINDOW_MS } from '../src/auth/reauthentication.service';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { createApiApplication } from '../src/bootstrap';
import { RedisService } from '../src/infra/redis.service';
import { REDIS_PROBE } from '../src/infra/tokens';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';
import { OTP_SMS_PROVIDER, type FakeSmsProvider, type SmsProvider } from '../src/otp/sms-provider';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * An account with no email address, over real HTTP.
 *
 * Every rule here exists because `users.email` became nullable in phase 2c, and a nullable
 * column is only safe once every read of it has been checked:
 *
 * 1. Password sign-in cannot find such an account, so it must answer exactly like an
 *    unknown address — the same body, the same timing path.
 * 2. A forgotten password cannot be mailed anywhere, and must not say so.
 * 3. Administrative screens and exports must show it without crashing or printing "null".
 * 4. Changing a password or deactivating the account must still prove it is the holder:
 *    a code sent to the account's own number, or a sign-in from minutes ago.
 * 5. The database refuses an account with neither identifier, and two accounts cannot
 *    share an email or a mobile.
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

describe('an account with no email address', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;
  let provider!: FakeSmsProvider;

  let numberCounter = 0;
  let ipCounter = 0;

  function nextNumber(): string {
    numberCounter += 1;
    return `+9177${String(numberCounter).padStart(8, '0')}`;
  }

  function nextIp(): string {
    ipCounter += 1;
    return `198.51.100.${String(ipCounter)}`;
  }

  function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  async function requestCode(destination: string, purpose: 'SIGNUP' | 'LOGIN' | 'REAUTH'): Promise<void> {
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

  /** A mobile-first account, created exactly the way a student would create one. */
  async function registerMobileAccount(fullName: string): Promise<{ destination: string; token: string; id: string }> {
    const destination = nextNumber();
    await requestCode(destination, 'SIGNUP');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/mobile/register',
      payload: { destination, code: codeFor(destination), fullName },
    });
    expect(response.statusCode, response.body).toBe(201);

    const body = response.json<{ accessToken: string; user: { id: string } }>();
    return { destination, token: body.accessToken, id: body.user.id };
  }

  async function issueAdmin(): Promise<string> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'ADMIN' }, select: { id: true } });
    const admin = await db.client.user.create({
      data: {
        email: `reauth-admin-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Reauth Admin',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(admin.id);
    return issued.accessToken;
  }

  beforeAll(async () => {
    db = await createMigratedTestDatabase('reauth');

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

  it('answers a password sign-in exactly as it answers an unknown address', async () => {
    await redis.flushdb();
    const account = await registerMobileAccount('No Email Student');
    const address = `absent-${randomUUID().slice(0, 8)}@example.com`;

    const forAccount = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: address, password: PASSWORD },
    });
    const forUnknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: `never-${randomUUID().slice(0, 8)}@example.com`, password: PASSWORD },
    });

    expect(forAccount.statusCode).toBe(401);
    expect(forAccount.body).toBe(forUnknown.body);
    expect(await db.client.user.count({ where: { id: account.id, email: null } })).toBe(1);
  });

  it('answers a password reset exactly as it answers an unknown address', async () => {
    await redis.flushdb();
    await registerMobileAccount('No Reset Student');

    const known = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: `reauth-${randomUUID().slice(0, 8)}@example.com`, turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { email: `nobody-${randomUUID().slice(0, 8)}@example.com`, turnstileToken: TURNSTILE_TEST_TOKEN },
    });

    expect(known.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
  });

  it('shows up in the admin list and detail, and in the audit export, without a broken email', async () => {
    await redis.flushdb();
    const account = await registerMobileAccount('Listed Student');
    const adminToken = await issueAdmin();

    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/users?search=Listed',
      headers: bearer(adminToken),
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json<{ items: Array<{ id: string; email: string | null }> }>().items;
    const row = listed.find((entry) => entry.id === account.id);
    expect(row).toBeDefined();
    expect(row?.email).toBeNull();

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${account.id}`,
      headers: bearer(adminToken),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ email: string | null }>().email).toBeNull();

    const exported = await app.inject({ method: 'GET', url: '/v1/admin/audit/export', headers: bearer(adminToken) });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain('IDENTITY_MOBILE_REGISTERED');

    // The sessions screen reads the same account and must not be affected either.
    const sessions = await app.inject({ method: 'GET', url: '/v1/auth/sessions', headers: bearer(account.token) });
    expect(sessions.statusCode).toBe(200);
  });

  it('requires the code from a password-less account while OTP is on, and takes a fresh session once it is off', async () => {
    await redis.flushdb();
    const account = await registerMobileAccount('Fresh Student');

    // With the switch on, a session minutes old is not the proof: a code to the account's
    // own number is (decision 0050, as tightened in phase 2c).
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(account.token),
      payload: { newPassword: 'another-good-password-7' },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.body).toMatch(/Enter the code sent to your mobile number/);

    // With the switch off there is no code to ask for, so a fresh session is the proof.
    process.env.OTP_ENABLED = 'false';
    const withoutOtp = await createApiApplication({ logger: ['error'] });
    try {
      await withoutOtp.app.init();

      const changed = await withoutOtp.app.inject({
        method: 'POST',
        url: '/v1/auth/password/change',
        headers: bearer(account.token),
        payload: { newPassword: 'another-good-password-7' },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(
        await db.client.auditLog.count({ where: { action: 'IDENTITY_PASSWORD_CHANGED', actorUserId: account.id } }),
      ).toBe(1);

      // The freshness rule still bites: a session older than the window is refused.
      const second = await registerMobileAccount('Stale Student');
      await db.client.session.updateMany({
        where: { userId: second.id },
        data: { issuedAt: new Date(Date.now() - REAUTH_WINDOW_MS - 60_000) },
      });

      const stale = await withoutOtp.app.inject({
        method: 'POST',
        url: '/v1/auth/password/change',
        headers: bearer(second.token),
        payload: { newPassword: 'another-good-password-8' },
      });
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toMatch(/Confirm it is you/);
    } finally {
      process.env.OTP_ENABLED = 'true';
      await withoutOtp.app.close();
    }
  });

  it('locks confirmation after five wrong proofs, and audits every one of them', async () => {
    await redis.flushdb();
    const account = await registerMobileAccount('Locked Student');
    const statuses: number[] = [];

    for (let index = 0; index < 6; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/password/change',
        headers: bearer(account.token),
        payload: { currentPassword: `wrong-password-${String(index)}`, newPassword: 'another-good-password-1' },
      });
      statuses.push(response.statusCode);
    }

    // Five refusals that each name the wrong password, then the counter closes the door.
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses[5]).toBe(429);

    expect(
      await db.client.auditLog.count({ where: { action: 'IDENTITY_REAUTH_FAILED', actorUserId: account.id } }),
    ).toBe(5);
  });

  it('accepts a code from the account’s own number as the proof, on a stale session', async () => {
    await redis.flushdb();
    const account = await registerMobileAccount('Code Student');
    await db.client.session.updateMany({
      where: { userId: account.id },
      data: { issuedAt: new Date(Date.now() - REAUTH_WINDOW_MS - 60_000) },
    });

    const sent = await app.inject({
      method: 'POST',
      url: '/v1/auth/reauth/otp',
      headers: bearer(account.token),
      payload: { turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    expect(sent.statusCode, sent.body).toBe(202);

    const code = codeFor(account.destination);
    const changed = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(account.token),
      payload: { newPassword: 'another-good-password-9', code },
    });
    expect(changed.statusCode, changed.body).toBe(200);

    // The code is spent: a second use cannot deactivate the account.
    const deactivate = await app.inject({
      method: 'POST',
      url: '/v1/auth/deactivate',
      headers: bearer(account.token),
      payload: { code },
    });
    expect(deactivate.statusCode).toBe(400);

    const audited = await db.client.auditLog.findMany({
      where: { action: 'OTP_VERIFIED', metadata: { path: ['purpose'], equals: 'REAUTH' } },
      select: { id: true },
    });
    expect(audited.length).toBeGreaterThan(0);
  });

  it('deactivates a password-less account with a code, ending every session', async () => {
    await redis.flushdb();
    const account = await registerMobileAccount('Leaving Student');

    await app.inject({
      method: 'POST',
      url: '/v1/auth/reauth/otp',
      headers: bearer(account.token),
      payload: { turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    const code = codeFor(account.destination);

    const deactivated = await app.inject({
      method: 'POST',
      url: '/v1/auth/deactivate',
      headers: bearer(account.token),
      payload: { code },
    });
    expect(deactivated.statusCode, deactivated.body).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: bearer(account.token) });
    expect(after.statusCode).toBe(401);
    expect(
      (await db.client.user.findUniqueOrThrow({ where: { id: account.id }, select: { status: true } })).status,
    ).toBe('DISABLED');
  });

  it('still demands the password from an account that has one, even on a fresh session', async () => {
    await redis.flushdb();
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const person = await db.client.user.create({
      data: {
        email: `has-email-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Has Email',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(person.id);

    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/change',
      headers: bearer(issued.accessToken),
      payload: { newPassword: 'another-good-password-0' },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toMatch(/Enter your current password/);
  });

  it('refuses an account with neither identifier, and a duplicate identifier in any case', async () => {
    const nothing = await db.client.$executeRawUnsafe(
      `INSERT INTO "users" ("email", "mobile", "first_verified_mobile", "password_hash", "full_name", "role_id")
       SELECT NULL, NULL, NULL, 'x', 'Nobody', "id" FROM "roles" WHERE "code" = 'USER'`,
    ).catch((error: unknown) => error);

    expect(nothing).toBeInstanceOf(Error);
    expect(String(nothing)).toMatch(/users_identifier_present/);

    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const passwordHash = await hashPassword(PASSWORD);

    await db.client.user.create({
      data: { email: 'Shout@Example.com', fullName: 'Shout', passwordHash, roleId: role.id },
    });

    const duplicateEmail = await db.client.user
      .create({ data: { email: 'shout@example.com', fullName: 'Quiet', passwordHash, roleId: role.id } })
      .catch((error: unknown) => error);
    expect(duplicateEmail).toBeInstanceOf(Error);

    await db.client.user.create({
      data: {
        email: 'first-mobile@example.com',
        mobile: '9876500001',
        firstVerifiedMobile: '+919876500001',
        fullName: 'First Mobile',
        passwordHash,
        roleId: role.id,
      },
    });

    const duplicateMobile = await db.client.user
      .create({
        data: {
          email: 'second-mobile@example.com',
          mobile: '9876500001',
          fullName: 'Second Mobile',
          passwordHash,
          roleId: role.id,
        },
      })
      .catch((error: unknown) => error);
    expect(duplicateMobile).toBeInstanceOf(Error);
  });
});
