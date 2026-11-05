import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoinService } from '../src/coins/coin.service';
import { DatabaseService } from '../src/infra/database.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The coin wallet and its ledger, proven where they cannot be bypassed.
 *
 * These tests talk to Postgres directly as well as through the service, because the
 * promises phase 5 makes are database promises: a CHECK, a trigger, a privilege. The
 * service runs on the application role's own connection wherever CI provides one, so
 * "the API cannot do this" is proven against the connection the API really uses.
 */

const PASSWORD_HASH = 'scrypt$16384$8$1$c2FsdA==$aGFzaA==';

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

describe('the coin wallet and its ledger', () => {
  let db!: TestDatabase;
  let database!: DatabaseService;
  let coins!: CoinService;
  let userRoleId!: string;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('coins');

    // A wider pool than the default, so fifty concurrent spends queue on the wallet's row
    // lock — the thing under test — rather than on a database connection.
    const url = new URL(db.appUrl);
    url.searchParams.set('connection_limit', '12');
    process.env.DATABASE_URL = url.toString();

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

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await db.client.$executeRawUnsafe(
      'INSERT INTO "users" ("id", "email", "password_hash", "full_name", "role_id", "email_verified_at") VALUES ($1::uuid, $2, $3, $4, $5::uuid, now())',
      id,
      `coins-${id.slice(0, 8)}@example.com`,
      PASSWORD_HASH,
      'Coin Holder',
      userRoleId,
    );
    return id;
  }

  function fingerprintOf(type: string, amount: number, referenceType = '', referenceId = ''): string {
    return createHash('sha256').update([type, amount, referenceType, referenceId].join('|')).digest('hex');
  }

  interface RawLedgerRow {
    userId: string;
    type?: string;
    amount?: number;
    previousBalance?: number;
    newBalance?: number;
    referenceType?: string | null;
    referenceId?: string | null;
    idempotencyKey?: string;
    fingerprint?: string;
  }

  async function rawLedgerInsert(row: RawLedgerRow): Promise<void> {
    const type = row.type ?? 'ENROLLMENT';
    const amount = row.amount ?? -100;
    const previousBalance = row.previousBalance ?? 0;
    const newBalance = row.newBalance ?? previousBalance + amount;

    await db.client.$executeRawUnsafe(
      'INSERT INTO "coin_transactions" ("user_id", "type", "amount", "previous_balance", "new_balance", "reference_type", "reference_id", "idempotency_key", "request_fingerprint") VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)',
      row.userId,
      type,
      amount,
      previousBalance,
      newBalance,
      row.referenceType ?? null,
      row.referenceId ?? null,
      row.idempotencyKey ?? `raw:${randomUUID()}`,
      row.fingerprint ?? fingerprintOf(type, amount),
    );
  }

  it('opens exactly one wallet per account, and opening it twice changes nothing', async () => {
    const userId = await insertUser();

    expect(await coins.openWallet(userId)).toBe(0);
    expect(await coins.openWallet(userId)).toBe(0);
    expect(await db.client.coinWallet.count({ where: { userId } })).toBe(1);
  });

  it('writes one ledger row and one wallet movement for a grant', async () => {
    const userId = await insertUser();

    const result = await coins.credit({
      userId,
      amount: 1_000,
      type: 'SIGNUP_GRANT',
      idempotencyKey: `signup:${userId}`,
      reference: { type: 'signup', id: userId },
      description: 'Welcome coins',
    });

    expect(result.previousBalance).toBe(0);
    expect(result.newBalance).toBe(1_000);
    expect(result.replayed).toBe(false);

    const wallet = await db.client.coinWallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance).toBe(1_000);

    const ledger = await db.client.coinTransaction.findMany({ where: { userId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(1_000);
    expect(ledger[0]!.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger[0]!.idempotencyKey).toBe(`signup:${userId}`);
  });

  it('replays an idempotency key with the same fingerprint without writing anything', async () => {
    const userId = await insertUser();
    const command = {
      userId,
      amount: 500,
      type: 'ADMIN_CREDIT' as const,
      idempotencyKey: `admin:${userId}`,
      reference: { type: 'manual', id: randomUUID() },
    };

    const first = await coins.credit(command);
    const replay = await coins.credit(command);

    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(replay.newBalance).toBe(500);

    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(1);
    const wallet = await db.client.coinWallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance).toBe(500);
  });

  it('refuses a reused key with a different amount, leaves the balance alone, and audits it', async () => {
    const userId = await insertUser();
    const key = `admin:${userId}:mismatch`;

    await coins.credit({ userId, amount: 300, type: 'ADMIN_CREDIT', idempotencyKey: key });

    await expect(
      coins.credit({ userId, amount: 900, type: 'ADMIN_CREDIT', idempotencyKey: key }),
    ).rejects.toThrow(/already used for a different coin entry/);

    const wallet = await db.client.coinWallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance).toBe(300);
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(1);

    const audit = await db.client.auditLog.findFirst({ where: { action: 'COIN_IDEMPOTENCY_MISMATCH' } });
    expect(audit).not.toBeNull();
    expect((audit?.metadata as { idempotencyKey?: string }).idempotencyKey).toBe(key);
  });

  it('refuses a charge that would take the wallet below zero', async () => {
    const userId = await insertUser();
    await coins.credit({ userId, amount: 50, type: 'SIGNUP_GRANT', idempotencyKey: `grant:${userId}` });

    await expect(
      coins.spend({ userId, amount: 100, type: 'ENROLLMENT', idempotencyKey: `spend:${userId}:1` }),
    ).rejects.toThrow(/Not enough coins/);

    expect(await coins.balanceOf(userId)).toBe(50);
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(1);
  });

  it('rejects the CHECK constraints the ledger carries', async () => {
    const userId = await insertUser();
    await db.client.coinWallet.create({ data: { userId } });

    await expect(rawLedgerInsert({ userId, amount: 0 })).rejects.toThrow(
      /coin_transactions_amount_non_zero/,
    );
    await expect(rawLedgerInsert({ userId, type: 'BOGUS', amount: 100 })).rejects.toThrow(
      /coin_transactions_type_valid/,
    );
    await expect(rawLedgerInsert({ userId, amount: 100, newBalance: 99 })).rejects.toThrow(
      /coin_transactions_balance_delta/,
    );
    await expect(rawLedgerInsert({ userId, amount: -100 })).rejects.toThrow(
      /balance_non_negative/,
    );
    await expect(rawLedgerInsert({ userId, amount: 100, referenceType: 'test' })).rejects.toThrow(
      /coin_transactions_reference_pair/,
    );

    // Nothing above was written, and the wallet never moved.
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);
    expect(await coins.balanceOf(userId)).toBe(0);
  });

  it('rejects a ledger row whose previous_balance is not the wallet balance', async () => {
    const userId = await insertUser();
    await db.client.coinWallet.create({ data: { userId } });

    await expect(
      rawLedgerInsert({ userId, amount: 100, previousBalance: 500, newBalance: 600 }),
    ).rejects.toThrow(/previous_balance 500 does not match the wallet balance 0/);

    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);
  });

  it('rejects a ledger row for an account with no wallet', async () => {
    const userId = await insertUser();

    await expect(rawLedgerInsert({ userId, amount: 100 })).rejects.toThrow(
      /must exist before its ledger is written/,
    );
  });

  it('moves the wallet in the same statement that writes the ledger row', async () => {
    const userId = await insertUser();
    await db.client.coinWallet.create({ data: { userId } });

    await rawLedgerInsert({ userId, amount: 250, newBalance: 250 });

    expect(await coins.balanceOf(userId)).toBe(250);
  });

  it('rejects an update and a delete on the ledger', async () => {
    const userId = await insertUser();
    await db.client.coinWallet.create({ data: { userId } });
    await rawLedgerInsert({
      userId,
      amount: 100,
      newBalance: 100,
      idempotencyKey: `append-only:${userId}`,
    });

    const row = await db.client.coinTransaction.findFirstOrThrow({ where: { userId } });

    await expect(
      db.client.$executeRawUnsafe(
        'UPDATE "coin_transactions" SET "description" = $1 WHERE "id" = $2::uuid',
        'changed',
        row.id,
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      db.client.$executeRawUnsafe('DELETE FROM "coin_transactions" WHERE "id" = $1::uuid', row.id),
    ).rejects.toThrow(/append-only/);
  });

  it('gives the application role no way to rewrite the ledger', async () => {
    const userId = await insertUser();
    await coins.credit({ userId, amount: 400, type: 'SIGNUP_GRANT', idempotencyKey: `grant:${userId}` });

    const row = await db.client.coinTransaction.findFirstOrThrow({ where: { userId } });

    await expect(
      db.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
        await tx.$executeRawUnsafe(
          'UPDATE "coin_transactions" SET "description" = $1 WHERE "id" = $2::uuid',
          'changed',
          row.id,
        );
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
        await tx.$executeRawUnsafe('DELETE FROM "coin_transactions" WHERE "id" = $1::uuid', row.id);
      }),
    ).rejects.toThrow(/permission denied/i);

    const appended = await db.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "coin_transactions" WHERE "user_id" = $1::uuid',
        userId,
      );
      await tx.$executeRawUnsafe('RESET ROLE');
      return rows.length;
    });

    expect(appended).toBe(1);
  });

  it('refuses to let the application role move a wallet balance directly', async () => {
    const userId = await insertUser();
    await coins.credit({ userId, amount: 400, type: 'SIGNUP_GRANT', idempotencyKey: `grant:${userId}` });

    await expect(
      db.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
        await tx.$executeRawUnsafe(
          'UPDATE "coin_wallets" SET "balance" = $1 WHERE "user_id" = $2::uuid',
          999_999,
          userId,
        );
      }),
    ).rejects.toThrow(/coin_wallets.balance changes only through coin_transactions/);

    expect(await coins.balanceOf(userId)).toBe(400);
  });

  it('charges exactly ten of fifty parallel spends against a balance that affords ten', async () => {
    const userId = await insertUser();
    await coins.credit({ userId, amount: 1_000, type: 'SIGNUP_GRANT', idempotencyKey: `grant:${userId}` });

    const attempts = Array.from({ length: 50 }, async (_, index) => {
      try {
        await coins.spend({
          userId,
          amount: 100,
          type: 'ENROLLMENT',
          idempotencyKey: `spend:${userId}:${String(index)}`,
          // Each attempt is a different attempt, so each charge is a different reference:
          // one enrollment per reference is a database invariant (20260801000000).
          reference: { type: 'attempt', id: randomUUID() },
        });
        return { charged: true as const, error: null };
      } catch (error) {
        return { charged: false as const, error };
      }
    });

    const results = await Promise.all(attempts);
    const charged = results.filter((result) => result.charged);
    const refused = results.filter((result) => !result.charged);

    expect(charged).toHaveLength(10);
    expect(refused).toHaveLength(40);
    for (const result of results) {
      if (!result.charged) {
        expect(String(result.error)).toMatch(/Not enough coins/);
      }
    }

    const wallet = await db.client.coinWallet.findUniqueOrThrow({ where: { userId } });
    expect(wallet.balance).toBe(0);
    expect(wallet.balance).toBeGreaterThanOrEqual(0);

    expect(await db.client.coinTransaction.count({ where: { userId, type: 'ENROLLMENT' } })).toBe(10);

    // The ledger and the wallet still agree, which is the point of the trigger. Sorted by
    // the balance each row produced, every row continues exactly the one before it.
    const rows = await db.client.coinTransaction.findMany({ where: { userId } });
    const chain = [...rows].sort((left, right) => right.newBalance - left.newBalance);
    let running = 0;
    for (const row of chain) {
      expect(row.previousBalance).toBe(running);
      running = row.newBalance;
    }
    expect(running).toBe(0);
    expect(rows).toHaveLength(11);
  });

  it('refuses a wallet that is not opened empty, for the application role', async () => {
    const userId = await insertUser();

    await expect(
      db.client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET ROLE "abhyas_app"');
        await tx.$executeRawUnsafe(
          'INSERT INTO "coin_wallets" ("user_id", "balance") VALUES ($1::uuid, $2)',
          userId,
          500,
        );
      }),
    ).rejects.toThrow(/starts at zero/);

    expect(await db.client.coinWallet.count({ where: { userId } })).toBe(0);
  });

  it('allows one signup grant per account, whatever the idempotency key', async () => {
    const userId = await insertUser();

    await coins.credit({
      userId,
      amount: 1_000,
      type: 'SIGNUP_GRANT',
      idempotencyKey: `signup:${userId}`,
      reference: { type: 'signup', id: userId },
    });

    await expect(
      coins.credit({
        userId,
        amount: 1_000,
        type: 'SIGNUP_GRANT',
        idempotencyKey: `signup:${userId}:again`,
        reference: { type: 'signup', id: userId },
      }),
    ).rejects.toThrow(/one_signup_grant_per_user/);

    expect(await db.client.coinTransaction.count({ where: { userId, type: 'SIGNUP_GRANT' } })).toBe(1);
    expect(await coins.balanceOf(userId)).toBe(1_000);
  });

  it('charges one enrollment per reference', async () => {
    const userId = await insertUser();
    await coins.credit({
      userId,
      amount: 1_000,
      type: 'SIGNUP_GRANT',
      idempotencyKey: `signup:${userId}`,
      reference: { type: 'signup', id: userId },
    });
    const reference = { type: 'attempt', id: randomUUID() };

    await coins.spend({ userId, amount: 100, type: 'ENROLLMENT', idempotencyKey: `spend:${userId}:a`, reference });

    await expect(
      coins.spend({ userId, amount: 100, type: 'ENROLLMENT', idempotencyKey: `spend:${userId}:b`, reference }),
    ).rejects.toThrow(/one_enrollment_per_reference/);

    expect(await db.client.coinTransaction.count({ where: { userId, type: 'ENROLLMENT' } })).toBe(1);
    expect(await coins.balanceOf(userId)).toBe(900);
  });

  it('refuses to delete the account that caused a ledger entry', async () => {
    const userId = await insertUser();
    const adminId = await insertUser();

    await coins.credit({
      userId,
      amount: 250,
      type: 'ADMIN_CREDIT',
      idempotencyKey: `admin:${userId}`,
      createdBy: adminId,
    });

    await expect(db.client.$executeRawUnsafe('DELETE FROM "users" WHERE "id" = $1::uuid', adminId)).rejects.toThrow(
      /coin_transactions_created_by_fkey/,
    );
  });

  it('refuses a single entry larger than one million coins', async () => {
    const userId = await insertUser();
    await db.client.coinWallet.create({ data: { userId } });

    await expect(
      rawLedgerInsert({ userId, type: 'ADMIN_CREDIT', amount: 1_000_001, newBalance: 1_000_001 }),
    ).rejects.toThrow(/coin_transactions_amount_within_range/);

    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(0);
  });

  it('answers 404, not 500, for an account that does not exist', async () => {
    await expect(
      coins.credit({
        userId: randomUUID(),
        amount: 100,
        type: 'ADMIN_CREDIT',
        idempotencyKey: `missing:${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('writes one row for twenty parallel credits that share a key', async () => {
    const userId = await insertUser();
    const key = `parallel:${userId}`;

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => coins.credit({ userId, amount: 400, type: 'ADMIN_CREDIT', idempotencyKey: key })),
    );

    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(19);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(1);
    expect(await coins.balanceOf(userId)).toBe(400);
  });

  it('lets one of ten conflicting intents with one key win, and refuses the other nine', async () => {
    const userId = await insertUser();
    const key = `contested:${userId}`;
    const amounts = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000];

    const results = await Promise.all(
      amounts.map(async (amount) => {
        try {
          return { ok: true as const, result: await coins.credit({ userId, amount, type: 'ADMIN_CREDIT', idempotencyKey: key }) };
        } catch (error) {
          return { ok: false as const, error };
        }
      }),
    );

    const won = results.filter((result) => result.ok);
    const lost = results.filter((result) => !result.ok);

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(9);
    for (const result of lost) {
      expect(String((result as { error: unknown }).error)).toMatch(/already used for a different coin entry/);
    }

    expect(await db.client.coinTransaction.count({ where: { userId } })).toBe(1);
    const wallet = await db.client.coinWallet.findUniqueOrThrow({ where: { userId } });
    const winner = won[0];
    if (winner?.ok !== true) {
      throw new Error('No intent won the contested key');
    }
    expect(wallet.balance).toBe(winner.result.amount);
  });

  it('opens one wallet for twenty parallel opens', async () => {
    const userId = await insertUser();

    await Promise.all(Array.from({ length: 20 }, async () => coins.openWallet(userId)));

    expect(await db.client.coinWallet.count({ where: { userId } })).toBe(1);
  });
});
