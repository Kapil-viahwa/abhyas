import { describe, expect, it } from 'vitest';

import {
  LOGIN_THROTTLE,
  RATE_LIMITS,
  RateLimiter,
  accountRateLimitKey,
  ipRateLimitKey,
  loginDelayMs,
  loginPairKey,
  type RateLimitStore,
} from './rate-limiter';

/** Fixed-window Redis semantics (INCR / EXPIRE / TTL / GET / DEL) with a controlled clock. */
class FakeStore implements RateLimitStore {
  private readonly counters = new Map<string, number>();
  private readonly expiries = new Map<string, number>();
  private now = 0;

  advance(seconds: number): void {
    this.now += seconds;
    for (const [key, expiresAt] of this.expiries) {
      if (expiresAt <= this.now) {
        this.counters.delete(key);
        this.expiries.delete(key);
      }
    }
  }

  dropExpiry(key: string): void {
    this.expiries.delete(key);
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.counters.has(key)) {
      return 0;
    }
    this.expiries.set(key, this.now + seconds);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const expiresAt = this.expiries.get(key);
    if (expiresAt === undefined) {
      return -1;
    }
    return Math.max(expiresAt - this.now, 0);
  }

  async get(key: string): Promise<number> {
    return this.counters.get(key) ?? 0;
  }

  async del(key: string): Promise<number> {
    const existed = this.counters.delete(key);
    this.expiries.delete(key);
    return existed ? 1 : 0;
  }
}

function limiterWith(store: FakeStore): RateLimiter {
  return new RateLimiter({ redis: store });
}

const rule = { key: 'ratelimit:test:ip:203.0.113.7', limit: 3, windowSeconds: 300 };

describe('rate limiter', () => {
  it('allows exactly the limit and denies the next hit with the time left in the window', async () => {
    const limiter = limiterWith(new FakeStore());

    await expect(limiter.consume(rule)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(limiter.consume(rule)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(limiter.consume(rule)).resolves.toMatchObject({ allowed: true, count: 3 });
    await expect(limiter.consume(rule)).resolves.toMatchObject({
      allowed: false,
      count: 4,
      limit: 3,
      retryAfterSeconds: 300,
    });
  });

  it('counts each key separately', async () => {
    const store = new FakeStore();
    const limiter = limiterWith(store);
    const otherKey = { ...rule, key: 'ratelimit:test:ip:198.51.100.4' };

    for (let hit = 0; hit < 3; hit += 1) {
      await limiter.consume(rule);
    }

    await expect(limiter.consume(rule)).resolves.toMatchObject({ allowed: false });
    await expect(limiter.consume(otherKey)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('starts a fresh window once the window has elapsed', async () => {
    const store = new FakeStore();
    const limiter = limiterWith(store);

    for (let hit = 0; hit < 4; hit += 1) {
      await limiter.consume(rule);
    }
    await expect(limiter.consume(rule)).resolves.toMatchObject({ allowed: false });

    store.advance(300);
    await expect(limiter.consume(rule)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('repairs a key that lost its expiry, so a counter can never block for ever', async () => {
    const store = new FakeStore();
    const limiter = limiterWith(store);

    for (let hit = 0; hit < 4; hit += 1) {
      await limiter.consume(rule);
    }
    store.dropExpiry(rule.key);

    await expect(limiter.consume(rule)).resolves.toMatchObject({
      allowed: false,
      retryAfterSeconds: 300,
    });
    await expect(store.ttl(rule.key)).resolves.toBe(300);
  });

  it('returns the first denial when several rules are consumed together', async () => {
    const store = new FakeStore();
    const limiter = limiterWith(store);
    const ip = { key: ipRateLimitKey('login', '203.0.113.7'), limit: 2, windowSeconds: 300 };
    const account = { key: accountRateLimitKey('login', 'a@example.com'), limit: 5, windowSeconds: 300 };

    await expect(limiter.consumeAll([ip, account])).resolves.toBeNull();
    await expect(limiter.consumeAll([ip, account])).resolves.toBeNull();
    await expect(limiter.consumeAll([ip, account])).resolves.toMatchObject({ allowed: false, key: ip.key });
  });

  it('reads a counter without counting it, and can forget it', async () => {
    const store = new FakeStore();
    const limiter = limiterWith(store);
    const key = loginPairKey('student@example.com', '203.0.113.7');

    await expect(limiter.count(key)).resolves.toBe(0);

    await expect(limiter.hit(key, 900)).resolves.toBe(1);
    await expect(limiter.hit(key, 900)).resolves.toBe(2);
    // Reading never advances the window: the same value twice, the key still 2.
    await expect(limiter.count(key)).resolves.toBe(2);
    await expect(limiter.count(key)).resolves.toBe(2);

    await limiter.reset(key);
    await expect(limiter.count(key)).resolves.toBe(0);
  });

  it('builds one key per IP, one per account, and one per account *and* IP', () => {
    expect(ipRateLimitKey('login', '203.0.113.7')).toBe('ratelimit:login:ip:203.0.113.7');
    expect(ipRateLimitKey('login', '   ')).toBe('ratelimit:login:ip:unknown');

    const accountKey = accountRateLimitKey('login', 'Student@Example.com');
    expect(accountKey.startsWith('ratelimit:login:account:')).toBe(true);
    expect(accountKey).not.toContain('student@example.com');
    expect(accountRateLimitKey('login', ' student@example.com ')).toBe(accountKey);

    const pairKey = loginPairKey('Student@Example.com', '203.0.113.7');
    expect(pairKey.startsWith('ratelimit:login:pair:')).toBe(true);
    expect(pairKey).not.toContain('student@example.com');
    expect(loginPairKey(' student@example.com ', '203.0.113.7')).toBe(pairKey);
    // The same account reached from another address is a different counter: that is
    // what stops one host's guessing from affecting everybody else.
    expect(loginPairKey('student@example.com', '198.51.100.4')).not.toBe(pairKey);
  });

  it('grows the sign-in delay with the failure count and caps it', () => {
    expect(loginDelayMs(0)).toBe(0);
    expect(loginDelayMs(1)).toBe(100);
    expect(loginDelayMs(2)).toBe(200);
    expect(loginDelayMs(3)).toBe(400);
    expect(loginDelayMs(4)).toBe(800);
    expect(loginDelayMs(5)).toBe(LOGIN_THROTTLE.delayCapMs);
    expect(loginDelayMs(50)).toBe(LOGIN_THROTTLE.delayCapMs);
  });

  it('keeps the per-address sign-in ceiling tighter than the per-IP one', () => {
    expect(RATE_LIMITS.loginPair.limit).toBeLessThan(RATE_LIMITS.loginPerIp.limit);
    expect(RATE_LIMITS.loginPair.windowSeconds).toBe(900);
    // The account-wide ceiling must be reachable before the per-address refusal, or
    // the challenge would never be asked for.
    expect(LOGIN_THROTTLE.accountChallengeThreshold).toBeLessThan(RATE_LIMITS.loginPair.limit);
  });
});
