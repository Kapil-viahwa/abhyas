import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { businessDate } from '../otp/otp-code';
import { COIN_HISTORY_TYPES } from './validation';

/**
 * A student's own wallet (phase 5, item 4b, student half).
 *
 * The account always comes from the session and there is no `userId` parameter anywhere on
 * this surface: a caller cannot ask for somebody else's balance, and passing an id it invents
 * changes nothing. The response is a whitelist — ledger ids, idempotency keys, fingerprints and
 * who wrote a row never leave the server.
 */

export interface WalletOverview {
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalSpent: number;
  readonly today: {
    readonly rewardDate: string;
    readonly paid: boolean;
    readonly amount: number;
  };
  readonly nextRewardDate: string;
}

export interface WalletHistoryItem {
  readonly type: string;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly description: string | null;
  readonly reference: string | null;
  readonly createdAt: string;
}

export interface WalletHistoryPage {
  readonly items: WalletHistoryItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

const MAX_PAGE_SIZE = 100;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class WalletService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async overview(userId: string, at: Date = new Date()): Promise<WalletOverview> {
    await this.assertActive(userId);

    const today = businessDate(at);
    const [wallet, earned, spent, reward, setting] = await Promise.all([
      this.prisma.coinWallet.findUnique({ where: { userId }, select: { balance: true } }),
      this.prisma.coinTransaction.aggregate({ _sum: { amount: true }, where: { userId, amount: { gt: 0 } } }),
      this.prisma.coinTransaction.aggregate({ _sum: { amount: true }, where: { userId, amount: { lt: 0 } } }),
      this.prisma.coinDailyReward.findUnique({
        where: { userId_rewardDate: { userId, rewardDate: istDate(today) } },
        select: { amount: true },
      }),
      this.prisma.setting.findUnique({ where: { key: 'daily_reward_coins' }, select: { valueInt: true } }),
    ]);

    return {
      balance: wallet?.balance ?? 0,
      totalEarned: earned._sum.amount ?? 0,
      totalSpent: Math.abs(spent._sum.amount ?? 0),
      today: {
        rewardDate: today,
        paid: reward !== null,
        amount: reward?.amount ?? setting?.valueInt ?? 0,
      },
      nextRewardDate: nextDay(today),
    };
  }

  async history(userId: string, query: Record<string, unknown>): Promise<WalletHistoryPage> {
    await this.assertActive(userId);

    const page = wholeNumber(query.page, 'page', 1, 10_000);
    const pageSize = wholeNumber(query.pageSize, 'pageSize', 1, MAX_PAGE_SIZE);
    const type = historyType(query.type);
    const from = dateBoundary(query.from, 'from');
    const to = dateBoundary(query.to, 'to');

    if (from !== undefined && to !== undefined && from > to) {
      throw new BadRequestException('from must not be later than to');
    }

    const where = {
      userId,
      ...(type === undefined ? {} : { type }),
      ...(from === undefined && to === undefined
        ? {}
        : { createdAt: { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lte: to }) } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.coinTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.coinTransaction.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        type: row.type,
        amount: row.amount,
        balanceAfter: row.newBalance,
        description: row.description,
        reference: row.referenceType,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  private async assertActive(userId: string): Promise<void> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });

    if (row === null) {
      throw new NotFoundException('Account not found');
    }

    if (row.status !== 'ACTIVE') {
      throw new ForbiddenException('This account is not active');
    }
  }
}

/** A whole number from a query string; anything else is refused rather than coerced. */
function wholeNumber(value: unknown, label: string, min: number, max: number): number {
  if (value === undefined || value === null || value === '') {
    return min;
  }

  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) {
    throw new BadRequestException(`${label} must be a whole number`);
  }

  const number = Number(value);

  if (number < min || number > max) {
    throw new BadRequestException(`${label} must be between ${String(min)} and ${String(max)}`);
  }

  return number;
}

function historyType(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || !(COIN_HISTORY_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException(`type must be one of ${COIN_HISTORY_TYPES.join(', ')}`);
  }

  return value;
}

/** `YYYY-MM-DD` as the UTC instant a `timestamptz` column compares against. */
function dateBoundary(value: unknown, label: string): Date | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new BadRequestException(`${label} must be a date (YYYY-MM-DD)`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${label} must be a date (YYYY-MM-DD)`);
  }

  // An end date covers the whole day.
  return label === 'to' ? new Date(parsed.getTime() + 24 * 60 * 60 * 1000 - 1) : parsed;
}

function istDate(businessDateString: string): Date {
  return new Date(`${businessDateString}T00:00:00.000Z`);
}

function nextDay(businessDateString: string): string {
  return new Date(istDate(businessDateString).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
