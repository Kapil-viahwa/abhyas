import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { capturedOutbox, clearCapturedOutbox } from '../src/infra/email-sender';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The account lifecycle over HTTP: refresh rotation, session listing and revocation,
 * password change, reset and deactivation, and an administrator changing a role.
 *
 * Every assertion here is about a credential or a session dying at the moment the
 * rule says it must — not eventually, not after a cache expires.
 */

const PASSWORD = 'correct-horse-9battery';
const NEW_PASSWORD = 'battery-horse-9-correct';

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

interface SignedIn {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: { readonly id: string; readonly email: string; readonly roleCode: string };
}

describe('account lifecycle over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('lifecycle');

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

  /** An account created directly, with the real password module, ready to sign in. */
  async function makeUser(email: string, roleCode: 'USER' | 'EDITOR' | 'ADMIN' = 'USER'): Promise<string> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Lifecycle Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    return user.id;
  }

  async function signIn(email: string, ip: string, password = PASSWORD): Promise<SignedIn> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
      remoteAddress: ip,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as SignedIn;
  }

  function sessionsOf(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function authenticated(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    accessToken: string,
    payload?: Record<string, unknown>,
  ) {
    const headers = { authorization: `Bearer ${accessToken}` };

    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  it('rotates the refresh token and revokes the family when a rotated one is replayed', async () => {
    await redis.flushdb();
    const email = `refresh-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(email);
    const first = await signIn(email, '198.51.100.101');

    const rotated = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
      remoteAddress: '198.51.100.101',
    });
    expect(rotated.statusCode).toBe(200);

    const next = rotated.json() as { accessToken: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(next.accessToken).not.toBe(first.accessToken);
    expect((await sessionsOf(next.accessToken)).statusCode).toBe(200);

    // Replaying the rotated token: the family is revoked, and the answer is exactly
    // the one an unknown token gets.
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
      remoteAddress: '198.51.100.101',
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'not-a-real-refresh-token' },
      remoteAddress: '198.51.100.101',
    });

    expect(replay.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(replay.json()).toEqual(unknown.json());

    // The token issued by the rotation is dead too: the whole family went, and the
    // access token that belonged to it stopped working at once.
    const afterReplay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: next.refreshToken },
      remoteAddress: '198.51.100.101',
    });
    expect(afterReplay.statusCode).toBe(401);
    expect((await sessionsOf(next.accessToken)).statusCode).toBe(401);

    const family = await db.client.session.findMany({ where: { userId } });
    expect(family.length).toBeGreaterThan(0);
    expect(family.some((row) => row.revokeReason === 'REUSE_DETECTED')).toBe(true);
    expect(family.every((row) => row.revokedAt !== null)).toBe(true);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_REFRESH_REUSE_DETECTED', entityId: userId },
    });
    expect(audit).not.toBeNull();
  });

  it('lists the live sessions with a current marker and revokes one it owns', async () => {
    await redis.flushdb();
    const email = `list-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(email);

    const first = await signIn(email, '198.51.100.102');
    const second = await signIn(email, '198.51.100.103');

    const list = await sessionsOf(first.accessToken);
    expect(list.statusCode).toBe(200);

    const body = list.json() as {
      sessions: Array<{ id: string; current: boolean; ip: string | null; lastUsedAt: string }>;
    };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions.filter((session) => session.current)).toHaveLength(1);
    expect(body.sessions.every((session) => typeof session.lastUsedAt === 'string')).toBe(true);
    expect(new Set(body.sessions.map((session) => session.ip))).toEqual(
      new Set(['198.51.100.102', '198.51.100.103']),
    );

    const other = body.sessions.find((session) => !session.current);
    expect(other).toBeDefined();

    const revoked = await authenticated('DELETE', `/v1/auth/sessions/${other?.id ?? ''}`, first.accessToken);
    expect(revoked.statusCode).toBe(200);

    // The revoked session's access token fails on the very next call; mine still works.
    expect((await sessionsOf(second.accessToken)).statusCode).toBe(401);
    expect((await sessionsOf(first.accessToken)).statusCode).toBe(200);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_SESSION_REVOKED', entityId: userId },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses to revoke somebody else's session", async () => {
    await redis.flushdb();
    const mineEmail = `mine-${randomUUID().slice(0, 8)}@example.com`;
    await makeUser(mineEmail);
    const mine = await signIn(mineEmail, '198.51.100.104');
    const theirsEmail = `theirs-${randomUUID().slice(0, 8)}@example.com`;
    await makeUser(theirsEmail);
    const theirs = await signIn(theirsEmail, '198.51.100.105');

    const theirList = await sessionsOf(theirs.accessToken);
    const theirSessionId = (theirList.json() as { sessions: Array<{ id: string; current: boolean }> }).sessions.find(
      (session) => session.current,
    )?.id;

    const attempt = await authenticated('DELETE', `/v1/auth/sessions/${theirSessionId ?? ''}`, mine.accessToken);
    expect(attempt.statusCode).toBe(404);

    // Their session is untouched.
    expect((await sessionsOf(theirs.accessToken)).statusCode).toBe(200);
  });

  it('ends every other session on request and keeps the one that asked', async () => {
    await redis.flushdb();
    const email = `others-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(email);

    const first = await signIn(email, '198.51.100.106');
    const second = await signIn(email, '198.51.100.107');

    const response = await authenticated('POST', '/v1/auth/sessions/revoke-others', first.accessToken);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'REVOKED', revoked: 1 });

    expect((await sessionsOf(second.accessToken)).statusCode).toBe(401);
    expect((await sessionsOf(first.accessToken)).statusCode).toBe(200);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_SESSIONS_REVOKED', entityId: userId },
    });
    expect(audit).not.toBeNull();
  });

  it('changes the password, keeps this session and kills the others', async () => {
    await redis.flushdb();
    const email = `change-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(email);

    const first = await signIn(email, '198.51.100.108');
    const second = await signIn(email, '198.51.100.109');

    const wrongCurrent = await authenticated('POST', '/v1/auth/password/change', first.accessToken, {
      currentPassword: 'not-my-password-9x',
      newPassword: NEW_PASSWORD,
    });
    expect(wrongCurrent.statusCode).toBe(400);

    const changed = await authenticated('POST', '/v1/auth/password/change', first.accessToken, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ status: 'PASSWORD_CHANGED' });

    // The session that changed the password survives; the other one is gone.
    expect((await sessionsOf(first.accessToken)).statusCode).toBe(200);
    expect((await sessionsOf(second.accessToken)).statusCode).toBe(401);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: '198.51.100.110',
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: NEW_PASSWORD },
      remoteAddress: '198.51.100.110',
    });
    expect(newPassword.statusCode).toBe(200);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_PASSWORD_CHANGED', entityId: userId },
    });
    expect(audit).not.toBeNull();

    const revoked = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_SESSIONS_REVOKED', entityId: userId },
    });
    expect(revoked).not.toBeNull();
  });

  it('resets the password with a single-use link that ends every session', async () => {
    await redis.flushdb();
    clearCapturedOutbox();
    const email = `reset-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(email);

    const first = await signIn(email, '198.51.100.111');
    const second = await signIn(email, '198.51.100.112');

    const unknownEmail = `nobody-${randomUUID().slice(0, 8)}@example.com`;
    const known = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email, turnstileToken: TURNSTILE_TEST_TOKEN },
      remoteAddress: '198.51.100.113',
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: unknownEmail, turnstileToken: TURNSTILE_TEST_TOKEN },
      remoteAddress: '198.51.100.114',
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(known.json()).toEqual({ status: 'RESET_REQUESTED' });

    const message = capturedOutbox()
      .filter((entry) => entry.to === email)
      .at(-1);
    const token = /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1] ?? '';
    expect(token).not.toBe('');

    const reset = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword: NEW_PASSWORD },
      remoteAddress: '198.51.100.115',
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ status: 'PASSWORD_RESET' });

    // Every session is gone, including the one that asked for the reset.
    expect((await sessionsOf(first.accessToken)).statusCode).toBe(401);
    expect((await sessionsOf(second.accessToken)).statusCode).toBe(401);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword: 'another-password-9x' },
      remoteAddress: '198.51.100.115',
    });
    expect(replay.statusCode).toBe(400);

    const oldPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: '198.51.100.116',
    });
    expect(oldPassword.statusCode).toBe(401);

    const newPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: NEW_PASSWORD },
      remoteAddress: '198.51.100.116',
    });
    expect(newPassword.statusCode).toBe(200);

    const requested = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_PASSWORD_RESET_REQUESTED', entityId: userId },
    });
    expect(requested).not.toBeNull();

    const completed = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_PASSWORD_RESET', entityId: userId },
    });
    expect(completed).not.toBeNull();
  });

  it('deactivates the account behind the password and ends every session at once', async () => {
    await redis.flushdb();
    const email = `deactivate-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(email);
    const signedIn = await signIn(email, '198.51.100.117');

    const wrong = await authenticated('POST', '/v1/auth/deactivate', signedIn.accessToken, {
      password: 'not-my-password-9x',
    });
    expect(wrong.statusCode).toBe(400);
    expect((await sessionsOf(signedIn.accessToken)).statusCode).toBe(200);

    const deactivated = await authenticated('POST', '/v1/auth/deactivate', signedIn.accessToken, {
      password: PASSWORD,
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json()).toEqual({ status: 'DEACTIVATED' });

    expect((await sessionsOf(signedIn.accessToken)).statusCode).toBe(401);

    const signInAgain = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: '198.51.100.117',
    });
    expect(signInAgain.statusCode).toBe(403);
    expect(signInAgain.json().message).toMatch(/not active/);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_ACCOUNT_DEACTIVATED', entityId: userId },
    });
    expect(audit).not.toBeNull();
  });

  it('lets an administrator change a role, which ends that user sessions, and refuses everyone else', async () => {
    await redis.flushdb();
    const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.com`;
    const adminId = await makeUser(adminEmail, 'ADMIN');
    const adminToken = (await app.get<SessionsService>(SESSIONS_SERVICE).issue(adminId)).accessToken;

    const userEmail = `promote-${randomUUID().slice(0, 8)}@example.com`;
    const userId = await makeUser(userEmail);
    const student = await signIn(userEmail, '198.51.100.118');

    const editorEmail = `editor-${randomUUID().slice(0, 8)}@example.com`;
    await makeUser(editorEmail, 'EDITOR');
    const editor = await signIn(editorEmail, '198.51.100.119');

    // Only roles.write may do this: a student and an editor are refused.
    const asStudent = await authenticated('PATCH', `/v1/admin/users/${userId}/role`, student.accessToken, {
      roleCode: 'EDITOR',
    });
    expect(asStudent.statusCode).toBe(403);

    const asEditor = await authenticated('PATCH', `/v1/admin/users/${userId}/role`, editor.accessToken, {
      roleCode: 'EDITOR',
    });
    expect(asEditor.statusCode).toBe(403);

    const changed = await authenticated('PATCH', `/v1/admin/users/${userId}/role`, adminToken, {
      roleCode: 'EDITOR',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ userId, roleCode: 'EDITOR', sessionsRevoked: 1 });

    // The session that existed before the role change is dead at once.
    expect((await sessionsOf(student.accessToken)).statusCode).toBe(401);

    // Signing in again carries the new role, and the new permissions with it.
    const promoted = await signIn(userEmail, '198.51.100.118');
    expect(promoted.user.roleCode).toBe('EDITOR');
    expect((await sessionsOf(promoted.accessToken)).statusCode).toBe(200);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_ROLE_CHANGED', entityId: userId },
    });
    expect(audit).not.toBeNull();
    expect((audit?.metadata as { toRole?: string }).toRole).toBe('EDITOR');
  });
});
