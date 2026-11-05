import { describe, expect, it } from 'vitest';

import type { DatabaseService } from '../infra/database.service';
import type { RedisService } from '../infra/redis.service';
import type { CoinService } from './coin.service';
import { CoinsHooksService, ERROR_COUNTER_TTL_SECONDS, REWARD_TIMEOUT_MS } from './hooks.service';

interface Recorded {
  readonly key: string;
  readonly ttl?: number;
}

function fakes(options: {
  readonly reward: () => Promise<unknown>;
  readonly grant: () => Promise<unknown>;
}): {
  readonly hooks: CoinsHooksService;
  readonly counters: Recorded[];
  readonly audits: Array<Record<string, unknown>>;
} {
  const counters: Recorded[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const redis = {
    multi: () => {
      const entry: { key: string; ttl?: number } = { key: '' };
      const chain = {
        incr: (key: string) => {
          entry.key = key;
          return chain;
        },
        expire: (key: string, ttl: number) => {
          entry.key = key;
          entry.ttl = ttl;
          counters.push(entry);
          return chain;
        },
        exec: async () => [],
      };
      return chain;
    },
  };

  const database = { prisma: { auditLog: { create: async (args: { data: Record<string, unknown> }) => audits.push(args.data) } } };
  const coins = { payDailyReward: options.reward, grantSignupCoins: options.grant };

  return {
    hooks: new CoinsHooksService(
      database as unknown as DatabaseService,
      { redis } as unknown as RedisService,
      coins as unknown as CoinService,
    ),
    counters,
    audits,
  };
}

describe('the coin hooks', () => {
  it('bounds a reward that never finishes, and counts it without personal data', async () => {
    const { hooks, counters, audits } = fakes({ reward: () => new Promise(() => undefined), grant: async () => undefined });

    const started = Date.now();
    await hooks.rewardSafely('a-user-id', 10);

    expect(Date.now() - started).toBeLessThan(REWARD_TIMEOUT_MS);
    expect(counters).toHaveLength(1);
    expect(counters[0]!.key).toMatch(/^coins:reward_errors:\d{4}-\d{2}-\d{2}$/);
    expect(counters[0]!.ttl).toBe(ERROR_COUNTER_TTL_SECONDS);
    expect(audits[0]!.metadata).toEqual({ kind: 'reward', reason: 'Error' });
    expect(JSON.stringify(audits[0])).not.toContain('a-user-id');
  });

  it('counts a failed grant with a thirty-day expiry and lets the flow continue', async () => {
    const { hooks, counters, audits } = fakes({
      reward: async () => undefined,
      grant: async () => {
        throw new TypeError('the database was busy');
      },
    });

    await expect(hooks.grantSafely('a-user-id')).resolves.toBeUndefined();

    expect(counters[0]!.key).toMatch(/^coins:grant_errors:\d{4}-\d{2}-\d{2}$/);
    expect(counters[0]!.ttl).toBe(ERROR_COUNTER_TTL_SECONDS);
    expect(audits[0]!.metadata).toEqual({ kind: 'grant', reason: 'TypeError' });
  });

  it('writes nothing when the reward is paid', async () => {
    let paid = 0;
    const { hooks, counters, audits } = fakes({
      reward: async () => {
        paid += 1;
      },
      grant: async () => undefined,
    });

    await hooks.rewardSafely('a-user-id');

    expect(paid).toBe(1);
    expect(counters).toEqual([]);
    expect(audits).toEqual([]);
  });
});
