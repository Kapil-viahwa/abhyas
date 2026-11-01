import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { hashPassword } from '../src/auth/password';
import { EDITOR_FLAG_CODES } from '../src/admin/editor-flags';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * User administration over real HTTP: the editor capability model, the user list,
 * and the three writes an Administrator can perform on an account.
 *
 * The rules these tests exist for:
 * 1. Editor capability is an explicit grant; a role alone grants nothing to write.
 * 2. A write that invalidates a token ends that token at once.
 * 3. An editor and a student cannot reach any of it, and every write is audited.
 */

const PASSWORD = 'correct-horse-9battery';

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

interface Person {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

describe('user administration over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('users');

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

  async function makePerson(roleCode: 'USER' | 'EDITOR' | 'ADMIN', prefix = roleCode.toLowerCase()): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Managed Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, email, token: issued.accessToken };
  }

  function call(method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: Record<string, unknown>) {
    const headers = { authorization: `Bearer ${token}` };
    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  async function grant(flagCode: string, userId: string, grantedBy: string | null): Promise<void> {
    const permission = await db.client.permission.findUniqueOrThrow({
      where: { code: flagCode },
      select: { id: true },
    });
    await db.client.userPermission.create({
      data: { userId, permissionId: permission.id, grantedBy },
    });
  }

  async function codesOf(userId: string): Promise<string[]> {
    const rows = await db.client.userPermission.findMany({
      where: { userId },
      select: { permission: { select: { code: true } } },
    });
    return rows.map((row) => row.permission.code);
  }

  describe('editor capability is an explicit grant', () => {
    it('keeps the write codes off the EDITOR role entirely', async () => {
      const rows = await db.client.$queryRawUnsafe<Array<{ permission_code: string }>>(
        `SELECT p."code" AS permission_code
         FROM "role_permissions" rp
         JOIN "roles" r ON r."id" = rp."role_id"
         JOIN "permissions" p ON p."id" = rp."permission_id"
         WHERE r."code" = 'EDITOR'`,
      );

      const codes = rows.map((row) => row.permission_code);
      expect(new Set(codes)).toEqual(new Set(['content.read', 'tests.read']));
      for (const writeCode of EDITOR_FLAG_CODES) {
        expect(codes).not.toContain(writeCode);
      }
    });

    it('refuses to grant editor capability to a student', async () => {
      const student = await makePerson('USER');
      const permission = await db.client.permission.findUniqueOrThrow({
        where: { code: 'content.write' },
        select: { id: true },
      });

      await expect(
        db.client.userPermission.create({
          data: { userId: student.id, permissionId: permission.id },
        }),
      ).rejects.toThrow(/Editor capability may only be granted to an EDITOR account/);

      expect(await codesOf(student.id)).toEqual([]);
    });

    it('accepts editor capability on an editor and clears it when the role changes', async () => {
      const editor = await makePerson('EDITOR');
      await grant('tests.write', editor.id, null);

      expect(await codesOf(editor.id)).toEqual(['tests.write']);

      const userRole = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
      await db.client.user.update({ where: { id: editor.id }, data: { roleId: userRole.id } });

      // Demotion cannot leave capability behind: the database removes it.
      expect(await codesOf(editor.id)).toEqual([]);
    });
  });

  describe('the user list', () => {
    it('searches, filters and pages server-side', async () => {
      const admin = await makePerson('ADMIN');
      const marker = randomUUID().slice(0, 8);

      for (let index = 0; index < 3; index += 1) {
        const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
        await db.client.user.create({
          data: {
            email: `find-${marker}-${index}@example.com`,
            fullName: `Search Target ${index}`,
            passwordHash: 'placeholder-hash',
            roleId: role.id,
            status: index === 0 ? 'SUSPENDED' : 'ACTIVE',
          },
        });
      }

      const response = await call('GET', `/v1/admin/users?search=find-${marker}&pageSize=2`, admin.token);
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        items: Array<{ email: string; status: string; editorFlags: Record<string, boolean> }>;
        total: number;
        page: number;
        pageSize: number;
        pages: number;
      };

      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(2);
      expect(body.pages).toBe(2);
      expect(body.items).toHaveLength(2);

      const second = await call('GET', `/v1/admin/users?search=find-${marker}&pageSize=2&page=2`, admin.token);
      expect((second.json() as { items: unknown[] }).items).toHaveLength(1);

      const suspended = await call('GET', `/v1/admin/users?search=find-${marker}&status=SUSPENDED`, admin.token);
      const suspendedBody = suspended.json() as { items: Array<{ email: string }> };
      expect(suspendedBody.items).toHaveLength(1);
      expect(suspendedBody.items[0]?.email).toBe(`find-${marker}-0@example.com`);

      const editors = await call('GET', '/v1/admin/users?role=EDITOR', admin.token);
      const editorsBody = editors.json() as { items: Array<{ roleCode: string }> };
      expect(editorsBody.items.every((item) => item.roleCode === 'EDITOR')).toBe(true);
    });

    it("reads one account with the capability it holds and its live sessions", async () => {
      const admin = await makePerson('ADMIN');
      const editor = await makePerson('EDITOR');
      await grant('content.write', editor.id, admin.id);

      const response = await call('GET', `/v1/admin/users/${editor.id}`, admin.token);
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        id: string;
        roleCode: string;
        activeSessions: number;
        editorFlags: Record<string, boolean>;
      };

      expect(body.roleCode).toBe('EDITOR');
      expect(body.activeSessions).toBe(1);
      expect(body.editorFlags.manage_questions).toBe(true);
      // An omitted flag is a denial, and the read side says so.
      expect(body.editorFlags.publish_tests).toBe(false);
    });
  });

  describe('creating an editor', () => {
    it('creates the account and its grants together, and audits the creation', async () => {
      const admin = await makePerson('ADMIN');
      const email = `new-editor-${randomUUID().slice(0, 8)}@example.com`;

      const response = await call('POST', '/v1/admin/users/editors', admin.token, {
        email,
        fullName: 'New Editor',
        password: PASSWORD,
        manage_questions: true,
        publish_tests: true,
      });

      expect(response.statusCode).toBe(201);

      const body = response.json() as {
        id: string;
        roleCode: string;
        editorFlags: Record<string, boolean>;
      };
      expect(body.roleCode).toBe('EDITOR');
      expect(body.editorFlags.manage_questions).toBe(true);
      expect(body.editorFlags.manage_tests).toBe(false);
      expect(body.editorFlags.publish_tests).toBe(true);

      expect(new Set(await codesOf(body.id))).toEqual(new Set(['content.write', 'tests.publish']));

      const audit = await db.client.auditLog.findFirst({
        where: { action: 'IDENTITY_EDITOR_CREATED', entityId: body.id },
      });
      expect(audit).not.toBeNull();
    });

    it('refuses an address that already has an account', async () => {
      const admin = await makePerson('ADMIN');
      const existing = await makePerson('USER');

      const response = await call('POST', '/v1/admin/users/editors', admin.token, {
        email: existing.email,
        fullName: 'Duplicate Person',
        password: PASSWORD,
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe('editing an editor', () => {
    it('replaces the capability and ends that editor sessions', async () => {
      const admin = await makePerson('ADMIN');
      const editor = await makePerson('EDITOR');
      await grant('content.write', editor.id, admin.id);

      const response = await call('PATCH', `/v1/admin/users/${editor.id}/editor-flags`, admin.token, {
        manage_questions: false,
        manage_tests: true,
      });
      expect(response.statusCode).toBe(200);

      expect(new Set(await codesOf(editor.id))).toEqual(new Set(['tests.write']));

      // The editor's old token is dead on the very next call.
      const stale = await call('GET', '/v1/admin/ping', editor.token);
      expect(stale.statusCode).toBe(401);

      const audit = await db.client.auditLog.findFirst({
        where: { action: 'IDENTITY_EDITOR_FLAGS_CHANGED', entityId: editor.id },
      });
      expect(audit).not.toBeNull();
      expect((audit?.metadata as { after?: string[] }).after).toEqual(['tests.write']);

      const revoked = await db.client.session.findFirst({
        where: { userId: editor.id, revokeReason: 'ADMIN_REVOKED' },
      });
      expect(revoked).not.toBeNull();
    });

    it('refuses to hold flags on an account that is not an editor', async () => {
      const admin = await makePerson('ADMIN');
      const student = await makePerson('USER');

      const response = await call('PATCH', `/v1/admin/users/${student.id}/editor-flags`, admin.token, {
        manage_questions: true,
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('account status', () => {
    it('suspends an account, ends its sessions and refuses it afterwards', async () => {
      const admin = await makePerson('ADMIN');
      const student = await makePerson('USER');

      const suspended = await call('POST', `/v1/admin/users/${student.id}/status`, admin.token, {
        status: 'SUSPENDED',
      });
      expect(suspended.statusCode).toBe(200);
      expect((suspended.json() as { status: string }).status).toBe('SUSPENDED');

      const stale = await call('GET', '/v1/admin/ping', student.token);
      expect(stale.statusCode).toBe(401);

      const signIn = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: student.email, password: PASSWORD },
        remoteAddress: '198.51.100.31',
      });
      expect(signIn.statusCode).toBe(403);

      const audit = await db.client.auditLog.findFirst({
        where: { action: 'IDENTITY_USER_STATUS_CHANGED', entityId: student.id },
      });
      expect(audit).not.toBeNull();
      expect((audit?.metadata as { to?: string }).to).toBe('SUSPENDED');

      const restored = await call('POST', `/v1/admin/users/${student.id}/status`, admin.token, {
        status: 'ACTIVE',
      });
      expect(restored.statusCode).toBe(200);

      const signInAgain = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: student.email, password: PASSWORD },
        remoteAddress: '198.51.100.31',
      });
      expect(signInAgain.statusCode).toBe(200);
    });

    it('refuses to let an administrator lock themselves out', async () => {
      const admin = await makePerson('ADMIN');

      const response = await call('POST', `/v1/admin/users/${admin.id}/status`, admin.token, {
        status: 'DISABLED',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('only an administrator may do any of this', () => {
    it('refuses an editor on every admin route', async () => {
      const editor = await makePerson('EDITOR');
      const target = await makePerson('USER');

      const attempts = [
        await call('GET', '/v1/admin/users', editor.token),
        await call('GET', `/v1/admin/users/${target.id}`, editor.token),
        await call('POST', '/v1/admin/users/editors', editor.token, {
          email: `blocked-${randomUUID().slice(0, 8)}@example.com`,
          fullName: 'Blocked Editor',
          password: PASSWORD,
        }),
        await call('PATCH', `/v1/admin/users/${target.id}/editor-flags`, editor.token, { manage_questions: true }),
        await call('POST', `/v1/admin/users/${target.id}/status`, editor.token, { status: 'SUSPENDED' }),
        await call('PATCH', `/v1/admin/users/${target.id}/role`, editor.token, { roleCode: 'ADMIN' }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(403);
      }

      // Nothing changed on the target.
      const targetRow = await db.client.user.findUniqueOrThrow({
        where: { id: target.id },
        select: { status: true, role: { select: { code: true } } },
      });
      expect(targetRow.status).toBe('ACTIVE');
      expect(targetRow.role.code).toBe('USER');
    });

    it('refuses a student on every admin route', async () => {
      const student = await makePerson('USER');
      const target = await makePerson('USER');

      const attempts = [
        await call('GET', '/v1/admin/users', student.token),
        await call('GET', `/v1/admin/users/${target.id}`, student.token),
        await call('POST', '/v1/admin/users/editors', student.token, {
          email: `blocked-${randomUUID().slice(0, 8)}@example.com`,
          fullName: 'Blocked Student',
          password: PASSWORD,
        }),
        await call('PATCH', `/v1/admin/users/${target.id}/editor-flags`, student.token, { manage_questions: true }),
        await call('POST', `/v1/admin/users/${target.id}/status`, student.token, { status: 'SUSPENDED' }),
        await call('PATCH', `/v1/admin/users/${target.id}/role`, student.token, { roleCode: 'ADMIN' }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(403);
      }
    });
  });
});
