import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { RedisService } from '../infra/redis.service';
import { DATABASE_PROBE, REDIS_PROBE } from '../infra/tokens';
import { businessDate } from '../otp/otp-code';

/**
 * The nightly wallet reconciliation (phase 5, item 4a).
 *
 * Every wallet is a cache of the ledger, and the ledger's trigger is what moves it. This
 * check recomputes what each wallet *should* hold — the sum of its entries and the balance
 * the newest entry left behind — and reports any wallet that disagrees. It is deliberately
 * read-only: a mismatch is evidence for an operator, and "repairing" it here would hide the
 * bug that caused it. Wallets are read in keyset batches (ordered by `user_id`), so the scan
 * never holds a transaction open across the table and never locks a row it does not need.
 */
export interface ReconciliationResult {
  readonly walletsChecked: number;
  readonly mismatches: number;
}

export const RECONCILIATION_BATCH_SIZE = 500;
/** Nothing is deleted after this; a month is long enough to notice a trend. */
export const RECONCILIATION_COUNTER_TTL_SECONDS = 30 * 24 * 60 * 60;
export const COIN_RECONCILIATION_MISMATCH = 'COIN_RECONCILIATION_MISMATCH';

const FIRST_USER_ID = '00000000-0000-0000-0000-000000000000';

interface WalletRow {
  readonly user_id: string;
  readonly balance: number;
  readonly ledger_sum: bigint | number | null;
  readonly last_balance: number | null;
}

@Injectable()
export class CoinReconciliationService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(REDIS_PROBE) private readonly redisService: RedisService,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  async reconcile(batchSize: number = RECONCILIATION_BATCH_SIZE): Promise<ReconciliationResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
      throw new BadRequestException('A reconciliation batch is between 1 and 5000 wallets');
    }

    let cursor = FIRST_USER_ID;
    let walletsChecked = 0;
    let mismatches = 0;

    for (;;) {
      const rows = await this.prisma.$queryRaw<WalletRow[]>`
        SELECT
          w."user_id",
          w."balance",
          COALESCE(
            (SELECT SUM(t."amount") FROM "coin_transactions" t WHERE t."user_id" = w."user_id"),
            0
          ) AS "ledger_sum",
          (
            SELECT t2."new_balance"
            FROM "coin_transactions" t2
            WHERE t2."user_id" = w."user_id"
            ORDER BY t2."created_at" DESC, t2."id" DESC
            LIMIT 1
          ) AS "last_balance"
        FROM "coin_wallets" w
        WHERE w."user_id" > ${cursor}::uuid
        ORDER BY w."user_id"
        LIMIT ${batchSize}
      `;

      const last = rows[rows.length - 1];

      if (last === undefined) {
        break;
      }

      cursor = last.user_id;
      walletsChecked += rows.length;

      for (const row of rows) {
        if (this.disagrees(row)) {
          mismatches += 1;
          await this.report(row.user_id);
        }
      }

      if (rows.length < batchSize) {
        break;
      }
    }

    return { walletsChecked, mismatches };
  }

  private disagrees(row: WalletRow): boolean {
    const sum = Number(row.ledger_sum ?? 0);
    const last = row.last_balance === null ? null : Number(row.last_balance);

    return row.balance !== sum || (last !== null && last !== row.balance);
  }

  /** The alert counter and the audit row: the account id, and nothing a person typed. */
  private async report(userId: string): Promise<void> {
    const key = `coins:reconciliation_mismatch:${businessDate(new Date())}`;

    await this.redisService.redis.multi().incr(key).expire(key, RECONCILIATION_COUNTER_TTL_SECONDS).exec();

    await writeIdentityAudit(this.prisma, {
      action: COIN_RECONCILIATION_MISMATCH,
      entityType: 'user',
      entityId: userId,
      metadata: {},
    });
  }
}
