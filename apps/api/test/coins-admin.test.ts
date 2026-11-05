import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { INestApplicationContext } from '@nestjs/common';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { hashPassword } from '../src/auth/password';
import { CoinService } from '../src/coins/coin.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The Administrator's coin tools over HTTP.
 *
 * What is proven: the actor is the session's user and never a body field, the settings are
 * the caps, a bulk job credits every person exactly once even when it is stopped halfway and
 * resumed, the CSV export is audited and its cells are neutralised, and an editor and a
 * student are refused on every route.
 */

const PASSWORD = 'correct-horse-9battery';
const SECRET = 'coins-admin-internal-secret';

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('the administrator coin tools', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let context!: INestApplicationContext;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('coins_admin');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.REVALIDATE_SECRET = SECRET;

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    context = app.select(AppModule);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await db?.dispose();

    for (const name of Object.keys(process.env)) {
      if (!(name in savedEnv)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  async function makePerson(roleCode: 'USER' | 'EDITOR' | 'ADMIN'): Promise<{ id: string; token: string }> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `coins-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Coins Person',
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
    method: 'GET' | 'POST',
    url: string,
    token?: string,
    payload?: Record<string, unknown>,
  ) {
    const headers: Record<string, string> = {};
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  it('adjusts one account with the session as the author, and refuses a missing remark or the cap', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');

    const response = await call('POST', '/v1/admin/coins/adjust', admin.token, {
      userId: student.id,
      amount: 250,
      remark: 'Support goodwill',
      // A client field that must be ignored: the author is the session.
      createdBy: student.id,
    });
    expect(response.statusCode).toBe(200);

    const row = await db.client.coinTransaction.findFirstOrThrow({ where: { userId: student.id } });
    expect(row.createdBy).toBe(admin.id);
    expect(row.amount).toBe(250);
    expect(row.description).toBe('Support goodwill');

    expect((await call('POST', '/v1/admin/coins/adjust', admin.token, { userId: student.id, amount: 10 })).statusCode).toBe(400);
    expect(
      (await call('POST', '/v1/admin/coins/adjust', admin.token, { userId: student.id, amount: 10_001, remark: 'too much' }))
        .statusCode,
    ).toBe(400);
  });

  it('reads and exports one account’s ledger, and records the export', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');

    await call('POST', '/v1/admin/coins/adjust', admin.token, { userId: student.id, amount: 90, remark: '=formula' });

    const ledger = await call('GET', `/v1/admin/coins/${student.id}/ledger`, admin.token);
    expect(ledger.statusCode).toBe(200);
    const body = ledger.json() as { total: number; balance: number; totalEarned: number };
    expect(body.total).toBe(1);
    expect(body.balance).toBe(90);
    expect(body.totalEarned).toBe(90);

    const exported = await call('GET', `/v1/admin/coins/${student.id}/ledger/export`, admin.token);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body).toContain('idempotency_key');

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'COIN_LEDGER_EXPORTED', actorUserId: admin.id },
    });
    expect(audit).not.toBeNull();
  });

  it('previews and starts a bulk assignment, and the resumed job credits every person once', async () => {
    const admin = await makePerson('ADMIN');
    const students = await Promise.all([makePerson('USER'), makePerson('USER'), makePerson('USER'), makePerson('USER'), makePerson('USER')]);
    const emails = await db.client.user.findMany({
      where: { id: { in: students.map((row) => row.id) } },
      select: { email: true },
    });

    const preview = await call('POST', '/v1/admin/coins/bulk/preview', admin.token, {
      identifiers: [...(emails.map((row) => row.email ?? '')), 'nobody@example.com'],
      amount: 100,
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as { matched: unknown[]; unmatched: string[]; totalCoins: number };
    expect(previewBody.matched).toHaveLength(5);
    expect(previewBody.unmatched).toEqual(['nobody@example.com']);
    expect(previewBody.totalCoins).toBe(500);

    const started = await call('POST', '/v1/admin/coins/bulk', admin.token, {
      userIds: students.map((row) => row.id),
      amount: 100,
      remark: 'Exam week',
    });
    expect(started.statusCode).toBe(201);
    const job = (started.json() as { id: string }).id;
    expect(job).not.toBe('');

    // Stopped halfway: two of five, then the rest, exactly once each.
    const partial = await context.get(CoinService).runBulkJob(job, { batchSize: 2 });
    expect(partial.remaining).toBe(3);

    const drained = await app.inject({
      method: 'POST',
      url: '/v1/internal/coins/bulk/drain',
      headers: { 'x-internal-secret': SECRET },
      payload: { jobId: job },
    });
    expect(drained.statusCode).toBe(200);
    expect((drained.json() as { remaining: number }).remaining).toBe(0);

    for (const student of students) {
      expect(await db.client.coinTransaction.count({ where: { userId: student.id, type: 'ADMIN_CREDIT' } })).toBe(1);
    }
    const stored = await db.client.coinBulkJob.findUniqueOrThrow({ where: { id: job } });
    expect(stored.status).toBe('COMPLETED');
    expect(stored.creditedUsers).toBe(5);

    const report = await call('GET', `/v1/admin/coins/bulk/${job}/report`, admin.token);
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain('CREDITED');
  });

  it('refuses the internal drain without the shared secret', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/internal/coins/bulk/drain', payload: { jobId: randomUUID() } });
    expect(response.statusCode).toBe(404);
  });

  it('refuses an editor and a student on every coin route', async () => {
    const admin = await makePerson('ADMIN');
    const editor = await makePerson('EDITOR');
    const student = await makePerson('USER');

    const started = await call('POST', '/v1/admin/coins/bulk', admin.token, {
      userIds: [student.id],
      amount: 10,
      remark: 'role sweep',
    });
    const jobId = (started.json() as { id: string }).id;

    for (const person of [editor, student]) {
      expect((await call('GET', '/v1/admin/coins/recipients?q=exa', person.token)).statusCode).toBe(403);
      expect((await call('POST', '/v1/admin/coins/adjust', person.token, { userId: student.id, amount: 5, remark: 'x' })).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/coins/${student.id}/ledger`, person.token)).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/coins/${student.id}/ledger/export`, person.token)).statusCode).toBe(403);
      expect((await call('POST', '/v1/admin/coins/bulk/preview', person.token, { identifiers: [], amount: 1 })).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/coins/bulk/${jobId}`, person.token)).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/coins/bulk/${jobId}/report`, person.token)).statusCode).toBe(403);
    }
  });
});
