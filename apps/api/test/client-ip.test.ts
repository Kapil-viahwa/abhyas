import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The client address the per-IP limits are counted by (decision 0052).
 *
 * Two boots of the real API, differing only in whether a proxy is trusted:
 * - no `TRUST_PROXY`: the socket address is the client, so a header that claims twenty-one
 *   different addresses still shares one counter and the cap still trips;
 * - `TRUST_PROXY=127.0.0.1`: the injected socket is the trusted proxy, so the forwarded
 *   address is used and twenty-five different addresses are twenty-five counters.
 *
 * The counters themselves are never changed: the ceiling under test is the production one.
 */

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

async function boot(trustProxy: false | string): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // The same wiring `main.ts` uses, with the policy given directly.
    new FastifyAdapter({ trustProxy }),
    { logger: ['error'] },
  );
  await app.init();
  return app;
}

describe('the client address behind the per-IP limits', () => {
  let db!: TestDatabase;
  let redis!: Redis;
  let untrusted!: NestFastifyApplication;
  let trusted!: NestFastifyApplication;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('clientip');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    redis = new Redis(process.env.REDIS_URL);

    untrusted = await boot(false);
    trusted = await boot('127.0.0.1');
  }, 180_000);

  afterAll(async () => {
    await untrusted?.close();
    await trusted?.close();
    await redis?.quit();
    await db?.dispose();

    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  it('ignores a spoofed X-Forwarded-For: the per-IP cap still trips', async () => {
    await redis.flushdb();
    const statuses: number[] = [];

    for (let index = 0; index < 21; index += 1) {
      const response = await untrusted.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': `203.0.113.${String(index + 1)}` },
        payload: { email: `nobody-${String(index)}@example.com`, password: 'wrong-password-1' },
      });
      statuses.push(response.statusCode);
    }

    // One socket, one counter, however many addresses the header claimed.
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 401));
    expect(statuses[20]).toBe(429);
  }, 60_000);

  it('uses the forwarded address when, and only when, the proxy in front is trusted', async () => {
    await redis.flushdb();
    const statuses: number[] = [];

    for (let index = 0; index < 25; index += 1) {
      const response = await trusted.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-forwarded-for': `198.51.100.${String(index + 1)}` },
        payload: { email: `nobody-${String(index)}@example.com`, password: 'wrong-password-1' },
      });
      statuses.push(response.statusCode);
    }

    // The injected socket is the trusted proxy, so each forwarded address is its own key.
    expect(statuses.filter((code) => code === 429)).toEqual([]);
  }, 60_000);

  it('counts registration by the same resolved address', async () => {
    await redis.flushdb();
    const statuses: number[] = [];
    const stamp = String(Date.now());

    for (let index = 0; index < 6; index += 1) {
      const response = await untrusted.inject({
        method: 'POST',
        url: '/v1/auth/register',
        headers: { 'x-forwarded-for': `198.18.7.${String(index + 1)}` },
        payload: {
          email: `spoof-${stamp}-${String(index)}@example.com`,
          password: 'correct-horse-9battery',
          fullName: 'Spoof Person',
          turnstileToken: 'abhyas-test-turnstile-token',
        },
      });
      statuses.push(response.statusCode);
    }

    // Five an hour per address. Six spoofed addresses, one socket: the sixth is refused.
    expect(statuses.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => 202));
    expect(statuses[5]).toBe(429);
  }, 60_000);
});
