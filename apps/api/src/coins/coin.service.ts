import { createHash } from 'node:crypto';

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';

/**
 * The coin ledger.
 *
 * One service writes `coin_transactions`, and nothing else does: the database refuses an
 * update or a delete, the application role has no privilege to attempt one, and a
 * wallet's balance is moved by the ledger's own trigger inside the statement that inserts
 * the row. A caller therefore cannot post a balance — it can only ask for a movement, and
 * the ledger decides what the wallet becomes.
 *
 * Every movement carries an idempotency key. Replaying a key with the same fingerprint
 * returns the row that was written the first time and changes nothing; replaying it with
 * a different amount, type or reference is refused and audited, because that is two
 * different intents wearing one key.
 */

export const COIN_CREDIT_TYPES = ['SIGNUP_GRANT', 'DAILY_REWARD', 'ADMIN_CREDIT'] as const;
export const COIN_DEBIT_TYPES = ['ADMIN_DEBIT', 'ENROLLMENT'] as const;

export type CoinCreditType = (typeof COIN_CREDIT_TYPES)[number];
export type CoinDebitType = (typeof COIN_DEBIT_TYPES)[number];
export type CoinTransactionType = CoinCreditType | CoinDebitType;

/** The largest balance a Postgres `INTEGER` column can hold. */
export const MAX_COIN_BALANCE = 2_147_483_647;

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

    await this.prisma.$executeRaw`
      INSERT INTO "coin_wallets" ("user_id")
      VALUES (${id}::uuid)
      ON CONFLICT ("user_id") DO NOTHING
    `;

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

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "coin_wallets" ("user_id")
          VALUES (${userId}::uuid)
          ON CONFLICT ("user_id") DO NOTHING
        `;

        // The lock is what makes the balance below the one every other writer agrees on:
        // a second transaction waits here until this one commits.
        const wallets = await tx.$queryRaw<Array<{ balance: number }>>`
          SELECT "balance"
          FROM "coin_wallets"
          WHERE "user_id" = ${userId}::uuid
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
          WHERE "user_id" = ${userId}::uuid AND "idempotency_key" = ${idempotencyKey}
        `;

        const replayed = existing[0];
        if (replayed !== undefined) {
          if (replayed.request_fingerprint !== fingerprint) {
            return { kind: 'conflict' as const };
          }

          return { kind: 'replay' as const, row: replayed };
        }

        const newBalance = wallet.balance + signedAmount;
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
            ${userId}::uuid, ${command.type}, ${signedAmount}, ${wallet.balance}, ${newBalance},
            ${referenceType}, ${referenceId}, ${command.description ?? null}, ${createdBy}::uuid,
            ${idempotencyKey}, ${fingerprint}
          )
          RETURNING "id", "user_id", "type", "amount", "previous_balance", "new_balance",
                    "idempotency_key", "request_fingerprint", "created_at"
        `;

        const row = inserted[0];
        if (row === undefined) {
          throw new Error('The ledger accepted a row and did not return it');
        }

        return { kind: 'posted' as const, row };
      },
      // Fifty callers can queue on one wallet. Lock acquisition is the only wait, so a
      // generous ceiling costs nothing and keeps a slow CI runner from timing out.
      { timeout: 10_000, maxWait: 10_000 },
    );

    if (outcome.kind === 'conflict') {
      await this.prisma.$transaction(async (tx) => {
        await writeIdentityAudit(tx, {
          action: 'COIN_IDEMPOTENCY_MISMATCH',
          actorUserId: createdBy,
          entityType: 'coin_transaction',
          entityId: null,
          metadata: {
            userId,
            idempotencyKey,
            requestedType: command.type,
            requestedAmount: signedAmount,
            requestedFingerprint: fingerprint,
          },
        });
      });

      throw new ConflictException('That idempotency key was already used for a different coin entry');
    }

    return toResult(outcome.row, outcome.kind === 'replay');
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
