import { randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AuditLog } from '@prisma/client';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { CoinReconciliationService } from '../src/coins/reconciliation.service';
import { businessDate } from '../src/otp/otp-code';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The nightly wallet reconciliation (phase 5, item 4a).
 *
 * What is proven: a wallet that matches its ledger is not reported, a wallet the owner moved
 * behind the trigger's back *is* reported once with its audit row and alert counter, a scan
 * pages across more wallets than one batch, and the internal route answers 404 without its
 * secret. The service reads wallets and never writes one.
 */

const SECRET = 'coin-reconciliation-internal-0123456789';
const PASSWORD = 'correct-horse-9battery';
const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('the wallet reconciliation', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let context!: INestApplicationContext;
  let redis!: Redis;
  let roleId = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('coin_recon');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.INTERNAL_API_SECRET = SECRET;
    process.env.INTERNAL_ALLOWED_ADDRESSES = '127.0.0.1/32';

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

  function reconciliation(): CoinReconciliationService {
    return context.get(CoinReconciliationService);
  }

  function auditRows(): Promise<AuditLog[]> {
    return db.client.auditLog.findMany({ where: { action: 'COIN_RECONCILIATION_MISMATCH' } });
  }

  /** A wallet whose ledger, when there is one, is written through the ledger's own trigger. */
  async function makeWallet(ledgerAmount: number | null): Promise<string> {
    const user = await db.client.user.create({
      data: {
        email: `recon-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Reconciliation Student',
        passwordHash: await hashPassword(PASSWORD),
        roleId,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    await db.client.coinWallet.create({ data: { userId: user.id } });

    if (ledgerAmount !== null) {
      await db.client.$executeRawUnsafe(
        `INSERT INTO "coin_transactions"
           ("id", "user_id", "type", "amount", "previous_balance", "new_balance", "idempotency_key", "request_fingerprint")
         VALUES ($1::uuid, $2::uuid, 'ADMIN_CREDIT', $3::int, 0, $3::int, $4, $5)`,
        randomUUID(),
        user.id,
        ledgerAmount,
        `recon-${randomUUID()}`,
        'b'.repeat(64),
      );
    }

    return user.id;
  }

  /** The owner role is allowed past the application-role guard, which is how real drift happens. */
  async function corruptBalance(userId: string, balance: number): Promise<void> {
    await db.client.$executeRawUnsafe(
      'UPDATE "coin_wallets" SET "balance" = $2::int WHERE "user_id" = $1::uuid',
      userId,
      balance,
    );
  }

  it('reports no mismatch when every wallet matches its ledger', async () => {
    await makeWallet(2000);
    await makeWallet(null);
    await makeWallet(null);

    const result = await reconciliation().reconcile();

    expect(result.walletsChecked).toBeGreaterThanOrEqual(3);
    expect(result.mismatches).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('reports a wallet the owner corrupted, once, with its audit row and counter', async () => {
    const userId = await makeWallet(100);
    await corruptBalance(userId, 999);

    const result = await reconciliation().reconcile();

    expect(result.mismatches).toBe(1);
    expect((await auditRows()).filter((row) => row.entityId === userId)).toHaveLength(1);

    const key = `coins:reconciliation_mismatch:${businessDate(new Date())}`;
    expect(Number((await redis.get(key)) ?? '0')).toBeGreaterThanOrEqual(1);
    expect(await redis.ttl(key)).toBeGreaterThan(0);

    // Put it back, so the batch test below starts from a clean ledger.
    await corruptBalance(userId, 100);
  });

  it('pages across more wallets than one batch', async () => {
    const funded = await makeWallet(50);
    await makeWallet(25);
    await makeWallet(null);
    await makeWallet(null);
    await corruptBalance(funded, 51);

    const result = await reconciliation().reconcile(2);

    expect(result.walletsChecked).toBeGreaterThanOrEqual(5);
    expect(result.mismatches).toBe(1);
    expect((await auditRows()).filter((row) => row.entityId === funded)).toHaveLength(1);
  });

  it('answers 404 on the internal route without its secret', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/internal/coins/reconcile', payload: {} });
    expect(response.statusCode).toBe(404);
  });
});
