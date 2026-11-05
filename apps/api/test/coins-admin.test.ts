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
 * What is proven: the actor is the session's user and never a body field, every write needs
 * the form's Idempotency-Key and a fresh proof of the person, the same key with a different
 * body is refused and audited, a double submission writes one row, the settings are the caps,
 * a bulk job credits every person exactly once even when it is stopped halfway, resumed or
 * run twice in parallel, the internal drain accepts only its own secret from one address, the
 * input is strictly typed, the exports and finishes are audited, and an editor and a student
 * are refused on every route.
 */

const PASSWORD = 'correct-horse-9battery';
const INTERNAL_SECRET = 'coins-admin-internal-secret-0123456789';

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
    process.env.REVALIDATE_SECRET = 'revalidate-secret-never-the-internal-one';
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
    process.env.INTERNAL_ALLOWED_ADDRESSES = '127.0.0.1/32';

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

    const issued = await context.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  function call(
    method: 'GET' | 'POST',
    url: string,
    token?: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) {
    const all: Record<string, string> = { ...headers };
    if (token !== undefined) {
      all.authorization = `Bearer ${token}`;
    }
    return app.inject(payload === undefined ? { method, url, headers: all } : { method, url, headers: all, payload });
  }

  function freshKey(): Record<string, string> {
    return { 'idempotency-key': randomUUID() };
  }

  it('adjusts one account with the session as the author, and audits the decision', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');

    const response = await call(
      'POST',
      '/v1/admin/coins/adjust',
      admin.token,
      {
        userId: student.id,
        amount: 250,
        remark: 'Support goodwill',
        reauth: { password: PASSWORD },
        // A client field that must be ignored: the author is the session.
        createdBy: student.id,
      },
      freshKey(),
    );
    expect(response.statusCode).toBe(200);

    const row = await db.client.coinTransaction.findFirstOrThrow({ where: { userId: student.id } });
    expect(row.createdBy).toBe(admin.id);
    expect(row.amount).toBe(250);
    expect(row.description).toBe('Support goodwill');

    const audit = await db.client.auditLog.findFirst({ where: { action: 'COIN_ADJUSTED', actorUserId: admin.id } });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ userId: student.id, amount: 250, direction: 'credit' });

    expect(
      (
        await call('POST', '/v1/admin/coins/adjust', admin.token, { userId: student.id, amount: 10 }, freshKey())
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/v1/admin/coins/adjust',
          admin.token,
          { userId: student.id, amount: 10_001, remark: 'too much' },
          freshKey(),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('answers a double-submitted adjustment with the first answer and writes one ledger row', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');
    const key = freshKey();
    const payload = { userId: student.id, amount: 120, remark: 'Double click', reauth: { password: PASSWORD } };

    const first = await call('POST', '/v1/admin/coins/adjust', admin.token, payload, key);
    const second = await call('POST', '/v1/admin/coins/adjust', admin.token, payload, key);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    expect(await db.client.coinTransaction.count({ where: { userId: student.id } })).toBe(1);

    // The same key naming a different request is a bug, not a retry.
    const different = await call(
      'POST',
      '/v1/admin/coins/adjust',
      admin.token,
      { ...payload, amount: 130 },
      key,
    );
    expect(different.statusCode).toBe(409);
    expect(await db.client.coinTransaction.count({ where: { userId: student.id } })).toBe(1);
    expect(
      await db.client.auditLog.count({ where: { action: 'COIN_ADMIN_KEY_REUSED', actorUserId: admin.id } }),
    ).toBe(1);

    // A missing key is refused before anything is written.
    expect(
      (await call('POST', '/v1/admin/coins/adjust', admin.token, payload)).statusCode,
    ).toBe(400);
  });

  it('refuses a write without a fresh proof, accepts one proof for the next ten minutes, and keeps the failure limit', async () => {
    const staleAdmin = await makePerson('ADMIN');
    const student = await makePerson('USER');

    const stale = await call(
      'POST',
      '/v1/admin/coins/adjust',
      staleAdmin.token,
      { userId: student.id, amount: 10, remark: 'No proof' },
      freshKey(),
    );
    expect(stale.statusCode).toBe(403);
    expect((stale.json() as { code?: string }).code).toBe('reauth_required');

    const freshAdmin = await makePerson('ADMIN');
    expect(
      (
        await call(
          'POST',
          '/v1/admin/coins/adjust',
          freshAdmin.token,
          { userId: student.id, amount: 10, remark: 'Fresh proof', reauth: { password: PASSWORD } },
          freshKey(),
        )
      ).statusCode,
    ).toBe(200);

    // The proof opened the window: the next write needs no password again.
    expect(
      (
        await call(
          'POST',
          '/v1/admin/coins/adjust',
          freshAdmin.token,
          { userId: student.id, amount: 11, remark: 'Within window' },
          freshKey(),
        )
      ).statusCode,
    ).toBe(200);

    // A wrong proof is an attempt, and the sixth is refused rather than compared.
    const guessing = await makePerson('ADMIN');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await call(
            'POST',
            '/v1/admin/coins/adjust',
            guessing.token,
            { userId: student.id, amount: 10, remark: 'Wrong proof', reauth: { password: 'not-the-password' } },
            freshKey(),
          )
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await call(
          'POST',
          '/v1/admin/coins/adjust',
          guessing.token,
          { userId: student.id, amount: 10, remark: 'Wrong proof', reauth: { password: 'not-the-password' } },
          freshKey(),
        )
      ).statusCode,
    ).toBe(429);
  });

  it('refuses coerced numbers, unknown ids and unknown ledger types', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');

    for (const amount of ['1e3', '1000', true, false, [5], null, 1.5]) {
      const response = await call(
        'POST',
        '/v1/admin/coins/adjust',
        admin.token,
        { userId: student.id, amount, remark: 'Hostile amount', reauth: { password: PASSWORD } },
        freshKey(),
      );
      expect(response.statusCode, JSON.stringify(amount)).toBe(400);
    }

    expect(
      (
        await call(
          'POST',
          '/v1/admin/coins/adjust',
          admin.token,
          { userId: 'not-a-uuid', amount: 10, remark: 'Hostile id' },
          freshKey(),
        )
      ).statusCode,
    ).toBe(400);
    expect((await call('GET', `/v1/admin/coins/${student.id}/ledger?type=BOGUS`, admin.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/admin/coins/not-a-uuid/ledger', admin.token)).statusCode).toBe(400);
    expect(
      (
        await call('POST', '/v1/admin/coins/bulk/preview', admin.token, {
          identifiers: Array.from({ length: 5001 }, (_, index) => `a${String(index)}@example.com`),
          amount: 1,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('reads and exports one account’s ledger, and records the export', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');

    await call(
      'POST',
      '/v1/admin/coins/adjust',
      admin.token,
      { userId: student.id, amount: 90, remark: '=formula', reauth: { password: PASSWORD } },
      freshKey(),
    );

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

    const payload = {
      userIds: students.map((row) => row.id),
      amount: 100,
      remark: 'Exam week',
      reauth: { password: PASSWORD },
    };
    const key = freshKey();
    const started = await call('POST', '/v1/admin/coins/bulk', admin.token, payload, key);
    expect(started.statusCode).toBe(201);
    const job = (started.json() as { id: string }).id;
    expect(job).not.toBe('');

    // The same form submitted twice creates one job.
    const again = await call('POST', '/v1/admin/coins/bulk', admin.token, payload, key);
    expect(again.statusCode).toBe(201);
    expect((again.json() as { id: string }).id).toBe(job);
    expect(await db.client.coinBulkJob.count({ where: { createdBy: admin.id } })).toBe(1);

    // Stopped halfway: two of five, then the rest, exactly once each.
    const partial = await context.get(CoinService).runBulkJob(job, { batchSize: 2 });
    expect(partial.remaining).toBe(3);

    const drained = await app.inject({
      method: 'POST',
      url: '/v1/internal/coins/bulk/drain',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
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

    const finished = await db.client.auditLog.findFirst({ where: { action: 'COIN_BULK_FINISHED', entityId: job } });
    expect(finished?.metadata).toMatchObject({ users: 5, credited: 5, failed: 0, amount: 100, totalCoins: 500 });

    const report = await call('GET', `/v1/admin/coins/bulk/${job}/report`, admin.token);
    expect(report.statusCode).toBe(200);
    expect(report.body).toContain('CREDITED');
  });

  it('credits every person once when two drains run the same job in parallel', async () => {
    const admin = await makePerson('ADMIN');
    const students = await Promise.all([makePerson('USER'), makePerson('USER'), makePerson('USER'), makePerson('USER')]);

    const started = await call(
      'POST',
      '/v1/admin/coins/bulk',
      admin.token,
      { userIds: students.map((row) => row.id), amount: 40, remark: 'Parallel drain', reauth: { password: PASSWORD } },
      freshKey(),
    );
    expect(started.statusCode).toBe(201);
    const job = (started.json() as { id: string }).id;
    const coins = context.get(CoinService);

    await Promise.all([coins.runBulkJob(job, { batchSize: 50 }), coins.runBulkJob(job, { batchSize: 50 })]);

    for (const student of students) {
      expect(await db.client.coinTransaction.count({ where: { userId: student.id, type: 'ADMIN_CREDIT' } })).toBe(1);
      expect(await db.client.coinWallet.findUniqueOrThrow({ where: { userId: student.id } })).toMatchObject({ balance: 40 });
    }
  });

  it('accepts the internal drain only with its own secret, from an allowed address', async () => {
    const admin = await makePerson('ADMIN');
    const student = await makePerson('USER');
    const started = await call(
      'POST',
      '/v1/admin/coins/bulk',
      admin.token,
      { userIds: [student.id], amount: 5, remark: 'Internal gate', reauth: { password: PASSWORD } },
      freshKey(),
    );
    const jobId = (started.json() as { id: string }).id;

    const missing = await app.inject({ method: 'POST', url: '/v1/internal/coins/bulk/drain', payload: { jobId } });
    expect(missing.statusCode).toBe(404);

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/internal/coins/bulk/drain',
      headers: { 'x-internal-secret': 'wrong-secret' },
      payload: { jobId },
    });
    expect(wrong.statusCode).toBe(404);

    const reused = await app.inject({
      method: 'POST',
      url: '/v1/internal/coins/bulk/drain',
      headers: { 'x-internal-secret': process.env.REVALIDATE_SECRET ?? '' },
      payload: { jobId },
    });
    expect(reused.statusCode).toBe(404);

    const elsewhere = await app.inject({
      method: 'POST',
      url: '/v1/internal/coins/bulk/drain',
      headers: { 'x-internal-secret': INTERNAL_SECRET, 'x-forwarded-for': '203.0.113.9' },
      payload: { jobId },
    });
    expect(elsewhere.statusCode).toBe(404);

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/internal/coins/bulk/drain',
      headers: { 'x-internal-secret': INTERNAL_SECRET },
      payload: { jobId },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('refuses an editor and a student on every coin route', async () => {
    const admin = await makePerson('ADMIN');
    const editor = await makePerson('EDITOR');
    const student = await makePerson('USER');

    const started = await call(
      'POST',
      '/v1/admin/coins/bulk',
      admin.token,
      { userIds: [student.id], amount: 10, remark: 'role sweep', reauth: { password: PASSWORD } },
      freshKey(),
    );
    const jobId = (started.json() as { id: string }).id;

    for (const person of [editor, student]) {
      expect((await call('GET', '/v1/admin/coins/recipients?q=exa', person.token)).statusCode).toBe(403);
      expect(
        (await call('POST', '/v1/admin/coins/adjust', person.token, { userId: student.id, amount: 5, remark: 'x' }, freshKey()))
          .statusCode,
      ).toBe(403);
      expect((await call('GET', `/v1/admin/coins/${student.id}/ledger`, person.token)).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/coins/${student.id}/ledger/export`, person.token)).statusCode).toBe(403);
      expect(
        (await call('POST', '/v1/admin/coins/bulk/preview', person.token, { identifiers: ['a@example.com'], amount: 1 }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            'POST',
            '/v1/admin/coins/bulk',
            person.token,
            { userIds: [student.id], amount: 5, remark: 'x' },
            freshKey(),
          )
        ).statusCode,
      ).toBe(403);
      expect((await call('GET', `/v1/admin/coins/bulk/${jobId}`, person.token)).statusCode).toBe(403);
      expect((await call('GET', `/v1/admin/coins/bulk/${jobId}/report`, person.token)).statusCode).toBe(403);
    }
  });
});
