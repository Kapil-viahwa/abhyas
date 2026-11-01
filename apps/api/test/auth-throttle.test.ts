import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { RATE_LIMITS, accountRateLimitKey, loginPairKey } from '../src/infra/rate-limiter';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The sign-in throttle, over HTTP, against the real Redis.
 *
 * The rule these tests exist for: a guesser must not be able to lock the owner out.
 * The highest counter asks for a human check, the per-address counter only stops the
 * address that is guessing, and the owner always has a way in.
 */

const PASSWORD = 'correct-horse-9battery';

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

async function waitUntilHealthy(target: NestFastifyApplication, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';

  while (Date.now() < deadline) {
    const response = await target.inject({ method: 'GET', url: '/health' });
    if (response.statusCode === 200) {
      return;
    }
    last = `${response.statusCode} ${response.body}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The API never became healthy: ${last}`);
}

describe('login throttling over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('throttle');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitUntilHealthy(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await db?.dispose();

    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  async function makeUser(email: string): Promise<string> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Throttle Target',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    return user.id;
  }

  function attempt(email: string, password: string, ip: string, turnstileToken?: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: turnstileToken === undefined ? { email, password } : { email, password, turnstileToken },
      remoteAddress: ip,
    });
  }

  it(
    'refuses the guessing address and asks the account for a human check, never locking the owner out',
    async () => {
      await redis.flushdb();
      const email = `lockout-${randomUUID().slice(0, 8)}@example.com`;
      await makeUser(email);

      const attacker = '203.0.113.201';
      const statuses: number[] = [];
      for (let attemptNumber = 0; attemptNumber < 12; attemptNumber += 1) {
        const response = await attempt(email, `wrong-password-9x-${attemptNumber}`, attacker);
        statuses.push(response.statusCode);
      }

      // The attacker's own address + account pair is refused at its ceiling...
      expect(statuses.slice(0, RATE_LIMITS.loginPair.limit)).toEqual(
        Array.from({ length: RATE_LIMITS.loginPair.limit }, () => 401),
      );
      expect(statuses[RATE_LIMITS.loginPair.limit]).toBe(429);
      expect(statuses.at(-1)).toBe(429);

      // ...and the account itself asked for a human check rather than a lock.
      const ownerAddress = '198.51.100.201';
      const withoutChallenge = await attempt(email, PASSWORD, ownerAddress);
      expect(withoutChallenge.statusCode).toBe(401);
      expect(withoutChallenge.json().challengeRequired).toBe(true);

      // The owner, from their own address with the challenge solved, is in.
      const signedIn = await attempt(email, PASSWORD, ownerAddress, TURNSTILE_TEST_TOKEN);
      expect(signedIn.statusCode).toBe(200);
      expect(signedIn.json().user.email).toBe(email);
    },
    90_000,
  );

  it('counts one account at a time, so a guesser cannot lock out a different person', async () => {
    await redis.flushdb();
    const attacked = `attacked-${randomUUID().slice(0, 8)}@example.com`;
    const bystander = `bystander-${randomUUID().slice(0, 8)}@example.com`;
    await makeUser(attacked);
    await makeUser(bystander);

    const attacker = '203.0.113.202';
    for (let attemptNumber = 0; attemptNumber < 6; attemptNumber += 1) {
      const response = await attempt(attacked, `wrong-password-9x-${attemptNumber}`, attacker);
      expect(response.statusCode).toBe(401);
    }

    // A different account, even from the attacker's own address, is unaffected.
    const response = await attempt(bystander, PASSWORD, attacker);
    expect(response.statusCode).toBe(200);
  }, 60_000);

  it('forgets the failures once the owner signs in successfully', async () => {
    await redis.flushdb();
    const email = `reset-${randomUUID().slice(0, 8)}@example.com`;
    await makeUser(email);

    const address = '203.0.113.203';
    const pairKey = loginPairKey(email, address);
    const accountKey = accountRateLimitKey('login', email);

    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
      const response = await attempt(email, 'wrong-password-9x', address);
      expect(response.statusCode).toBe(401);
    }

    expect(await redis.get(pairKey)).toBe('2');
    expect(await redis.get(accountKey)).toBe('2');

    const signedIn = await attempt(email, PASSWORD, address);
    expect(signedIn.statusCode).toBe(200);

    // Both counters are gone, so a typo after a successful sign-in starts from zero.
    expect(await redis.get(pairKey)).toBeNull();
    expect(await redis.get(accountKey)).toBeNull();
  }, 60_000);
});
