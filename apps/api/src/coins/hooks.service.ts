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
 */
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

  async rewardSafely(userId: string): Promise<void> {
    try {
      await this.coins.payDailyReward(userId);
    } catch (error) {
      await this.record('reward', error);
    }
  }

  private async record(kind: 'grant' | 'reward', error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.name : 'UnknownError';

    try {
      await this.redisService.redis.incr(`coins:${kind}_errors:${businessDate(new Date())}`);
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
