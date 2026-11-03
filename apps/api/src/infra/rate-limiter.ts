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

/** The counting operations the window logic needs, independent of the client. */
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  get(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

/**
 * The subset of the Redis client the limiter uses. `get` returns whatever the client
 * hands back — a string from Redis, or a number from the in-memory fake used in the
 * unit tests — and the adapter below turns either into a count.
 */
export interface RedisClientHost {
  readonly redis: {
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    ttl(key: string): Promise<number>;
    get(key: string): Promise<string | number | null>;
    del(key: string): Promise<number>;
  };
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
  /** One host may not spray many accounts. Per IP only, so it never locks an account. */
  loginPerIp: { limit: 20, windowSeconds: 300 },
  /**
   * One host guessing one account. Refused at this ceiling, which costs that address
   * nothing else: another address for the same account is a different key.
   */
  loginPair: { limit: 10, windowSeconds: 900 },
  registerPerIp: { limit: 5, windowSeconds: 3600 },
  passwordResetPerIp: { limit: 5, windowSeconds: 3600 },
  passwordResetPerAccount: { limit: 3, windowSeconds: 3600 },
  passwordResetSubmitPerIp: { limit: 10, windowSeconds: 900 },
  refreshPerIp: { limit: 60, windowSeconds: 300 },
  /**
   * Question images per editor. Uploading is the only route that runs a native decoder, so
   * it is metered per account: a burst is slowed rather than allowed to fill the queue.
   */
  mediaUploadPerUser: { limit: 30, windowSeconds: 600 },
} as const;

/**
 * Sign-in throttling is three separate mechanisms, deliberately not one counter:
 *
 * 1. A per-address delay. Guessers pay for their own guessing.
 * 2. A per-address ceiling (RATE_LIMITS.loginPair): that address stops guessing.
 * 3. A per-account ceiling, much higher, that asks for a fresh human check instead of
 *    refusing. Never a lock: the owner can always sign in by passing the challenge,
 *    so an attacker holding the account name cannot turn a counter into a denial of
 *    service.
 */
export const LOGIN_THROTTLE = {
  accountChallengeThreshold: 5,
  accountWindowSeconds: 900,
  delayBaseMs: 100,
  delayCapMs: 800,
} as const;

/** One key per IP, so a single host cannot hammer an endpoint. */
export function ipRateLimitKey(scope: string, ip: string): string {
  const value = ip.trim();
  return `ratelimit:${scope}:ip:${value === '' ? 'unknown' : value}`;
}

/** One key per account, hashed: an email address must never sit in a Redis key in
 * clear text. Lower-cased for the same reason emails are normalised. */
export function accountRateLimitKey(scope: string, account: string): string {
  return `ratelimit:${scope}:account:${hashToken(account.trim().toLowerCase())}`;
}

/** One key per user id, for a route metered by the account that is signed in. */
export function userRateLimitKey(scope: string, userId: string): string {
  return `ratelimit:${scope}:user:${userId}`;
}

/** One key per address *and* account, so a guesser is slowed without touching anyone else. */
export function loginPairKey(email: string, ip: string): string {
  const host = ip.trim() === '' ? 'unknown' : ip.trim();
  return `ratelimit:login:pair:${hashToken(email.trim().toLowerCase())}:${host}`;
}

/**
 * How long a sign-in attempt is delayed after N failures from the same address and
 * account: 0, 100 ms, 200 ms, 400 ms, 800 ms, then capped. Slow enough to make
 * guessing expensive, small enough that a person who mistyped twice barely notices.
 */
export function loginDelayMs(failures: number): number {
  if (failures <= 0) {
    return 0;
  }

  const exponent = Math.min(failures - 1, 20);
  return Math.min(LOGIN_THROTTLE.delayBaseMs * 2 ** exponent, LOGIN_THROTTLE.delayCapMs);
}

@Injectable()
export class RateLimiter {
  private readonly store: RateLimitStore;

  constructor(@Inject(REDIS_PROBE) redis: RedisClientHost) {
    const client = redis.redis;
    this.store = {
      incr: (key) => client.incr(key),
      expire: (key, seconds) => client.expire(key, seconds),
      ttl: (key) => client.ttl(key),
      get: async (key) => {
        const raw = await client.get(key);
        return raw === null ? 0 : Number(raw);
      },
      del: (key) => client.del(key),
    };
  }

  /** Counts one hit and starts the window on the first one. Returns the new count. */
  async hit(key: string, windowSeconds: number): Promise<number> {
    const count = await this.store.incr(key);

    if (count === 1) {
      await this.store.expire(key, windowSeconds);
    }

    return count;
  }

  /** Reads a counter without counting, so a decision can be made before an attempt. */
  async count(key: string): Promise<number> {
    return this.store.get(key);
  }

  /** Forgets a counter: a successful sign-in ends the failures that came before it. */
  async reset(key: string): Promise<void> {
    await this.store.del(key);
  }

  async consume(rule: RateLimitRule): Promise<RateLimitDecision> {
    const count = await this.hit(rule.key, rule.windowSeconds);

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
