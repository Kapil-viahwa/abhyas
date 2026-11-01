import { Inject, Injectable } from '@nestjs/common';

import { hashToken } from '../auth/tokens';
import { REDIS_PROBE } from './tokens';

/**
 * Fixed-window rate limiting on Redis, shared by every auth endpoint.
 *
 * A window is `INCR` on the key plus `EXPIRE` on the first hit: one round trip in
 * the common case, no Lua script to get wrong, and a counter that can never block
 * for ever because a key found without a TTL is repaired on the spot.
 *
 * The store is a narrow interface rather than the Redis client itself, so the
 * window logic is unit tested against a fake with a controllable clock.
 */
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
}

export interface RedisClientHost {
  readonly redis: RateLimitStore;
}

export interface RateLimitRule {
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly key: string;
  readonly count: number;
  readonly limit: number;
  /** Seconds until the window resets; 0 when the request is allowed. */
  readonly retryAfterSeconds: number;
}

export const RATE_LIMITS = {
  loginPerIp: { limit: 20, windowSeconds: 300 },
  loginPerAccount: { limit: 5, windowSeconds: 300 },
  registerPerIp: { limit: 5, windowSeconds: 3600 },
  passwordResetPerIp: { limit: 5, windowSeconds: 3600 },
  passwordResetPerAccount: { limit: 3, windowSeconds: 3600 },
} as const;

/** One key per IP, so a single host cannot hammer an endpoint. */
export function ipRateLimitKey(scope: string, ip: string): string {
  const value = ip.trim();
  return `ratelimit:${scope}:ip:${value === '' ? 'unknown' : value}`;
}

/**
 * One key per account, hashed: an email address must never sit in a Redis key in
 * clear text. Lower-cased for the same reason emails are normalised.
 */
export function accountRateLimitKey(scope: string, account: string): string {
  return `ratelimit:${scope}:account:${hashToken(account.trim().toLowerCase())}`;
}

@Injectable()
export class RateLimiter {
  private readonly store: RateLimitStore;

  constructor(@Inject(REDIS_PROBE) redis: RedisClientHost) {
    this.store = redis.redis;
  }

  async consume(rule: RateLimitRule): Promise<RateLimitDecision> {
    const count = await this.store.incr(rule.key);

    if (count === 1) {
      await this.store.expire(rule.key, rule.windowSeconds);
    }

    if (count <= rule.limit) {
      return { allowed: true, key: rule.key, count, limit: rule.limit, retryAfterSeconds: 0 };
    }

    let ttl = await this.store.ttl(rule.key);
    if (ttl < 0) {
      // The key lost its expiry (a crashed process between INCR and EXPIRE).
      // Repair it: a counter without a TTL would block that key for ever.
      await this.store.expire(rule.key, rule.windowSeconds);
      ttl = rule.windowSeconds;
    }

    return { allowed: false, key: rule.key, count, limit: rule.limit, retryAfterSeconds: ttl };
  }

  /** Consumes every rule and returns the first denial, if any. */
  async consumeAll(rules: readonly RateLimitRule[]): Promise<RateLimitDecision | null> {
    let denial: RateLimitDecision | null = null;

    for (const rule of rules) {
      const decision = await this.consume(rule);
      if (!decision.allowed && denial === null) {
        denial = decision;
      }
    }

    return denial;
  }
}
