import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoinService } from '../src/coins/coin.service';
import { DatabaseService } from '../src/infra/database.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The two automatic grants, phase 5 item 2.
 *
 * Both are proven against the real ledger: the signup grant is one row per person however
 * many times a verification is replayed, and the daily reward is one row per Asia/Kolkata
 * day however many devices sign in at once. The clock is an argument, so the boundary is
 * tested rather than waited for.
 */

const PASSWORD_HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('signup and daily rewards', () => {
  let db!: TestDatabase;
  let database!: DatabaseService;
  let coins!: CoinService;
  let userRoleId!: string;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('coin_grants');
    process.env.DATABASE_URL = db.appUrl;

    database = new DatabaseService();
    coins = new CoinService(database);

    const roles = await db.client.$queryRawUnsafe<Array<{ id: string; code: string }>>(
      'SELECT "id", "code" FROM "roles"',
    );
    userRoleId = roles.find((row) => row.code === 'USER')!.id;
  }, 120_000);

  afterAll(async () => {
    await database?.onModuleDestroy();
    await db?.dispose();

    for (const name of Object.keys(process.env)) {
      if (!(name in savedEnv)) {
        delete process.env[name];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  async function insertUser(options: {
    email?: string;
    emailVerified?: boolean;
    mobileVerified?: boolean;
    status?: string;
  } = {}): Promise<string> {
    const id = randomUUID();
    const mobile = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const hasEmail = options.mobileVerified !== true;

    await db.client.$executeRawUnsafe(
      'INSERT INTO "users" ("id", "email", "mobile", "first_verified_mobile", "mobile_verified_at", "password_hash", "full_name", "role_id", "status", "email_verified_at") VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10)',
      id,
      hasEmail ? (options.email ?? `grant-${id.slice(0, 8)}@example.com`) : null,
      options.mobileVerified === true ? mobile : null,
      options.mobileVerified === true ? `+91${mobile}` : null,
      options.mobileVerified === true ? new Date() : null,
      PASSWORD_HASH,
      'Grant Holder',
      userRoleId,
      options.status ?? 'ACTIVE',
      options.emailVerified === true ? new Date('2026-01-01T00:00:00Z') : null,
    );

    return id;
  }

  async function setInteger(key: string, value: number): Promise<void> {
    await db.client.setting.update({ where: { key }, data: { valueInt: value } });
  }

  async function setText(key: string, value: string): Promise<void> {
    await db.client.setting.update({ where: { key }, data: { valueText: value } });
  }

  it('grants the signup coins only once the required identifier is verified', async () => {
    await setText('signup_grant_requirement', 'email');
    await setInteger('signup_coins', 1_000);

    const userId = await insertUser({ emailVerified: false });

    expect(await coins.grantSignupCoins(userId)).toBeNull();
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);

    await db.client.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });

    const granted = await coins.grantSignupCoins(userId);
    expect(granted?.newBalance).toBe(1_000);
    expect(granted?.type).toBe('SIGNUP_GRANT');
  });

  it('grants once even when many verifications race', async () => {
    await setText('signup_grant_requirement', 'email');
    await setInteger('signup_coins', 1_000);

    const userId = await insertUser({ emailVerified: true });

    const results = await Promise.all(Array.from({ length: 6 }, async () => coins.grantSignupCoins(userId)));
    const ids = new Set(results.map((result) => result?.id));

    expect(ids.size).toBe(1);
    expect(await db.client.coinTransaction.count({ where: { userId, type: 'SIGNUP_GRANT' } })).toBe(1);
    expect(await coins.balanceOf(userId)).toBe(1_000);
  });

  it('grants nothing while the account is not active', async () => {
    await setText('signup_grant_requirement', 'email');

    const userId = await insertUser({ emailVerified: true, status: 'SUSPENDED' });

    expect(await coins.grantSignupCoins(userId)).toBeNull();
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);
  });

  it('follows signup_grant_requirement: a mobile requirement ignores a verified email', async () => {
    await setText('signup_grant_requirement', 'mobile');
    await setInteger('signup_coins', 250);

    const emailOnly = await insertUser({ emailVerified: true });
    expect(await coins.grantSignupCoins(emailOnly)).toBeNull();

    const mobileUser = await insertUser({ mobileVerified: true });
    const granted = await coins.grantSignupCoins(mobileUser);
    expect(granted?.newBalance).toBe(250);

    await setText('signup_grant_requirement', 'email');
  });

  it('stopped a second account claiming the same mobile, so a person cannot earn the grant twice', async () => {
    const userId = await insertUser({ mobileVerified: true });
    const mobile = await db.client.user.findUniqueOrThrow({ where: { id: userId } });

    const duplicate = randomUUID();
    await expect(
      db.client.$executeRawUnsafe(
        'INSERT INTO "users" ("id", "email", "password_hash", "full_name", "role_id", "mobile", "first_verified_mobile", "mobile_verified_at") VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, now())',
        duplicate,
        null,
        PASSWORD_HASH,
        'Second Claim',
        userRoleId,
        mobile.mobile,
        mobile.firstVerifiedMobile,
      ),
    ).rejects.toThrow();

    expect(await db.client.coinTransaction.count({ where: { userId: duplicate } })).toBe(0);
  });

  it('pays the daily reward once with ten parallel sign-ins', async () => {
    await setInteger('daily_reward_coins', 10);
    const userId = await insertUser({ emailVerified: true });
    const now = new Date('2026-03-10T06:00:00Z');

    const results = await Promise.all(
      Array.from({ length: 10 }, async () => coins.payDailyReward(userId, { now })),
    );

    expect(results.filter((result) => result.paid)).toHaveLength(1);
    expect(results.every((result) => result.rewardDate === '2026-03-10')).toBe(true);

    expect(await db.client.coinDailyReward.count({ where: { userId } })).toBe(1);
    expect(await db.client.coinTransaction.count({ where: { userId, type: 'DAILY_REWARD' } })).toBe(1);
    expect(await coins.balanceOf(userId)).toBe(10);

    // A later sign-in on the same day is free and changes nothing.
    const later = await coins.payDailyReward(userId, { now: new Date('2026-03-10T18:00:00Z') });
    expect(later.paid).toBe(false);
    expect(await coins.balanceOf(userId)).toBe(10);
  });

  it('pays again on the next Asia/Kolkata day, and not a minute before midnight IST', async () => {
    await setInteger('daily_reward_coins', 10);
    const userId = await insertUser({ emailVerified: true });

    // 23:59 IST on 1 January is still 1 January.
    const lateNight = await coins.payDailyReward(userId, { now: new Date('2026-01-01T18:29:00Z') });
    expect(lateNight.paid).toBe(true);
    expect(lateNight.rewardDate).toBe('2026-01-01');

    // 00:01 IST on 2 January is a new day.
    const afterMidnight = await coins.payDailyReward(userId, { now: new Date('2026-01-01T18:31:00Z') });
    expect(afterMidnight.paid).toBe(true);
    expect(afterMidnight.rewardDate).toBe('2026-01-02');

    expect(await db.client.coinDailyReward.count({ where: { userId } })).toBe(2);
    expect(await coins.balanceOf(userId)).toBe(20);
  });

  it('earns nothing while unverified or suspended', async () => {
    const unverified = await insertUser({ emailVerified: false });
    const suspended = await insertUser({ emailVerified: true, status: 'SUSPENDED' });
    const now = new Date('2026-04-01T06:00:00Z');

    expect((await coins.payDailyReward(unverified, { now })).paid).toBe(false);
    expect((await coins.payDailyReward(suspended, { now })).paid).toBe(false);

    expect(await db.client.coinDailyReward.count({ where: { userId: { in: [unverified, suspended] } } })).toBe(0);
    expect(await db.client.coinTransaction.count({ where: { userId: { in: [unverified, suspended] } } })).toBe(0);
  });

  it('takes the reward amount from daily_reward_coins', async () => {
    await setInteger('daily_reward_coins', 25);
    const userId = await insertUser({ emailVerified: true });

    const result = await coins.payDailyReward(userId, { now: new Date('2026-05-01T06:00:00Z') });
    expect(result.paid).toBe(true);
    expect(result.amount).toBe(25);
    expect(await coins.balanceOf(userId)).toBe(25);

    await setInteger('daily_reward_coins', 10);
  });

  it('reads a grant another path already wrote as already granted, not as an error', async () => {
    await setText('signup_grant_requirement', 'email');
    const userId = await insertUser({ emailVerified: true });

    // A grant written with its own key (a backfill, an import): the one-grant-per-user index
    // is what stops grantSignupCoins writing a second one, and it must answer with this row.
    await db.client.coinWallet.create({ data: { userId } });
    await db.client.$executeRawUnsafe(
      'INSERT INTO "coin_transactions" ("user_id", "type", "amount", "previous_balance", "new_balance", "idempotency_key", "request_fingerprint") VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)',
      userId,
      'SIGNUP_GRANT',
      700,
      0,
      700,
      `backfill:${userId}`,
      'f'.repeat(64),
    );

    const granted = await coins.grantSignupCoins(userId);
    expect(granted?.amount).toBe(700);
    expect(granted?.replayed).toBe(true);
    expect(await db.client.coinTransaction.count({ where: { userId, type: 'SIGNUP_GRANT' } })).toBe(1);
  });

  it('treats a 0 coin setting as disabled, and writes nothing', async () => {
    await setText('signup_grant_requirement', 'email');
    await setInteger('signup_coins', 0);
    await setInteger('daily_reward_coins', 0);

    const userId = await insertUser({ emailVerified: true });

    expect(await coins.grantSignupCoins(userId)).toBeNull();

    const reward = await coins.payDailyReward(userId, { now: new Date('2026-06-01T06:00:00Z') });
    expect(reward.paid).toBe(false);
    expect(reward.amount).toBe(0);

    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);
    expect(await db.client.coinDailyReward.count({ where: { userId } })).toBe(0);

    await setInteger('signup_coins', 1_000);
    await setInteger('daily_reward_coins', 10);
  });

  it('pays the daily reward only for the identifier the setting names', async () => {
    await setText('signup_grant_requirement', 'mobile');
    await setInteger('daily_reward_coins', 10);
    const now = new Date('2026-07-01T06:00:00Z');

    const emailOnly = await insertUser({ emailVerified: true });
    const mobileUser = await insertUser({ mobileVerified: true });

    expect((await coins.payDailyReward(emailOnly, { now })).paid).toBe(false);
    expect((await coins.payDailyReward(mobileUser, { now })).paid).toBe(true);
    expect(await coins.balanceOf(emailOnly)).toBe(0);
    expect(await coins.balanceOf(mobileUser)).toBe(10);

    await setText('signup_grant_requirement', 'email');
  });

  it('lets one Gmail mailbox earn the grant once, however it is spelled', async () => {
    await setText('signup_grant_requirement', 'email');
    await setInteger('signup_coins', 1_000);

    const local = `mailbox${String(Math.floor(Math.random() * 1e6))}`;
    const first = await insertUser({ email: `${local}+1@gmail.com`, emailVerified: true });
    const second = await insertUser({ email: `${local}@googlemail.com`, emailVerified: true });

    const granted = await coins.grantSignupCoins(first);
    expect(granted?.newBalance).toBe(1_000);

    expect(await coins.grantSignupCoins(second)).toBeNull();
    expect(await coins.balanceOf(second)).toBe(0);
    expect(await db.client.coinTransaction.count({ where: { userId: second } })).toBe(0);
  });
});
