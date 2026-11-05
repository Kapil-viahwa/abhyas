import { createHash, randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { businessDate } from '../otp/otp-code';
import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { normaliseEmail } from './email-identity';

/**
 * The coin ledger, and the only code that writes it.
 *
 * The database refuses an update or a delete on `coin_transactions`, the application role
 * has no privilege to attempt one, and a wallet's balance is moved by the ledger's own
 * trigger inside the statement that inserts the row. A caller therefore cannot post a
 * balance — it can only ask for a movement, and the ledger decides what the wallet becomes.
 *
 * Two rules sit on top of that. Every movement carries an idempotency key with a fingerprint
 * of type, amount and reference: a replay writes nothing and returns the original row, and a
 * key reused for a different intent is refused and audited. And a movement is always part of
 * a larger fact: the signup grant happens when an identifier is verified, and the daily
 * reward is one row in `daily_rewards` plus its ledger row, in one transaction, so parallel
 * sign-ins from many devices pay exactly once.
 */

export const COIN_CREDIT_TYPES = ['SIGNUP_GRANT', 'DAILY_REWARD', 'ADMIN_CREDIT'] as const;
export const COIN_DEBIT_TYPES = ['ADMIN_DEBIT', 'ENROLLMENT'] as const;

export type CoinCreditType = (typeof COIN_CREDIT_TYPES)[number];
export type CoinDebitType = (typeof COIN_DEBIT_TYPES)[number];
export type CoinTransactionType = CoinCreditType | CoinDebitType;

/** The largest balance a Postgres `INTEGER` column can hold. */
export const MAX_COIN_BALANCE = 2_147_483_647;

export const SIGNUP_GRANT_REQUIREMENT_SETTING = 'signup_grant_requirement';
export const SIGNUP_COINS_SETTING = 'signup_coins';
export const DAILY_REWARD_COINS_SETTING = 'daily_reward_coins';

export interface CoinReference {
  readonly type: string;
  readonly id?: string | null;
}

interface CoinEntryBase {
  readonly userId: string;
  /** Positive magnitude; the direction comes from the method, never from the caller. */
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly reference?: CoinReference | null;
  readonly description?: string | null;
  readonly createdBy?: string | null;
}

export interface CoinCreditCommand extends CoinEntryBase {
  readonly type: CoinCreditType;
}

export interface CoinSpendCommand extends CoinEntryBase {
  readonly type: CoinDebitType;
}

export interface CoinEntryResult {
  readonly id: string;
  readonly userId: string;
  readonly type: CoinTransactionType;
  /** Signed: negative for a charge, positive for a grant or an admin credit. */
  readonly amount: number;
  readonly previousBalance: number;
  readonly newBalance: number;
  readonly idempotencyKey: string;
  /** True when this call replayed an existing key and wrote nothing. */
  readonly replayed: boolean;
  readonly createdAt: string;
}

export interface DailyRewardResult {
  /** True only for the sign-in that wrote the reward. Repeated sign-ins get false. */
  readonly paid: boolean;
  readonly rewardDate: string;
  readonly amount: number;
  readonly newBalance: number;
}

/** One page of an account's history, with what the wallet earned and spent overall. */
export interface CoinHistoryResult {
  readonly items: CoinEntryResult[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalSpent: number;
}

/** What one batch of a bulk assignment did, and how much is left. */
export interface BulkBatchResult {
  readonly processed: number;
  readonly remaining: number;
  readonly status: string;
}

interface LedgerRow {
  readonly id: string;
  readonly user_id: string;
  readonly type: string;
  readonly amount: number;
  readonly previous_balance: number;
  readonly new_balance: number;
  readonly idempotency_key: string;
  readonly request_fingerprint: string;
  readonly created_at: Date;
}

interface EntryRequest {
  readonly userId: string;
  readonly type: CoinTransactionType;
  readonly signedAmount: number;
  readonly idempotencyKey: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly description: string | null;
  readonly createdBy: string | null;
  readonly fingerprint: string;
}

type EntryOutcome =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'replay'; readonly row: LedgerRow }
  | { readonly kind: 'posted'; readonly row: LedgerRow };

export interface CoinFingerprintInput {
  readonly type: string;
  readonly amount: number;
  readonly reference?: CoinReference | null;
}

/**
 * A hash of what the caller meant to do, so a replayed key can be told apart from a
 * different intent that happens to reuse it.
 */
export function requestFingerprint(input: CoinFingerprintInput): string {
  const parts = [input.type, String(input.amount), input.reference?.type ?? '', input.reference?.id ?? ''];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

@Injectable()
export class CoinService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  /** Opens the one wallet an account will ever have, and returns its balance. */
  async openWallet(userId: string): Promise<number> {
    const id = accountId(userId);

    try {
      await this.prisma.$executeRaw`
        INSERT INTO "coin_wallets" ("user_id")
        VALUES (${id}::uuid)
        ON CONFLICT ("user_id") DO NOTHING
      `;
    } catch (error) {
      this.rethrowMissingAccount(error);
    }

    return this.balanceOf(id);
  }

  async balanceOf(userId: string): Promise<number> {
    const wallet = await this.prisma.coinWallet.findUnique({
      where: { userId: accountId(userId) },
      select: { balance: true },
    });

    return wallet?.balance ?? 0;
  }

  async credit(command: CoinCreditCommand): Promise<CoinEntryResult> {
    if (!(COIN_CREDIT_TYPES as readonly string[]).includes(command.type)) {
      throw new BadRequestException(`"${String(command.type)}" is not a coin credit type`);
    }

    return this.post(command, 'credit');
  }

  async spend(command: CoinSpendCommand): Promise<CoinEntryResult> {
    if (!(COIN_DEBIT_TYPES as readonly string[]).includes(command.type)) {
      throw new BadRequestException(`"${String(command.type)}" is not a coin debit type`);
    }

    return this.post(command, 'debit');
  }

  /**
   * The signup grant, paid once the identifier the setting names has been verified.
   *
   * Three rules, all inside the wallet's own transaction: a 0 setting means the grant is
   * disabled and nothing is written; a grant that already exists is returned rather than
   * attempted again; and one normalized email address earns the grant once, whichever
   * account it is spelled on. The partial unique index on the ledger stays as the backstop
   * for a caller that ever bypasses this path.
   */
  async grantSignupCoins(userId: string): Promise<CoinEntryResult | null> {
    const id = accountId(userId);

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { status: true, email: true, emailVerifiedAt: true, firstVerifiedMobile: true },
    });
    if (user === null || user.status !== 'ACTIVE') {
      return null;
    }

    const requirement = await this.settingText(SIGNUP_GRANT_REQUIREMENT_SETTING);
    const verified = requirement === 'mobile' ? user.firstVerifiedMobile !== null : user.emailVerifiedAt !== null;
    if (!verified) {
      return null;
    }

    const amount = await this.settingInt(SIGNUP_COINS_SETTING);
    if (amount === 0) {
      return null;
    }

    const reference: CoinReference = { type: 'signup', id };
    const fingerprint = requestFingerprint({ type: 'SIGNUP_GRANT', amount, reference });
    const normalized = requirement === 'email' ? normaliseEmail(user.email) : null;

    try {
      const outcome = await this.prisma.$transaction(
        async (tx) =>
          this.applyEntry(
            tx,
            {
              userId: id,
              type: 'SIGNUP_GRANT',
              signedAmount: amount,
              idempotencyKey: `signup:${id}`,
              referenceType: reference.type,
              referenceId: id,
              description: 'Signup coins',
              createdBy: null,
              fingerprint,
            },
            async (locked) => {
              const existing = await locked.$queryRaw<LedgerRow[]>`
                SELECT "id", "user_id", "type", "amount", "previous_balance", "new_balance",
                       "idempotency_key", "request_fingerprint", "created_at"
                FROM "coin_transactions"
                WHERE "user_id" = ${id}::uuid AND "type" = 'SIGNUP_GRANT'
                LIMIT 1
              `;

              const row = existing[0];
              if (row !== undefined) {
                return row;
              }

              if (normalized !== null) {
                const claimed = await locked.$executeRaw`
                  INSERT INTO "coin_grant_identities" ("kind", "value", "user_id")
                  VALUES ('EMAIL', ${normalized}, ${id}::uuid)
                  ON CONFLICT ("kind", "value") DO NOTHING
                `;

                if (claimed === 0) {
                  throw new GrantNotEarned();
                }
              }

              return null;
            },
          ),
        { timeout: 10_000, maxWait: 10_000 },
      );

      if (outcome.kind === 'conflict') {
        throw new ConflictException('That idempotency key was already used for a different coin entry');
      }

      return toResult(outcome.row, outcome.kind === 'replay');
    } catch (error) {
      if (error instanceof GrantNotEarned) {
        return null;
      }
      throw error;
    }
  }

  /** A wallet insert for an account that does not exist is a 404, not a server error. */
  private rethrowMissingAccount(error: unknown): never {
    if (isMissingAccount(error)) {
      throw new NotFoundException('No account exists with that id');
    }

    throw error;
  }

  /**
   * The daily reward: one `daily_rewards` row and its ledger row, in one transaction, on the
   * first successful sign-in of each Asia/Kolkata day.
   *
   * The unique (user_id, reward_date) pair and the ledger's own idempotency key both key on
   * the date, so ten parallel sign-ins serialise on the wallet row and only the first writes;
   * the rest find the ledger row and report `paid: false`.
   */
  async payDailyReward(userId: string, options: { readonly now?: Date } = {}): Promise<DailyRewardResult> {
    const id = accountId(userId);
    const rewardDate = businessDate(options.now ?? new Date());
    const amount = await this.settingInt(DAILY_REWARD_COINS_SETTING);
    if (amount === 0) {
      return { paid: false, rewardDate, amount, newBalance: await this.balanceOf(id) };
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { status: true, emailVerifiedAt: true, firstVerifiedMobile: true },
    });

    if (user === null || user.status !== 'ACTIVE') {
      return { paid: false, rewardDate, amount, newBalance: await this.balanceOf(id) };
    }

    // The reward follows the same identifier the grant does: with 'mobile' required, an
    // account that has only verified an email has not identified itself yet.
    const requirement = await this.settingText(SIGNUP_GRANT_REQUIREMENT_SETTING);
    const identified = requirement === 'mobile' ? user.firstVerifiedMobile !== null : user.emailVerifiedAt !== null;
    if (!identified) {
      return { paid: false, rewardDate, amount, newBalance: await this.balanceOf(id) };
    }

    const reference: CoinReference = { type: 'daily_reward', id: rewardDate };
    const fingerprint = requestFingerprint({ type: 'DAILY_REWARD', amount, reference });

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const entry = await this.applyEntry(tx, {
          userId: id,
          type: 'DAILY_REWARD',
          signedAmount: amount,
          idempotencyKey: `daily:${rewardDate}`,
          referenceType: reference.type,
          referenceId: rewardDate,
          description: 'Daily reward',
          createdBy: null,
          fingerprint,
        });

        if (entry.kind !== 'posted') {
          return entry;
        }

        await tx.$executeRaw`
          INSERT INTO "daily_rewards" ("user_id", "reward_date", "amount", "coin_transaction_id")
          VALUES (${id}::uuid, ${rewardDate}::date, ${amount}, ${entry.row.id}::uuid)
        `;

        return entry;
      },
      { timeout: 10_000, maxWait: 10_000 },
    );

    if (outcome.kind === 'conflict') {
      await this.recordMismatch({ userId: id, idempotencyKey: `daily:${rewardDate}`, type: 'DAILY_REWARD', signedAmount: amount, createdBy: null, fingerprint });
      throw new ConflictException('That idempotency key was already used for a different coin entry');
    }

    return { paid: outcome.kind === 'posted', rewardDate, amount, newBalance: outcome.row.new_balance };
  }

  /**
   * An Administrator's single add or deduct.
   *
   * The remark is mandatory because a ledger row that says nothing is not an explanation,
   * the amount is capped by a setting, and the entry names its author. The key is fresh per
   * action: two clicks are two decisions, and the audit trail should show both.
   */
  async adjust(
    actor: { readonly id: string; readonly roleCode: string },
    input: { readonly userId: string; readonly amount: number; readonly remark: string },
  ): Promise<CoinEntryResult> {
    const userId = accountId(input.userId);
    const amount = magnitude(Math.abs(input.amount));
    const remark = input.remark.trim();

    if (remark.length === 0) {
      throw new BadRequestException('A coin adjustment needs a remark');
    }
    if (remark.length > 500) {
      throw new BadRequestException('A coin adjustment remark is at most 500 characters');
    }

    const cap = await this.settingInt('coin_max_adjustment_per_operation');
    if (amount > cap) {
      throw new BadRequestException(`One adjustment moves at most ${String(cap)} coins`);
    }

    const isCredit = input.amount > 0;

    return this.post(
      {
        userId,
        amount,
        type: isCredit ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
        idempotencyKey: `admin:${randomUUID()}`,
        reference: { type: 'admin_adjustment', id: actor.id },
        description: remark,
        createdBy: actor.id,
      },
      isCredit ? 'credit' : 'debit',
    );
  }

  /** One page of an account's history, with what the wallet has earned and spent overall. */
  async history(
    userId: string,
    query: { readonly type?: string; readonly page: number; readonly pageSize: number },
  ): Promise<CoinHistoryResult> {
    const id = accountId(userId);
    const where: Prisma.CoinTransactionWhereInput = { userId: id, ...(query.type ? { type: query.type } : {}) };

    const [rows, total, earned, spent, wallet] = await Promise.all([
      this.prisma.coinTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.coinTransaction.count({ where }),
      this.prisma.coinTransaction.aggregate({ _sum: { amount: true }, where: { userId: id, amount: { gt: 0 } } }),
      this.prisma.coinTransaction.aggregate({ _sum: { amount: true }, where: { userId: id, amount: { lt: 0 } } }),
      this.prisma.coinWallet.findUnique({ where: { userId: id }, select: { balance: true } }),
    ]);

    return {
      items: rows.map((row) => toResultFromModel(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      balance: wallet?.balance ?? 0,
      totalEarned: earned._sum.amount ?? 0,
      totalSpent: Math.abs(spent._sum.amount ?? 0),
    };
  }

  /**
   * One batch of a bulk assignment, run where the ledger is written: here.
   *
   * Every person's row is its own ledger entry, keyed `<job>:<user>`, so a job killed
   * halfway and run again pays nobody twice however many times it is resumed. A row that
   * fails is remembered and does not stop the rest.
   */
  async runBulkJob(jobId: string, options: { readonly batchSize?: number } = {}): Promise<BulkBatchResult> {
    const job = await this.prisma.coinBulkJob.findUnique({ where: { id: jobId } });
    if (job === null) {
      throw new NotFoundException('No such bulk job');
    }

    if (job.status === 'COMPLETED' || job.status === 'FAILED') {
      return { processed: 0, remaining: 0, status: job.status };
    }

    await this.prisma.coinBulkJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date() },
    });

    const rows = await this.prisma.coinBulkJobRow.findMany({
      where: { jobId, status: 'PENDING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: options.batchSize ?? 50,
    });

    let credited = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const entry = await this.credit({
          userId: row.userId,
          amount: job.amount,
          type: 'ADMIN_CREDIT',
          idempotencyKey: `${job.id}:${row.userId}`,
          reference: { type: 'bulk_assignment', id: job.id },
          description: job.remark,
          createdBy: job.createdBy,
        });

        await this.prisma.coinBulkJobRow.update({
          where: { id: row.id },
          data: { status: 'CREDITED', coinTransactionId: entry.id },
        });
        credited += 1;
      } catch (error) {
        await this.prisma.coinBulkJobRow.update({
          where: { id: row.id },
          data: { status: 'FAILED', errorMessage: String(error).slice(0, 500) },
        });
        failed += 1;
      }
    }

    const remaining = await this.prisma.coinBulkJobRow.count({ where: { jobId, status: 'PENDING' } });
    const status = remaining === 0 ? 'COMPLETED' : 'RUNNING';

    await this.prisma.coinBulkJob.update({
      where: { id: jobId },
      data: {
        creditedUsers: { increment: credited },
        failedUsers: { increment: failed },
        status,
        finishedAt: remaining === 0 ? new Date() : null,
      },
    });

    return { processed: credited + failed, remaining, status };
  }

  private async post(
    command: CoinCreditCommand | CoinSpendCommand,
    direction: 'credit' | 'debit',
  ): Promise<CoinEntryResult> {
    const amount = magnitude(command.amount);
    const signedAmount = direction === 'credit' ? amount : -amount;
    const userId = accountId(command.userId);
    const idempotencyKey = key(command.idempotencyKey);
    const createdBy = command.createdBy ?? null;

    const referenceType = command.reference?.type ?? null;
    const referenceId = command.reference?.id ?? null;
    if ((referenceType === null) !== (referenceId === null)) {
      throw new BadRequestException('A coin reference needs both a type and an id');
    }

    const fingerprint = requestFingerprint({
      type: command.type,
      amount: signedAmount,
      reference: command.reference ?? null,
    });

    const outcome = await this.prisma.$transaction((tx) =>
      this.applyEntry(tx, {
        userId,
        type: command.type,
        signedAmount,
        idempotencyKey,
        referenceType,
        referenceId,
        description: command.description ?? null,
        createdBy,
        fingerprint,
      }),
      // Thirty callers can queue on one wallet. Lock acquisition is the only wait, so a
      // generous ceiling costs nothing and keeps a slow CI runner from timing out.
      { timeout: 10_000, maxWait: 10_000 },
    );

    if (outcome.kind === 'conflict') {
      await this.recordMismatch({ userId, idempotencyKey, type: command.type, signedAmount, createdBy, fingerprint });
      throw new ConflictException('That idempotency key was already used for a different coin entry');
    }

    return toResult(outcome.row, outcome.kind === 'replay');
  }

  /**
   * One movement, inside a transaction the caller already opened.
   *
   * The wallet row is locked first, so a second writer of the same ledger waits here and
   * then reads the balance this one committed. The replay lookup happens after the lock for
   * the same reason: only one transaction at a time can decide what the next balance is.
   */
  private async applyEntry(
    tx: Prisma.TransactionClient,
    request: EntryRequest,
    guard?: (locked: Prisma.TransactionClient) => Promise<LedgerRow | null>,
  ): Promise<EntryOutcome> {
    try {
      await tx.$executeRaw`
        INSERT INTO "coin_wallets" ("user_id")
        VALUES (${request.userId}::uuid)
        ON CONFLICT ("user_id") DO NOTHING
      `;
    } catch (error) {
      this.rethrowMissingAccount(error);
    }

    const wallets = await tx.$queryRaw<Array<{ balance: number }>>`
      SELECT "balance"
      FROM "coin_wallets"
      WHERE "user_id" = ${request.userId}::uuid
      FOR UPDATE
    `;

    const wallet = wallets[0];
    if (wallet === undefined) {
      throw new NotFoundException('No coin wallet exists for that account');
    }

    const existing = await tx.$queryRaw<LedgerRow[]>`
      SELECT "id", "user_id", "type", "amount", "previous_balance", "new_balance",
             "idempotency_key", "request_fingerprint", "created_at"
      FROM "coin_transactions"
      WHERE "user_id" = ${request.userId}::uuid AND "idempotency_key" = ${request.idempotencyKey}
    `;

    const replayed = existing[0];
    if (replayed !== undefined) {
      if (replayed.request_fingerprint !== request.fingerprint) {
        return { kind: 'conflict' };
      }

      return { kind: 'replay', row: replayed };
    }

    // A caller with a rule of its own (the signup grant) decides here, under the lock and in
    // this transaction, so the decision and the row it produces cannot come apart.
    if (guard !== undefined) {
      const settled = await guard(tx);
      if (settled !== null) {
        return { kind: 'replay', row: settled };
      }
    }

    const newBalance = wallet.balance + request.signedAmount;
    if (newBalance < 0) {
      throw new BadRequestException('Not enough coins for this charge');
    }
    if (newBalance > MAX_COIN_BALANCE) {
      throw new BadRequestException('That would take the wallet past its highest possible balance');
    }

    const inserted = await tx.$queryRaw<LedgerRow[]>`
      INSERT INTO "coin_transactions" (
        "user_id", "type", "amount", "previous_balance", "new_balance",
        "reference_type", "reference_id", "description", "created_by",
        "idempotency_key", "request_fingerprint"
      ) VALUES (
        ${request.userId}::uuid, ${request.type}, ${request.signedAmount}, ${wallet.balance}, ${newBalance},
        ${request.referenceType}, ${request.referenceId}, ${request.description}, ${request.createdBy}::uuid,
        ${request.idempotencyKey}, ${request.fingerprint}
      )
      RETURNING "id", "user_id", "type", "amount", "previous_balance", "new_balance",
                "idempotency_key", "request_fingerprint", "created_at"
    `;

    const row = inserted[0];
    if (row === undefined) {
      throw new Error('The ledger accepted a row and did not return it');
    }

    return { kind: 'posted', row };
  }

  /** A key that was reused for a different intent is a bug worth a record, not a retry. */
  private async recordMismatch(intent: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly type: string;
    readonly signedAmount: number;
    readonly createdBy: string | null;
    readonly fingerprint: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await writeIdentityAudit(tx, {
        action: 'COIN_IDEMPOTENCY_MISMATCH',
        actorUserId: intent.createdBy,
        entityType: 'coin_transaction',
        entityId: null,
        metadata: {
          userId: intent.userId,
          idempotencyKey: intent.idempotencyKey,
          requestedType: intent.type,
          requestedAmount: intent.signedAmount,
          requestedFingerprint: intent.fingerprint,
        },
      });
    });
  }

  private async settingInt(name: string): Promise<number> {
    const row = await this.prisma.setting.findUnique({ where: { key: name }, select: { valueInt: true } });
    if (row === null || row.valueInt === null) {
      throw new Error(`The ${name} setting is missing`);
    }

    return row.valueInt;
  }

  private async settingText(name: string): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: name }, select: { valueText: true } });
    if (row === null || row.valueText === null) {
      throw new Error(`The ${name} setting is missing`);
    }

    return row.valueText;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function accountId(value: string): string {
  if (!UUID.test(value)) {
    throw new BadRequestException('A coin entry needs a real account id');
  }

  return value;
}

