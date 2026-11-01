import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { capturedOutbox } from '../src/infra/email-sender';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The API booted for real, against Postgres and Redis, spoken to over HTTP.
 *
 * Nothing is mocked: the guard, the permission matrix, the rate limiter, the email
 * outbox and the database constraints are the ones the process uses in production.
 * The application connects as `abhyas_app`, so a privilege mistake shows up here.
 */

const PASSWORD = 'correct-horse-9battery';

/** Restored afterwards: the database tests share one process. */
const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('auth over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('http');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: false,
    });
    await app.init();
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

  async function createUserWithSession(roleCode: 'USER' | 'EDITOR' | 'ADMIN'): Promise<string> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Test Person',
        passwordHash: 'placeholder-hash',
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const sessions = app.get<SessionsService>(SESSIONS_SERVICE);
    const issued = await sessions.issue(user.id);

    return issued.accessToken;
  }

  it('serves /health without a token and refuses an admin route without one', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const anonymous = await app.inject({ method: 'GET', url: '/v1/admin/ping' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses a student and an editor on an admin route, and admits an administrator', async () => {
    const studentToken = await createUserWithSession('USER');
    const student = await app.inject({
      method: 'GET',
      url: '/v1/admin/ping',
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(student.statusCode).toBe(403);

    const editorToken = await createUserWithSession('EDITOR');
    const editor = await app.inject({
      method: 'GET',
      url: '/v1/admin/ping',
      headers: { authorization: `Bearer ${editorToken}` },
    });
    expect(editor.statusCode).toBe(403);

    const adminToken = await createUserWithSession('ADMIN');
    const admin = await app.inject({
      method: 'GET',
      url: '/v1/admin/ping',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toEqual({ status: 'ok' });
  });

  it('registers an account, writes the outbox row and verifies the emailed token once', async () => {
    await redis.flushdb();
    const email = `student-${randomUUID().slice(0, 8)}@example.com`;

    const register = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, fullName: 'Asha Verma', turnstileToken: TURNSTILE_TEST_TOKEN },
      remoteAddress: '198.51.100.11',
    });
    expect(register.statusCode).toBe(202);
    expect(register.json()).toEqual({ status: 'PENDING_VERIFICATION' });

    const user = await db.client.user.findUniqueOrThrow({
      where: { email },
      select: { id: true, emailVerifiedAt: true, role: { select: { code: true } } },
    });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.role.code).toBe('USER');

    const token = await db.client.emailToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'VERIFY_EMAIL' },
      select: { usedAt: true },
    });
    expect(token.usedAt).toBeNull();

    const events = await db.client.domainEvent.findMany({ where: { name: 'user.registered' } });
    expect(events.some((event) => (event.payload as { userId?: string }).userId === user.id)).toBe(true);

    const audits = await db.client.auditLog.findMany({ where: { action: 'IDENTITY_USER_REGISTERED' } });
    expect(audits.some((row) => row.entityId === user.id)).toBe(true);

    const message = capturedOutbox()
      .filter((entry) => entry.to === email)
      .at(-1);
    expect(message).toBeDefined();

    const linked = /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');
    expect(linked).not.toBeNull();
    const rawToken = linked?.[1] ?? '';

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: rawToken },
      remoteAddress: '198.51.100.11',
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ status: 'VERIFIED' });

    const verified = await db.client.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { emailVerifiedAt: true },
    });
    expect(verified.emailVerifiedAt).not.toBeNull();

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: rawToken },
      remoteAddress: '198.51.100.11',
    });
    expect(replay.statusCode).toBe(400);
  });

  it('answers an existing address exactly like an unknown one and keeps one account', async () => {
    await redis.flushdb();
    const email = `duplicate-${randomUUID().slice(0, 8)}@example.com`;
    const payload = { email, password: PASSWORD, fullName: 'Asha Verma', turnstileToken: TURNSTILE_TEST_TOKEN };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload,
      remoteAddress: '198.51.100.12',
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload,
      remoteAddress: '198.51.100.12',
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(await db.client.user.count({ where: { email } })).toBe(1);
  });

  it('throttles registration from one address after five attempts', async () => {
    await redis.flushdb();
    const statuses: number[] = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          email: `throttle-${attempt}-${randomUUID().slice(0, 8)}@example.com`,
          password: PASSWORD,
          fullName: 'Throttle Test',
          turnstileToken: TURNSTILE_TEST_TOKEN,
        },
        remoteAddress: '203.0.113.55',
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
  });

  it('refuses a registration that fails human verification', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `bot-${randomUUID().slice(0, 8)}@example.com`,
        password: PASSWORD,
        fullName: 'Bot Test',
        turnstileToken: 'not-the-test-token',
      },
      remoteAddress: '192.0.2.44',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a password that does not meet the policy', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `weak-${randomUUID().slice(0, 8)}@example.com`,
        password: 'short',
        fullName: 'Weak Password',
        turnstileToken: TURNSTILE_TEST_TOKEN,
      },
      remoteAddress: '192.0.2.45',
    });

    expect(response.statusCode).toBe(400);
  });

  describe('production boot', () => {
    const overrides: Record<string, string> = {
      NODE_ENV: 'production',
      AUTH_SECRET: 'p'.repeat(48),
      TURNSTILE_SECRET_KEY: 'live-turnstile-secret',
      SMS_PROVIDER: 'msg91',
      EMAIL_PROVIDER: 'smtp',
      SMTP_URL: 'smtp://smtp.example.com:587',
      WEB_URL: 'https://abhyas.example.com',
    };

    let previous: Record<string, string | undefined> = {};
    let productionApp: NestFastifyApplication | undefined;

    beforeAll(async () => {
      previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
      Object.assign(process.env, overrides);

      productionApp = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
        logger: false,
      });
      await productionApp.init();
    }, 60_000);

    afterAll(async () => {
      await productionApp?.close();

      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }, 60_000);

    it('does not mount the OpenAPI document and still serves health', async () => {
      const docs = await productionApp?.inject({ method: 'GET', url: '/api/docs-json' });
      expect(docs?.statusCode).toBe(404);

      const ui = await productionApp?.inject({ method: 'GET', url: '/api/docs' });
      expect(ui?.statusCode).toBe(404);

      const health = await productionApp?.inject({ method: 'GET', url: '/health' });
      expect(health?.statusCode).toBe(200);
    });
  });
});
