import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import { nationalDigits } from '../otp/otp-code';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { CoinService, type CoinEntryResult, type CoinHistoryResult } from './coin.service';
import { csvLine } from './csv';

/**
 * The Administrator's coin tools.
 *
 * Everything here is a decision recorded in the audit trail and, where money moves, a
 * ledger row: a single adjustment names its author and its reason, a bulk assignment is a
 * job whose every person is one row, and reading somebody's history to take a copy of it
 * is itself an audited act.
 */

export interface CoinRecipient {
  readonly id: string;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly fullName: string;
  readonly status: string;
}

export interface BulkPreview {
  readonly matched: CoinRecipient[];
  readonly unmatched: string[];
  readonly amount: number;
  readonly totalCoins: number;
}

export interface BulkJobView {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly remark: string;
  readonly totalUsers: number;
  readonly creditedUsers: number;
  readonly failedUsers: number;
  readonly createdAt: string;
  readonly rows: Array<{
    readonly userId: string;
    readonly email: string | null;
    readonly status: string;
    readonly errorMessage: string | null;
  }>;
}

const RECIPIENT_SELECT = {
  id: true,
  email: true,
  mobile: true,
  fullName: true,
  status: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class CoinsService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(CoinService) private readonly coins: CoinService,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  /** A few accounts matching what the Administrator typed, for the picker. */
  async searchRecipients(query: string): Promise<CoinRecipient[]> {
    const term = query.trim();
    if (term.length < 2) {
      return [];
    }

    const digits = term.replace(/\D/g, '');
    return this.prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: term.toLowerCase() } },
          { fullName: { contains: term, mode: 'insensitive' } },
          ...(digits.length >= 4 ? [{ mobile: { contains: digits } }] : []),
        ],
      },
      select: RECIPIENT_SELECT,
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
  }

  /**
   * A preview of who a bulk assignment would reach, and what it would move.
   *
   * The confirmation screen shows exactly this and nothing else; the job is then created
   * from the ids the Administrator confirmed, never from the raw list again.
   */
  async preview(input: { readonly identifiers?: readonly string[]; readonly amount: number }): Promise<BulkPreview> {
    const identifiers = (input.identifiers ?? []).map((value) => value.trim()).filter((value) => value !== '');
    const amount = Math.abs(Math.trunc(input.amount));

    const matched: CoinRecipient[] = [];
    const unmatched: string[] = [];
    const seen = new Set<string>();

    for (const identifier of identifiers) {
      const user = await this.resolve(identifier);
      if (user === null) {
        unmatched.push(identifier);
        continue;
      }
      if (!seen.has(user.id)) {
        seen.add(user.id);
        matched.push(user);
      }
    }

    const limits = await this.limits();
    if (matched.length > limits.users) {
      throw new BadRequestException(`A bulk assignment reaches at most ${String(limits.users)} accounts`);
    }
    if (matched.length * amount > limits.coins) {
      throw new BadRequestException(`A bulk assignment moves at most ${String(limits.coins)} coins`);
    }

    return { matched, unmatched, amount, totalCoins: matched.length * amount };
  }

  /** Creates the job and its rows. The worker drains it; the ledger is written by CoinService. */
  async startBulk(
    actor: AuthenticatedUser,
    input: { readonly userIds: readonly string[]; readonly amount: number; readonly remark: string },
    meta: { readonly ip?: string | undefined } = {},
  ): Promise<{ id: string; totalUsers: number; totalCoins: number }> {
    const remark = input.remark.trim();
    if (remark.length === 0) {
      throw new BadRequestException('A bulk assignment needs a remark');
    }
    if (remark.length > 500) {
      throw new BadRequestException('A bulk assignment remark is at most 500 characters');
    }

    const amount = Math.trunc(input.amount);
    if (amount <= 0) {
      throw new BadRequestException('A bulk assignment credits a positive number of coins');
    }

    const userIds = [...new Set(input.userIds)];

    if (userIds.length === 0) {
      throw new BadRequestException('A bulk assignment needs at least one account');
    }

    const limits = await this.limits();
    if (userIds.length > limits.users) {
      throw new BadRequestException(`A bulk assignment reaches at most ${String(limits.users)} accounts`);
    }
    if (userIds.length * amount > limits.coins) {
      throw new BadRequestException(`A bulk assignment moves at most ${String(limits.coins)} coins`);
    }

    const found = await this.prisma.user.count({ where: { id: { in: userIds } } });
    if (found !== userIds.length) {
      throw new BadRequestException('A bulk assignment names an account that does not exist');
    }

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.coinBulkJob.create({
        data: { createdBy: actor.id, amount, remark, totalUsers: userIds.length },
        select: { id: true },
      });

      await tx.coinBulkJobRow.createMany({
        data: userIds.map((userId) => ({ jobId: job.id, userId })),
      });

      await writeIdentityAudit(tx, {
        action: 'COIN_BULK_QUEUED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'coin_bulk_job',
        entityId: job.id,
        metadata: { users: userIds.length, amount, remark },
        ip: meta.ip ?? null,
      });

      return { id: job.id, totalUsers: userIds.length, totalCoins: userIds.length * amount };
    });
  }

  async status(jobId: string): Promise<BulkJobView> {
    const job = await this.prisma.coinBulkJob.findUnique({
      where: { id: jobId },
      include: {
        rows: {
          include: { user: { select: { email: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (job === null) {
      throw new NotFoundException('No such bulk job');
    }

    return {
      id: job.id,
      status: job.status,
      amount: job.amount,
      remark: job.remark,
      totalUsers: job.totalUsers,
      creditedUsers: job.creditedUsers,
      failedUsers: job.failedUsers,
      createdAt: job.createdAt.toISOString(),
      rows: job.rows.map((row) => ({
        userId: row.userId,
        email: row.user.email,
        status: row.status,
        errorMessage: row.errorMessage,
      })),
    };
  }

  /** The downloadable report for one job, with every cell neutralised. */
  async report(jobId: string): Promise<{ csv: string; rows: number }> {
    const view = await this.status(jobId);
    const lines = [
      csvLine(['user_id', 'email', 'status', 'coins', 'error']),
      ...view.rows.map((row) =>
        csvLine([row.userId, row.email, row.status, row.status === 'CREDITED' ? view.amount : 0, row.errorMessage]),
      ),
    ];

    return { csv: `${lines.join('\n')}\n`, rows: view.rows.length };
  }

  adjust(
    actor: AuthenticatedUser,
    input: { readonly userId: string; readonly amount: number; readonly remark: string },
  ): Promise<CoinEntryResult> {
    return this.coins.adjust(actor, input);
  }

  history(userId: string, query: { readonly type?: string; readonly page: number; readonly pageSize: number }): Promise<CoinHistoryResult> {
    return this.coins.history(userId, query);
  }

  /** A copy of one account's ledger, and a record that it was taken. */
  async exportLedger(
    actor: AuthenticatedUser,
    userId: string,
    query: { readonly type?: string; readonly page: number; readonly pageSize: number },
    meta: { readonly ip?: string | undefined } = {},
  ): Promise<{ csv: string; rows: number }> {
    const history = await this.coins.history(userId, { ...query, page: 1, pageSize: 500 });

    const lines = [
      csvLine(['created_at', 'type', 'amount', 'previous_balance', 'new_balance', 'idempotency_key']),
      ...history.items.map((entry) =>
        csvLine([
          entry.createdAt,
          entry.type,
          entry.amount,
          entry.previousBalance,
          entry.newBalance,
          entry.idempotencyKey,
        ]),
      ),
    ];

    await writeIdentityAudit(this.prisma, {
      action: 'COIN_LEDGER_EXPORTED',
      actorUserId: actor.id,
      actorRole: actor.roleCode,
      entityType: 'coin_transaction',
      entityId: userId,
      metadata: { rows: history.items.length, userId, type: query.type ?? null },
      ip: meta.ip ?? null,
    });

    return { csv: `${lines.join('\n')}\n`, rows: history.items.length };
  }

  private async resolve(identifier: string): Promise<CoinRecipient | null> {
    const digits = nationalDigits(identifier);
    if (digits.length === 10) {
      const byMobile = await this.prisma.user.findFirst({ where: { mobile: digits }, select: RECIPIENT_SELECT });
      if (byMobile !== null) {
        return byMobile;
      }
    }

    return this.prisma.user.findUnique({ where: { email: identifier.toLowerCase() }, select: RECIPIENT_SELECT });
  }

  private async limits(): Promise<{ users: number; coins: number }> {
    const rows = await this.prisma.setting.findMany({
      where: { key: { in: ['coin_max_bulk_users', 'coin_max_bulk_coins'] } },
      select: { key: true, valueInt: true },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.valueInt ?? 0]));

    return { users: byKey.get('coin_max_bulk_users') ?? 0, coins: byKey.get('coin_max_bulk_coins') ?? 0 };
  }
}