function magnitude(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BadRequestException('A coin amount is a positive whole number of coins');
  }

  return value;
}

function key(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 200) {
    throw new BadRequestException('An idempotency key is between 8 and 200 characters');
  }

  return trimmed;
}

function isMissingAccount(error: unknown): boolean {
  return error instanceof Error && /23503/.test(error.message) && /coin_wallets/.test(error.message);
}

/** Raised by the grant's own guard when another account already used the identity. */
class GrantNotEarned extends Error {}

function toResult(row: LedgerRow, replayed: boolean): CoinEntryResult {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type as CoinTransactionType,
    amount: row.amount,
    previousBalance: row.previous_balance,
    newBalance: row.new_balance,
    idempotencyKey: row.idempotency_key,
    replayed,
    createdAt: row.created_at.toISOString(),
  };
}

/** The same answer from a row the ORM already typed. */
function toResultFromModel(row: {
  readonly id: string;
  readonly userId: string;
  readonly type: string;
  readonly amount: number;
  readonly previousBalance: number;
  readonly newBalance: number;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
}): CoinEntryResult {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as CoinTransactionType,
    amount: row.amount,
    previousBalance: row.previousBalance,
    newBalance: row.newBalance,
    idempotencyKey: row.idempotencyKey,
    replayed: false,
    createdAt: row.createdAt.toISOString(),
  };
}
