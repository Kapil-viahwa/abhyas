import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/access';
import type { RequestLike } from '../auth/request';
import { assertInternalRequest } from '../infra/internal-request';
import { RedisService } from '../infra/redis.service';
import { REDIS_PROBE } from '../infra/tokens';
import { AttemptsService, type AttemptSweepResult } from './attempts.service';
import { parseSweepBody } from './attempts.validation';

/**
 * The one door the worker knocks on to end attempts whose deadline has passed.
 *
 * Guarded exactly like the bulk-coin drain: `INTERNAL_API_SECRET`, the
 * `INTERNAL_ALLOWED_ADDRESSES` allowlist and a per-address failure counter, through the same
 * `assertInternalRequest`. It is `@Public` so no user session can reach it by being signed in,
 * it answers 404 to every wrong caller, and it never appears on a student route. The work
 * itself is `AttemptsService.expireExpiredAttempts`, which finalises every attempt through the
 * same code the lazy reads use.
 */
@ApiTags('internal')
@Controller('v1/internal/attempts')
export class AttemptsInternalController {
  constructor(
    @Inject(AttemptsService) private readonly attempts: AttemptsService,
    @Inject(REDIS_PROBE) private readonly redisService: RedisService,
  ) {}

  @Public()
  @Post('expire-expired')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finalise one bounded batch of expired attempts' })
  @ApiOkResponse({ description: 'Counts only: finalized, skipped, failed' })
  async expire(@Req() request: RequestLike, @Body() body: unknown): Promise<AttemptSweepResult> {
    await assertInternalRequest(request, this.redisService);

    return this.attempts.expireExpiredAttempts(parseSweepBody(body));
  }
}
