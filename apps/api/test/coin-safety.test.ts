import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { hashPassword } from '../src/auth/password';
import { CoinsHooksService } from '../src/coins/hooks.service';
import { RedisService } from '../src/infra/redis.service';
import { businessDate } from '../src/otp/otp-code';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * A coin rule must never be the reason a person cannot sign in or verify an account.
 *
 * Each case makes the coin side fail on purpose — a 0 setting, a setting row that is not
 * there at all — and asserts the flow still succeeds, that the failure was counted and
 * audited, and that the record holds no personal data.
 */

const PASSWORD = 'correct-horse-9battery';
const PASSWORD_HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('coins never break the flow that calls them', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let userRoleId!: string;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('coin_safety');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();

    const roles = await db.client.$queryRawUnsafe<Array<{ id: string; code: string }>>(
      'SELECT "id", "code" FROM "roles"',
    );
    userRoleId = roles.find((row) => row.code === 'USER')!.id;

    // A verified, active student with a password, so a real sign-in can run.
    await db.client.$executeRawUnsafe(
      'INSERT INTO "users" ("id", "email", "password_hash", "full_name", "role_id", "email_verified_at") VALUES ($1::uuid, $2, $3, $4, $5::uuid, now())',
      randomUUID(),
      `safety-${randomUUID().slice(0, 8)}@example.com`,
      PASSWORD_HASH,
      'Safety Student',
      userRoleId,
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.dispose();

    for (const name of Object.keys(process.env)) {
      if (!(name in savedEnv)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  async function insertVerifiedUser(): Promise<string> {
    const id = randomUUID();
    await db.client.$executeRawUnsafe(
      'INSERT INTO "users" ("id", "email", "password_hash", "full_name", "role_id", "email_verified_at") VALUES ($1::uuid, $2, $3, $4, $5::uuid, now())',
      id,
      `safety-${id.slice(0, 8)}@example.com`,
      await hashPassword(PASSWORD),
      'Safety Student',
      userRoleId,
    );
    return id;
  }

  async function setSetting(key: string, value: number | null): Promise<void> {
    await db.client.setting.update({ where: { key }, data: { valueInt: value } });
  }

  it('signs in when the daily reward is disabled (a 0 setting)', async () => {
    const userId = await insertVerifiedUser();
    await setSetting('daily_reward_coins', 0);

    const email = await db.client.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const result = await app.get(AuthService).login({ email: email.email, password: PASSWORD });

    expect(result.accessToken).not.toBe('');
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);

    await setSetting('daily_reward_coins', 10);
  });

  it('signs in when the daily reward throws, and counts and audits it', async () => {
    const userId = await insertVerifiedUser();
    const setting = await db.client.setting.findUniqueOrThrow({ where: { key: 'daily_reward_coins' } });
    await db.client.setting.delete({ where: { key: 'daily_reward_coins' } });

    const email = await db.client.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const result = await app.get(AuthService).login({ email: email.email, password: PASSWORD });
    expect(result.accessToken).not.toBe('');

    const counted = await app.get(RedisService).redis.get(`coins:reward_errors:${businessDate(new Date())}`);
    expect(Number(counted ?? '0')).toBeGreaterThanOrEqual(1);

    const audit = await db.client.auditLog.findFirst({ where: { action: 'COIN_REWARD_ERROR' } });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toEqual({ kind: 'reward', reason: 'Error' });
    expect(JSON.stringify(audit?.metadata)).not.toContain(email.email ?? '');

    await db.client.setting.create({ data: setting });
  });

  it('grants nothing, and does not fail, when the signup grant is disabled', async () => {
    const userId = await insertVerifiedUser();
    await setSetting('signup_coins', 0);

    await expect(app.get(CoinsHooksService).grantSafely(userId)).resolves.toBeUndefined();
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);

    await setSetting('signup_coins', 1_000);
  });

  it('does not fail the flow when the grant setting row is missing, and records it', async () => {
    const userId = await insertVerifiedUser();
    const setting = await db.client.setting.findUniqueOrThrow({ where: { key: 'signup_coins' } });
    await db.client.setting.delete({ where: { key: 'signup_coins' } });

    await expect(app.get(CoinsHooksService).grantSafely(userId)).resolves.toBeUndefined();

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'COIN_REWARD_ERROR' },
      orderBy: { occurredAt: 'desc' },
    });
    expect((audit?.metadata as { kind?: string }).kind).toBe('grant');

    await db.client.setting.create({ data: setting });
  });
});
