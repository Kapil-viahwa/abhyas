import { Inject, Injectable, Logger } from '@nestjs/common';

import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { RedisService } from '../infra/redis.service';
import { DATABASE_PROBE, REDIS_PROBE } from '../infra/tokens';
import { businessDate } from '../otp/otp-code';
import { CoinService } from './coin.service';

/**
 * The one place a flow calls the coin rules, and the place that makes sure it cannot fail.
 *
 * A sign-in must succeed because the password was right, not because a reward was paid; a
 * verification must succeed because the link was valid. So each call catches everything,
 * counts it, and records an audit row — with the kind and the error class only. An address,
 * a number or an id would turn a diagnostic counter into personal data, and it is not what
 * an operator needs to see a trend.
 *
 * The reward is also bounded: sign-in is somebody waiting, so the reward may finish in the
 * background after two seconds rather than hold the response open (item 3b).
 */
export const REWARD_TIMEOUT_MS = 2000;

/** A counter nobody reads for a month is still worth keeping for a month, and not longer. */
export const ERROR_COUNTER_TTL_SECONDS = 30 * 24 * 60 * 60;

@Injectable()
export class CoinsHooksService {
  private readonly logger = new Logger(CoinsHooksService.name);

  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(REDIS_PROBE) private readonly redisService: RedisService,
    @Inject(CoinService) private readonly coins: CoinService,
  ) {}

  async grantSafely(userId: string): Promise<void> {
    try {
      await this.coins.grantSignupCoins(userId);
    } catch (error) {
      await this.record('grant', error);
    }
  }

  async rewardSafely(userId: string, timeoutMs = REWARD_TIMEOUT_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        this.coins.payDailyReward(userId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('CoinRewardTimeout')), timeoutMs);
          // The timer must not hold the process open if this was the only thing left.
          timer.unref();
        }),
      ]);
    } catch (error) {
      await this.record('reward', error);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async record(kind: 'grant' | 'reward', error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.name : 'UnknownError';

    try {
      const key = `coins:${kind}_errors:${businessDate(new Date())}`;
      await this.redisService.redis.multi().incr(key).expire(key, ERROR_COUNTER_TTL_SECONDS).exec();
    } catch (counterError) {
      this.logger.warn(`The coin ${kind} error counter could not be written: ${String(counterError)}`);
    }

    try {
      await writeIdentityAudit(this.database.prisma, {
        action: 'COIN_REWARD_ERROR',
        entityType: 'coin',
        metadata: { kind, reason },
      });
    } catch (auditError) {
      this.logger.warn(`The coin ${kind} error could not be audited: ${String(auditError)}`);
    }

    this.logger.warn(`The coin ${kind} did not run (${reason}); the flow it belongs to continued`);
  }
}
