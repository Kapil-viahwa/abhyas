import { createHash, timingSafeEqual } from 'node:crypto';

import { Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, Public, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { requestMeta, type RequestLike } from '../auth/request';
import { loadConfig } from '../config/config';
import { CoinService, type BulkBatchResult, type CoinEntryResult, type CoinHistoryResult } from './coin.service';
import { CoinsService, type BulkJobView, type BulkPreview, type CoinRecipient } from './coins.service';

function parseHistory(query: Record<string, unknown>): { type?: string; page: number; pageSize: number } {
  const type = typeof query.type === 'string' && query.type.trim() !== '' ? query.type.trim() : undefined;
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(query.pageSize ?? '20'), 10) || 20));

  return { ...(type ? { type } : {}), page, pageSize };
}

/**
 * The Administrator's coin tools.
 *
 * One permission, `coins.write`, is declared on every route here and only ADMIN holds it, so
 * an editor and a student are refused by the guard rather than by a check inside a handler.
 * The actor is always the authenticated user: no route accepts `createdBy`, and a bulk job's
 * rows are written with the Administrator's own id.
 */
@ApiTags('admin-coins')
@Controller('v1/admin/coins')
export class CoinsController {
  constructor(@Inject(CoinsService) private readonly coins: CoinsService) {}

  @RequirePermissions('coins.write')
  @Get('recipients')
  @ApiOperation({ summary: 'Find accounts for the coin tools' })
  @ApiOkResponse({ description: 'At most twenty accounts matching the search' })
  @ApiForbiddenResponse({ description: 'The caller may not use the coin tools' })
  async recipients(@Query('q') query: string | undefined): Promise<CoinRecipient[]> {
    return this.coins.searchRecipients(typeof query === 'string' ? query : '');
  }

  @RequirePermissions('coins.write')
  @Post('adjust')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add or deduct coins for one account, with a mandatory remark' })
  @ApiOkResponse({ description: 'The ledger row that was written' })
  async adjust(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown): Promise<CoinEntryResult> {
    const input = (body ?? {}) as { userId?: unknown; amount?: unknown; remark?: unknown };

    return this.coins.adjust(actor, {
      userId: String(input.userId ?? ''),
      amount: Number(input.amount ?? 0),
      remark: String(input.remark ?? ''),
    });
  }

  @RequirePermissions('coins.write')
  @Get(':userId/ledger')
  @ApiOperation({ summary: 'One account’s coin history, filtered and paged' })
  @ApiOkResponse({ description: 'The page, and the balance and totals behind it' })
  async ledger(@Param('userId') userId: string, @Query() query: Record<string, unknown>): Promise<CoinHistoryResult> {
    return this.coins.history(userId, parseHistory(query));
  }

  @RequirePermissions('coins.write')
  @Get(':userId/ledger/export')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'The same history as CSV, and the export is audited' })
  @ApiOkResponse({ description: 'A CSV of the ledger rows' })
  async exportLedger(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: RequestLike,
  ): Promise<string> {
    const result = await this.coins.exportLedger(actor, userId, parseHistory(query), requestMeta(request));
    return result.csv;
  }

  @RequirePermissions('coins.write')
  @Post('bulk/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Who a bulk assignment would reach, and what it would move' })
  @ApiOkResponse({ description: 'Matched accounts, unmatched identifiers and the total' })
  async preview(@Body() body: unknown): Promise<BulkPreview> {
    const input = (body ?? {}) as { identifiers?: unknown; amount?: unknown };
    const identifiers = Array.isArray(input.identifiers) ? input.identifiers.map((value) => String(value)) : [];

    return this.coins.preview({ identifiers, amount: Number(input.amount ?? 0) });
  }

  @RequirePermissions('coins.write')
  @Post('bulk')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create the job for a confirmed list of accounts' })
  @ApiOkResponse({ description: 'The job id the status screen reads' })
  async startBulk(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<{ id: string; totalUsers: number; totalCoins: number }> {
    const input = (body ?? {}) as { userIds?: unknown; amount?: unknown; remark?: unknown };
    const userIds = Array.isArray(input.userIds) ? input.userIds.map((value) => String(value)) : [];
    const meta = requestMeta(request);

    return this.coins.startBulk(
      actor,
      { userIds, amount: Number(input.amount ?? 0), remark: String(input.remark ?? '') },
      meta.ip === undefined ? {} : { ip: meta.ip },
    );
  }

  @RequirePermissions('coins.write')
  @Get('bulk/:id')
  @ApiOperation({ summary: 'One bulk assignment and what happened to each person' })
  @ApiOkResponse({ description: 'The job and its rows' })
  async bulkStatus(@Param('id') id: string): Promise<BulkJobView> {
    return this.coins.status(id);
  }

  @RequirePermissions('coins.write')
  @Get('bulk/:id/report')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'The bulk report as CSV, with every cell neutralised' })
  @ApiOkResponse({ description: 'A CSV of the job rows' })
  async bulkReport(@Param('id') id: string): Promise<string> {
    const result = await this.coins.report(id);
    return result.csv;
  }
}

/**
 * The one door the worker knocks on to run a bulk job.
 *
 * The ledger has exactly one writer (`CoinService`), and it lives in this process, so the
 * worker does not write coins itself: it calls this route with the shared secret and this
 * process runs the batch. The route answers 404 — not 401 — when the secret is unset or
 * wrong, so it does not confirm that it exists.
 */
@ApiTags('internal')
@Controller('v1/internal/coins')
export class CoinsInternalController {
  constructor(@Inject(CoinService) private readonly coins: CoinService) {}

  @Public()
  @Post('bulk/drain')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run one batch of a queued bulk assignment' })
  async drain(@Req() request: RequestLike, @Body() body: unknown): Promise<BulkBatchResult> {
    const expected = loadConfig(process.env).REVALIDATE_SECRET;
    const presented = request.headers['x-internal-secret'];

    if (!matchesSecret(presented, expected)) {
      throw new NotFoundException();
    }

    const input = (body ?? {}) as { jobId?: unknown };
    return this.coins.runBulkJob(String(input.jobId ?? ''));
  }
}

function matchesSecret(presented: string | string[] | undefined, expected: string): boolean {
  if (expected === '' || presented === undefined) {
    return false;
  }

  const given = Array.isArray(presented) ? presented[0] : presented;
  if (given === undefined) {
    return false;
  }

  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();

  return timingSafeEqual(left, right);
}
