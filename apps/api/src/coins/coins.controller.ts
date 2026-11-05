import { Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { parseAllowedAddress, type AllowedAddress } from '@abhyas/shared';

import { CurrentUser, Public, RequirePermissions, type AuthenticatedUser } from '../auth/access';
import { ReauthenticationService } from '../auth/reauthentication.service';
import { requestMeta, type RequestLike } from '../auth/request';
import { loadConfig } from '../config/config';
import { RedisService } from '../infra/redis.service';
import { REDIS_PROBE } from '../infra/tokens';
import { CoinService, type BulkBatchResult, type CoinEntryResult, type CoinHistoryResult } from './coin.service';
import { CoinsService, type BulkJobView, type BulkPreview, type CoinRecipient } from './coins.service';
import {
  INTERNAL_FAILURE_LIMIT,
  INTERNAL_FAILURE_WINDOW_SECONDS,
  addressAllowed,
  internalFailureKey,
  secretMatches,
} from './internal-access';
import {
  COIN_HARD_BULK_CEILING,
  parseCoinAmount,
  parseHistoryType,
  parseIdempotencyKey,
  parseIdentifierArray,
  parsePageNumber,
  parsePageSize,
  parsePositiveCoins,
  parseReauthenticationProof,
  parseRemark,
  parseUserIdArray,
  parseUuid,
  type CoinReauthenticationProof,
} from './validation';

function parseHistory(query: Record<string, unknown>): { type?: string; page: number; pageSize: number } {
  const type = parseHistoryType(query.type);
  const page = query.page === undefined ? 1 : parsePageNumber(query.page);
  const pageSize = query.pageSize === undefined ? 20 : parsePageSize(query.pageSize);

  return { ...(type ? { type } : {}), page, pageSize };
}

/**
 * The Administrator's coin tools.
 *
 * One permission, `coins.write`, is declared on every route here and only ADMIN holds it, so
 * an editor and a student are refused by the guard rather than by a check inside a handler.
 * The actor is always the authenticated user: no route accepts `createdBy`, and a bulk job's
 * rows are written with the Administrator's own id.
 *
 * A write also needs the form's `Idempotency-Key` and a proof of the person made in the last
 * ten minutes (`reauth`), because these routes move money (phase 5, item 3b).
 */
@ApiTags('admin-coins')
@Controller('v1/admin/coins')
export class CoinsController {
  constructor(
    @Inject(CoinsService) private readonly coins: CoinsService,
    @Inject(ReauthenticationService) private readonly reauth: ReauthenticationService,
  ) {}

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
  async adjust(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: RequestLike,
  ): Promise<CoinEntryResult> {
    const input = (body ?? {}) as { userId?: unknown; amount?: unknown; remark?: unknown; reauth?: unknown };
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    const meta = requestMeta(request);
    const proof = parseReauthenticationProof(input.reauth);
    const adjustment = {
      userId: parseUuid(input.userId, 'userId'),
      amount: parseCoinAmount(input.amount),
      remark: parseRemark(input.remark),
    };

    await this.requireStepUp(actor, proof, meta);

    return this.coins.adjustIdempotent(actor, key, adjustment, meta);
  }

  @RequirePermissions('coins.write')
  @Get(':userId/ledger')
  @ApiOperation({ summary: 'One account’s coin history, filtered and paged' })
  @ApiOkResponse({ description: 'The page, and the balance and totals behind it' })
  async ledger(@Param('userId') userId: string, @Query() query: Record<string, unknown>): Promise<CoinHistoryResult> {
    return this.coins.history(parseUuid(userId, 'userId'), parseHistory(query));
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
    const result = await this.coins.exportLedger(
      actor,
      parseUuid(userId, 'userId'),
      parseHistory(query),
      requestMeta(request),
    );

    return result.csv;
  }

  @RequirePermissions('coins.write')
  @Post('bulk/preview')
  @HttpCode(200)
  @ApiOperation({ summary: 'Who a bulk assignment would reach, and what it would move' })
  @ApiOkResponse({ description: 'Matched accounts, unmatched identifiers and the total' })
  async preview(@Body() body: unknown): Promise<BulkPreview> {
    const input = (body ?? {}) as { identifiers?: unknown; amount?: unknown };

    return this.coins.preview({
      identifiers: parseIdentifierArray(input.identifiers, COIN_HARD_BULK_CEILING),
      amount: parsePositiveCoins(input.amount),
    });
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
    const input = (body ?? {}) as { userIds?: unknown; amount?: unknown; remark?: unknown; reauth?: unknown };
    const key = parseIdempotencyKey(request.headers['idempotency-key']);
    const meta = requestMeta(request);
    const proof = parseReauthenticationProof(input.reauth);
    const bulk = {
      userIds: parseUserIdArray(input.userIds, COIN_HARD_BULK_CEILING),
      amount: parsePositiveCoins(input.amount),
      remark: parseRemark(input.remark),
    };

    await this.requireStepUp(actor, proof, meta);

    return this.coins.startBulkIdempotent(actor, key, bulk, meta);
  }

  @RequirePermissions('coins.write')
  @Get('bulk/:id')
  @ApiOperation({ summary: 'One bulk assignment and what happened to each person' })
  @ApiOkResponse({ description: 'The job and its rows' })
  async bulkStatus(@Param('id') id: string): Promise<BulkJobView> {
    return this.coins.status(parseUuid(id, 'id'));
  }

  @RequirePermissions('coins.write')
  @Get('bulk/:id/report')
  @Header('content-type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'The bulk report as CSV, with every cell neutralised' })
  @ApiOkResponse({ description: 'A CSV of the job rows' })
  async bulkReport(@Param('id') id: string): Promise<string> {
    const result = await this.coins.report(parseUuid(id, 'id'));
    return result.csv;
  }

  /** A fresh proof verifies and opens the ten-minute window; otherwise a recent one must exist. */
  private async requireStepUp(
    actor: AuthenticatedUser,
    proof: CoinReauthenticationProof | undefined,
    meta: { readonly ip?: string | undefined },
  ): Promise<void> {
    if (proof !== undefined) {
      await this.reauth.assert(actor, proof, meta);
      return;
    }

    await this.reauth.assertFresh(actor);
  }
}

/**
 * The one door the worker knocks on to run a bulk job.
 *
 * The ledger has exactly one writer (`CoinService`), and it lives in this process, so the
 * worker does not write coins itself: it calls this route with `INTERNAL_API_SECRET` and this
 * process runs the batch. The route answers 404 — not 401 — when the secret is wrong, and it
 * accepts only the addresses production names, with a per-address failure counter so a wrong
 * secret cannot be guessed quickly.
 */
@ApiTags('internal')
@Controller('v1/internal/coins')
export class CoinsInternalController {
  constructor(
    @Inject(CoinService) private readonly coins: CoinService,
    @Inject(REDIS_PROBE) private readonly redisService: RedisService,
  ) {}

  @Public()
  @Post('bulk/drain')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run one batch of a queued bulk assignment' })
  async drain(@Req() request: RequestLike, @Body() body: unknown): Promise<BulkBatchResult> {
    const config = loadConfig(process.env);
    const address = requestMeta(request).ip;
    const networks: AllowedAddress[] = config.INTERNAL_ALLOWED_ADDRESSES.map((entry) =>
      parseAllowedAddress(entry),
    ).filter((entry): entry is AllowedAddress => entry !== null);

    if (!addressAllowed(networks, address)) {
      throw new NotFoundException();
    }

    const failuresKey = internalFailureKey(address);
    const failures = Number((await this.redisService.redis.get(failuresKey)) ?? '0');

    if (failures >= INTERNAL_FAILURE_LIMIT) {
      throw new NotFoundException();
    }

    if (!secretMatches(request.headers['x-internal-secret'], config.INTERNAL_API_SECRET)) {
      await this.redisService.redis
        .multi()
        .incr(failuresKey)
        .expire(failuresKey, INTERNAL_FAILURE_WINDOW_SECONDS)
        .exec();
      throw new NotFoundException();
    }

    const input = (body ?? {}) as { jobId?: unknown };
    return this.coins.runBulkJob(parseUuid(input.jobId, 'jobId'));
  }
}
