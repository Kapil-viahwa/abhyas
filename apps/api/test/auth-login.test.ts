import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { capturedOutbox } from '../src/infra/email-sender';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Sign-in and sign-out, over HTTP, against the real guard, the real session table
 * and the real rate limiter. The account is created and verified through the public
 * endpoints first, so the login under test is the one a student would perform.
 */

const PASSWORD = 'correct-horse-9battery';

/** Restored afterwards: the database tests share one process. */
const savedEnv: NodeJS.ProcessEnv = { ...process.env };

async function waitUntilHealthy(target: NestFastifyApplication, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';

  while (Date.now() < deadline) {
    const response = await target.inject({ method: 'GET', url: '/health' });
    if (response.statusCode === 200) {
      return;
    }
    last = `${response.statusCode} ${response.body}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The API never became healthy: ${last}`);
}

describe('login and logout over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('login');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitUntilHealthy(app);
  }, 180_000);

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

  async function register(email: string, ip: string): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, fullName: 'Asha Verma', turnstileToken: TURNSTILE_TEST_TOKEN },
      remoteAddress: ip,
    });
    expect(response.statusCode).toBe(202);
  }

  /** Follows the link the outbox printed, so the real path is the one tested. */
  async function registerAndVerify(email: string, ip: string): Promise<void> {
    await register(email, ip);

    const message = capturedOutbox()
      .filter((entry) => entry.to === email)
      .at(-1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1] ?? '';

    const verify = await app.inject({ method: 'POST', url: '/v1/auth/verify-email', payload: { token } });
    expect(verify.statusCode).toBe(200);
  }

  function loginRequest(email: string, password: string, ip: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password, turnstileToken: TURNSTILE_TEST_TOKEN },
      remoteAddress: ip,
    });
  }

  it('logs in with an opaque token and logout makes it fail at once', async () => {
    await redis.flushdb();
    const email = `login-${randomUUID().slice(0, 8)}@example.com`;
    await registerAndVerify(email, '198.51.100.21');

    const login = await loginRequest(email, PASSWORD, '198.51.100.21');
    expect(login.statusCode).toBe(200);

    const body = login.json() as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; email: string; roleCode: string };
    };

    expect(body.user.email).toBe(email);
    expect(body.user.roleCode).toBe('USER');

    const session = await db.client.session.findFirstOrThrow({
      where: { userId: body.user.id },
      select: { id: true, accessTokenHash: true, revokeReason: true },
    });

    // Only the hash is stored: the bearer token exists in the response and nowhere else.
    expect(session.accessTokenHash).not.toBe(body.accessToken);
    expect(session.accessTokenHash).toHaveLength(64);
    expect(session.revokeReason).toBeNull();

    const loginAudit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_LOGIN_SUCCEEDED', entityId: body.user.id },
    });
    expect(loginAudit).not.toBeNull();

    const logout = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ status: 'SIGNED_OUT' });

    const replayed = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(replayed.statusCode).toBe(401);

    const revoked = await db.client.session.findUniqueOrThrow({
      where: { id: session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokeReason).toBe('LOGOUT');

    const logoutAudit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_LOGOUT', entityId: body.user.id },
    });
    expect(logoutAudit).not.toBeNull();
  });

  it('gives an unknown address and a wrong password the same answer', async () => {
    await redis.flushdb();
    const email = `enum-${randomUUID().slice(0, 8)}@example.com`;
    await registerAndVerify(email, '198.51.100.22');

    const unknown = await loginRequest(`nobody-${randomUUID().slice(0, 8)}@example.com`, PASSWORD, '198.51.100.23');
    const wrong = await loginRequest(email, 'wrong-password-9x', '198.51.100.23');

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());

    const anonymousFailure = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_LOGIN_FAILED', actorUserId: null, entityId: null },
    });
    expect(anonymousFailure).not.toBeNull();

    const badPasswordFailure = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_LOGIN_FAILED', actorUserId: { not: null } },
    });
    expect(badPasswordFailure).not.toBeNull();
  });

  it('refuses a deactivated account', async () => {
    await redis.flushdb();
    const email = `disabled-${randomUUID().slice(0, 8)}@example.com`;
    await registerAndVerify(email, '198.51.100.24');
    await db.client.user.update({ where: { email }, data: { status: 'DISABLED' } });

    const response = await loginRequest(email, PASSWORD, '198.51.100.24');

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/not active/);
  });

  it('refuses an account whose email is not verified', async () => {
    await redis.flushdb();
    const email = `unverified-${randomUUID().slice(0, 8)}@example.com`;
    await register(email, '198.51.100.25');

    const response = await loginRequest(email, PASSWORD, '198.51.100.25');

    expect(response.statusCode).toBe(403);
    expect(response.json().message).toMatch(/Verify your email/);
  });

  it('throttles password guesses against one account', async () => {
    await redis.flushdb();
    const email = `brute-${randomUUID().slice(0, 8)}@example.com`;
    await registerAndVerify(email, '198.51.100.26');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await loginRequest(email, `wrong-password-9x-${attempt}`, '198.51.100.27');
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});
