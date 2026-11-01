import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { hashPassword } from '../src/auth/password';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Settings, the audit viewer and the dashboard over real HTTP.
 *
 * The rules these tests exist for:
 * 1. A setting only accepts values its own row allows.
 * 2. Every setting change is audited, and the trail can be searched, paged and exported.
 * 3. Exporting is itself an audited act.
 * 4. An editor and a student cannot reach any of it.
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

describe('settings, audit and dashboard over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('operations');

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

  async function makePerson(roleCode: 'USER' | 'EDITOR' | 'ADMIN'): Promise<{ id: string; token: string }> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `ops-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Operations Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  function call(
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    token: string,
    payload?: Record<string, unknown>,
  ) {
    const headers = { authorization: `Bearer ${token}` };
    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  describe('settings', () => {
    it('seeds the platform settings the platform runs on', async () => {
      const admin = await makePerson('ADMIN');
      const response = await call('GET', '/v1/admin/settings', admin.token);
      expect(response.statusCode).toBe(200);

      const body = response.json() as { settings: Array<{ key: string; valueInt: number | null }> };
      const byKey = new Map(body.settings.map((row) => [row.key, row.valueInt]));

      expect(byKey.get('default_enrollment_cost')).toBe(100);
      expect(byKey.get('signup_coins')).toBe(1000);
      expect(byKey.get('daily_reward_coins')).toBe(10);
      expect(byKey.get('topic_rating_window_days')).toBe(7);
      expect(byKey.get('topic_min_attempted')).toBe(10);
      expect(byKey.get('topic_band_weak_below')).toBe(40);
      expect(byKey.get('topic_band_average_below')).toBe(70);
      expect(byKey.get('topic_band_good_below')).toBe(90);
    });

    it('accepts an in-bounds change and records it in the audit trail', async () => {
      const admin = await makePerson('ADMIN');

      const response = await call('PATCH', '/v1/admin/settings/default_enrollment_cost', admin.token, {
        value: 150,
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { valueInt: number }).valueInt).toBe(150);

      const audit = await db.client.auditLog.findFirst({
        where: { action: 'SETTINGS_CHANGED', actorUserId: admin.id },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audit).not.toBeNull();
      expect((audit?.metadata as { key?: string }).key).toBe('default_enrollment_cost');
      expect((audit?.metadata as { to?: number }).to).toBe(150);
    });

    it('refuses a value outside the bounds the row carries', async () => {
      const admin = await makePerson('ADMIN');

      const tooLarge = await call('PATCH', '/v1/admin/settings/signup_coins', admin.token, { value: 10_000_000 });
      expect(tooLarge.statusCode).toBe(400);

      const negative = await call('PATCH', '/v1/admin/settings/daily_reward_coins', admin.token, { value: -5 });
      expect(negative.statusCode).toBe(400);

      const notANumber = await call('PATCH', '/v1/admin/settings/signup_coins', admin.token, { value: 'many' });
      expect(notANumber.statusCode).toBe(400);
    });

    it('keeps the three topic bands in ascending order', async () => {
      const admin = await makePerson('ADMIN');

      const broken = await call('PATCH', '/v1/admin/settings/topic_band_weak_below', admin.token, { value: 80 });
      // 80 weak against 70 average is out of order; the database refuses it.
      expect(broken.statusCode).toBe(400);

      const stillOrdered = await call('PATCH', '/v1/admin/settings/topic_band_weak_below', admin.token, { value: 35 });
      expect(stillOrdered.statusCode).toBe(200);
    });
  });

  describe('the audit viewer', () => {
    it('filters by action and date and pages the result', async () => {
      const admin = await makePerson('ADMIN');
      await call('PATCH', '/v1/admin/settings/daily_reward_coins', admin.token, { value: 12 });

      const filtered = await call('GET', '/v1/admin/audit?action=SETTINGS_CHANGED&pageSize=5', admin.token);
      expect(filtered.statusCode).toBe(200);

      const body = filtered.json() as {
        items: Array<{ action: string; actorEmail: string | null }>;
        total: number;
        page: number;
      };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((row) => row.action === 'SETTINGS_CHANGED')).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(1);

      const today = new Date().toISOString().slice(0, 10);
      const byDate = await call('GET', `/v1/admin/audit?from=${today}&to=${today}`, admin.token);
      expect(byDate.statusCode).toBe(200);
      expect((byDate.json() as { total: number }).total).toBeGreaterThan(0);

      const byActor = await call('GET', `/v1/admin/audit?actorId=${admin.id}`, admin.token);
      expect(byActor.statusCode).toBe(200);
      const actorBody = byActor.json() as { items: Array<{ actorUserId: string | null }> };
      expect(actorBody.items.every((row) => row.actorUserId === admin.id)).toBe(true);

      const nonsense = await call('GET', '/v1/admin/audit?from=yesterday', admin.token);
      expect(nonsense.statusCode).toBe(400);
    });

    it('exports the same rows as CSV and records the export', async () => {
      const admin = await makePerson('ADMIN');
      await call('PATCH', '/v1/admin/settings/daily_reward_coins', admin.token, { value: 14 });

      const response = await call('GET', '/v1/admin/audit/export?action=SETTINGS_CHANGED', admin.token);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/csv');

      const lines = response.body.trim().split('\n');
      expect(lines[0]).toBe('occurred_at,actor_email,actor_role,action,entity_type,entity_id,ip,metadata');
      expect(lines.length).toBeGreaterThan(1);
      expect(response.body).toContain('SETTINGS_CHANGED');

      const exported = await db.client.auditLog.findFirst({
        where: { action: 'AUDIT_EXPORTED', actorUserId: admin.id },
      });
      expect(exported).not.toBeNull();
      expect((exported?.metadata as { rows?: number }).rows).toBeGreaterThan(0);
    });

    it('has no write path at all, and the database refuses one anyway', async () => {
      const admin = await makePerson('ADMIN');
      const auditRow = await db.client.auditLog.findFirst({ where: { actorUserId: admin.id } });

      expect(auditRow).not.toBeNull();

      await expect(
        db.client.$executeRawUnsafe(`DELETE FROM "audit_logs" WHERE "id" = $1::uuid`, auditRow?.id ?? ''),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('the dashboard', () => {
    it('reports real counts of what exists', async () => {
      const admin = await makePerson('ADMIN');
      const editor = await makePerson('EDITOR');

      const response = await call('GET', '/v1/admin/dashboard', admin.token);
      expect(response.statusCode).toBe(200);

      const counts = response.json() as {
        users: number;
        editors: number;
        administrators: number;
        activeSessions: number;
        categories: number;
        exams: number;
      };

      expect(counts.users).toBeGreaterThanOrEqual(2);
      expect(counts.editors).toBeGreaterThanOrEqual(1);
      expect(counts.administrators).toBeGreaterThanOrEqual(1);
      expect(counts.activeSessions).toBeGreaterThanOrEqual(2);
      expect(counts.categories).toBe(0);
      expect(counts.exams).toBe(0);

      // The editor cannot reach the dashboard, and no count changes because of this test.
      const asEditor = await call('GET', '/v1/admin/dashboard', editor.token);
      expect(asEditor.statusCode).toBe(403);
    });
  });

  describe('permissions', () => {
    it('refuses an editor and a student on every operations route', async () => {
      const editor = await makePerson('EDITOR');
      const student = await makePerson('USER');

      for (const person of [editor, student]) {
        expect((await call('GET', '/v1/admin/settings', person.token)).statusCode).toBe(403);
        expect((await call('PATCH', '/v1/admin/settings/signup_coins', person.token, { value: 5 })).statusCode).toBe(403);
        expect((await call('GET', '/v1/admin/audit', person.token)).statusCode).toBe(403);
        expect((await call('GET', '/v1/admin/audit/export', person.token)).statusCode).toBe(403);
        expect((await call('GET', '/v1/admin/dashboard', person.token)).statusCode).toBe(403);
      }

      // Nothing changed.
      const signupCoins = await db.client.setting.findUniqueOrThrow({ where: { key: 'signup_coins' } });
      expect(signupCoins.valueInt).toBe(1000);
    });
  });
});
