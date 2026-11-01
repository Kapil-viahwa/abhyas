import { describe, expect, it } from 'vitest';

import { RATE_LIMITS, RateLimiter, type RateLimitStore, accountRateLimitKey, ipRateLimitKey } from './rate-limiter';

/** Fixed-window Redis semantics (INCR / EXPIRE / TTL) with a clock the test controls. */
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

  it('builds one key per IP and one per account, with the account hashed', () => {
    expect(ipRateLimitKey('login', '203.0.113.7')).toBe('ratelimit:login:ip:203.0.113.7');
    expect(ipRateLimitKey('login', '   ')).toBe('ratelimit:login:ip:unknown');

    const key = accountRateLimitKey('login', 'Student@Example.com');
    expect(key.startsWith('ratelimit:login:account:')).toBe(true);
    expect(key).not.toContain('student@example.com');
    expect(accountRateLimitKey('login', ' student@example.com ')).toBe(key);
  });

  it('keeps the login limit tight per account and looser per IP', () => {
    expect(RATE_LIMITS.loginPerAccount.limit).toBeLessThan(RATE_LIMITS.loginPerIp.limit);
    expect(RATE_LIMITS.loginPerAccount.windowSeconds).toBe(300);
  });
});
