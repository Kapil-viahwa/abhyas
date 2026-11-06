import { randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * A student's own wallet (phase 5, item 4b, student half).
 *
 * What is proven: the account comes from the session and a `userId` a caller invents changes
 * nothing; two students never see each other's ledger; a suspended account is refused; hostile
 * page, page size and type values are refused rather than coerced; and the answer carries only
 * the six fields a student may see, never an id, an idempotency key or a fingerprint.
 */

const PASSWORD = 'correct-horse-9battery';
const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('the student wallet', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let context!: INestApplicationContext;
  let redis!: Redis;
  let roleId = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('wallet');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    roleId = (await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } })).id;

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

  interface Student {
    readonly id: string;
    readonly token: string;
  }

  async function makeStudent(ledgerAmount: number): Promise<Student> {
    const user = await db.client.user.create({
      data: {
        email: `wallet-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Wallet Student',
        passwordHash: await hashPassword(PASSWORD),
        roleId,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    await db.client.coinWallet.create({ data: { userId: user.id } });

    await db.client.$executeRawUnsafe(
      `INSERT INTO "coin_transactions"
         ("id", "user_id", "type", "amount", "previous_balance", "new_balance", "idempotency_key", "request_fingerprint")
       VALUES ($1::uuid, $2::uuid, 'ADMIN_CREDIT', $3::int, 0, $3::int, $4, $5)`,
      randomUUID(),
      user.id,
      ledgerAmount,
      `wallet-${randomUUID()}`,
      'c'.repeat(64),
    );

    const issued = await context.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  function get(url: string, token?: string) {
    return app.inject({
      method: 'GET',
      url,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  it('reads my balance and totals, and ignores a userId somebody else puts in the query', async () => {
    const mine = await makeStudent(1000);
    const other = await makeStudent(500);

    const own = await get('/v1/coins/me', mine.token);
    expect(own.statusCode).toBe(200);
    const body = own.json() as {
      balance: number;
      totalEarned: number;
      totalSpent: number;
      today: { paid: boolean; amount: number };
      nextRewardDate: string;
    };
    expect(body.balance).toBe(1000);
    expect(body.totalEarned).toBe(1000);
    expect(body.totalSpent).toBe(0);
    expect(body.today.paid).toBe(false);
    expect(body.nextRewardDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const sneaky = await get(`/v1/coins/me?userId=${other.id}`, mine.token);
    expect(sneaky.statusCode).toBe(200);
    expect((sneaky.json() as { balance: number }).balance).toBe(1000);
  });

  it('lists only my entries, with the six fields a student may see', async () => {
    const mine = await makeStudent(1000);
    const other = await makeStudent(500);

    const history = await get(`/v1/coins/me/history?userId=${other.id}`, mine.token);
    expect(history.statusCode).toBe(200);
    const body = history.json() as { total: number; items: Array<Record<string, unknown>> };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'amount',
      'balanceAfter',
      'createdAt',
      'description',
      'reference',
      'type',
    ]);

    const raw = JSON.stringify(body);
    for (const forbidden of ['idempotency', 'fingerprint', 'createdBy', 'created_by', 'userId', other.id]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('refuses a suspended account on both routes', async () => {
    const suspended = await makeStudent(1000);
    await db.client.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });

    expect((await get('/v1/coins/me', suspended.token)).statusCode).toBe(403);
    expect((await get('/v1/coins/me/history', suspended.token)).statusCode).toBe(403);
  });

  it('refuses hostile page, page size and type values instead of coercing them', async () => {
    const mine = await makeStudent(1000);

    for (const query of [
      'page=abc',
      'page=1e3',
      'page=0',
      'pageSize=0',
      'pageSize=101',
      'pageSize=10.5',
      'type=BOGUS',
      'from=not-a-date',
      'from=2024-13-40',
      'from=2025-01-02&to=2025-01-01',
    ]) {
      const response = await get(`/v1/coins/me/history?${query}`, mine.token);
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('shows the daily reward as paid once, with its amount', async () => {
    const mine = await makeStudent(1000);
    const today = new Date().toISOString().slice(0, 10);

    const entry = randomUUID();
    await db.client.$executeRawUnsafe(
      `INSERT INTO "coin_transactions"
         ("id", "user_id", "type", "amount", "previous_balance", "new_balance", "idempotency_key", "request_fingerprint")
       VALUES ($1::uuid, $2::uuid, 'DAILY_REWARD', 10, 1000, 1010, $3, $4)`,
      entry,
      mine.id,
      `wallet-${randomUUID()}`,
      'd'.repeat(64),
    );
    await db.client.$executeRawUnsafe(
      'INSERT INTO "daily_rewards" ("user_id", "reward_date", "amount", "coin_transaction_id") VALUES ($1::uuid, $2::date, 10, $3::uuid)',
      mine.id,
      today,
      entry,
    );

    const body = (await get('/v1/coins/me', mine.token)).json() as {
      balance: number;
      today: { paid: boolean; amount: number };
    };

    expect(body.balance).toBe(1010);
    expect(body.today).toMatchObject({ paid: true, amount: 10 });

    const filtered = await get('/v1/coins/me/history?type=DAILY_REWARD', mine.token);
    expect((filtered.json() as { total: number }).total).toBe(1);
  });

  it('refuses an anonymous caller', async () => {
    expect((await get('/v1/coins/me')).statusCode).toBe(401);
    expect((await get('/v1/coins/me/history')).statusCode).toBe(401);
  });
});
