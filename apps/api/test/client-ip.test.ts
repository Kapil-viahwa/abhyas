import { isIP } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApiApplication } from '../src/bootstrap';
import { RedisService } from '../src/infra/redis.service';
import { REDIS_PROBE } from '../src/infra/tokens';
import { TURNSTILE_TEST_TOKEN } from '../src/infra/turnstile-verifier';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The client address the per-IP limits are counted by (decision 0052).
 *
 * Two boots of the real API, through the same bootstrap `main.ts` uses, differing only in
 * whether a proxy is trusted:
 * - no `TRUST_PROXY`: the socket address is the client, so a header that claims twenty-one
 *   different addresses still shares one counter and the cap still trips;
 * - `TRUST_PROXY=1`: the injected socket is the trusted proxy, so the entry the proxy wrote
 *   is the client, a left-prepended fake address is ignored, and an address the attacker
 *   names cannot become a bucket of its own.
 *
 * OTP is on for this file, because its request and verify routes must resolve the address
 * the same way. The counters themselves are never changed: the ceilings under test are the
 * production ones.
 */

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

async function waitForRedis(app: NestFastifyApplication): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await app.get<RedisService>(REDIS_PROBE).ping();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('the API Redis connection did not become ready');
}

async function boot(): Promise<NestFastifyApplication> {
  const { app } = await createApiApplication({ logger: ['error'] });
  await app.init();
  await waitForRedis(app);
  return app;
}

type Injection = Parameters<NestFastifyApplication['inject']>[0];

function login(name: string, forwardedFor: string): Injection {
  return {
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-forwarded-for': forwardedFor },
    payload: { email: `${name}@example.com`, password: 'wrong-password-1' },
  };
}

describe('the client address behind the per-IP limits', () => {
  let db!: TestDatabase;
  let redis!: Redis;
  let untrusted!: NestFastifyApplication;
  let trusted!: NestFastifyApplication;

  let counter = 0;

  /** A fresh Indian number per request, so a per-number limit never masks a per-IP one. */
  function nextNumber(): string {
    counter += 1;
    return `+9198${String(counter).padStart(8, '0')}`;
  }

  beforeAll(async () => {
    db = await createMigratedTestDatabase('clientip');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.OTP_ENABLED = 'true';
    process.env.OTP_HMAC_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
    process.env.OTP_TEMPLATE_ID = 'TPL-TEST';
    process.env.OTP_ALLOWED_COUNTRY_CODES = '+91';
    process.env.SMS_PROVIDER = 'fake';

    redis = new Redis(process.env.REDIS_URL);

    delete process.env.TRUST_PROXY;
    untrusted = await boot();

    // The injected socket is now the proxy, so the entry it forwards is read.
    process.env.TRUST_PROXY = '1';
    trusted = await boot();
    delete process.env.TRUST_PROXY;
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
      const response = await untrusted.inject(login(`nobody-${String(index)}`, `203.0.113.${String(index + 1)}`));
      statuses.push(response.statusCode);
    }

    // One socket, one counter, however many addresses the header claimed.
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 401));
    expect(statuses[20]).toBe(429);
  }, 60_000);

  it('counts one forwarded address once, and a different one separately', async () => {
    await redis.flushdb();
    const statuses: number[] = [];

    for (let index = 0; index < 21; index += 1) {
      const response = await trusted.inject(login(`same-${String(index)}`, '198.51.100.7'));
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 401));
    expect(statuses[20]).toBe(429);

    // Another address the trusted proxy forwarded is a different bucket, not a refusal.
    const other = await trusted.inject(login('newcomer', '198.51.100.8'));
    expect(other.statusCode).toBe(401);
  }, 60_000);

  it('resolves a multi-hop chain to the entry the trusted proxy wrote', async () => {
    await redis.flushdb();

    // The browser prepended 1.1.1.1; the proxy's own entry is the one that counts.
    const response = await trusted.inject(login('chain', '1.1.1.1, 198.51.100.7'));
    expect(response.statusCode).toBe(401);

    const row = await db.client.auditLog.findFirst({
      where: { action: 'IDENTITY_LOGIN_FAILED' },
      orderBy: { createdAt: 'desc' },
      select: { ip: true },
    });

    expect(row?.ip).toBe('198.51.100.7');
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
          turnstileToken: TURNSTILE_TEST_TOKEN,
        },
      });
      statuses.push(response.statusCode);
    }

    // Five an hour per address. Six spoofed addresses, one socket: the sixth is refused.
    expect(statuses.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => 202));
    expect(statuses[5]).toBe(429);
  }, 60_000);

  it('never stores a header value that is not an address', async () => {
    await redis.flushdb();

    const junk = [
      'not-an-ip',
      '<script>alert(1)</script>',
      '=HYPERLINK("http://example.com")',
      '203.0.113.9\n1.1.1.1',
      '999.999.999.999',
      'f'.repeat(4000),
    ];

    for (const [index, value] of junk.entries()) {
      const response = await trusted.inject(login(`junk-${String(index)}`, value));
      expect([400, 401, 429]).toContain(response.statusCode);
    }

    const rows = await db.client.auditLog.findMany({
      where: { action: 'IDENTITY_LOGIN_FAILED' },
      select: { ip: true },
    });
    const stored = rows.map((row) => row.ip).filter((ip): ip is string => ip !== null);

    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every((ip) => isIP(ip) !== 0)).toBe(true);

    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain('script');
    expect(serialised).not.toContain('HYPERLINK');
  }, 60_000);

  it('resolves the OTP request and verify routes to the same client address', async () => {
    await redis.flushdb();

    // Ten codes for ten numbers from one forwarded address: the eleventh is refused.
    const requestStatuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await trusted.inject({
        method: 'POST',
        url: '/v1/auth/otp',
        headers: { 'x-forwarded-for': '203.0.113.77' },
        payload: { destination: nextNumber(), purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
      });
      requestStatuses.push(response.statusCode);
    }

    expect(requestStatuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 202));
    expect(requestStatuses[10]).toBe(429);

    const otherRequest = await trusted.inject({
      method: 'POST',
      url: '/v1/auth/otp',
      headers: { 'x-forwarded-for': '203.0.113.79' },
      payload: { destination: nextNumber(), purpose: 'LOGIN', turnstileToken: TURNSTILE_TEST_TOKEN },
    });
    expect(otherRequest.statusCode).toBe(202);

    // Twenty guessed codes from another address: the twenty-first is refused, and a fresh
    // address is not. The verify route therefore keys on the same resolved address.
    const verifyStatuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await trusted.inject({
        method: 'POST',
        url: '/v1/auth/mobile/login',
        headers: { 'x-forwarded-for': '203.0.113.78' },
        payload: { destination: nextNumber(), code: '000000' },
      });
      verifyStatuses.push(response.statusCode);
    }

    expect(verifyStatuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 400));
    expect(verifyStatuses[20]).toBe(429);

    const otherVerify = await trusted.inject({
      method: 'POST',
      url: '/v1/auth/mobile/login',
      headers: { 'x-forwarded-for': '203.0.113.80' },
      payload: { destination: nextNumber(), code: '000000' },
    });
    expect(otherVerify.statusCode).toBe(400);

    // And the audit trail names the resolved address, not the raw header.
    const requested = await db.client.auditLog.findFirst({
      where: { action: 'OTP_REQUESTED' },
      orderBy: { createdAt: 'desc' },
      select: { ip: true },
    });
    expect(requested?.ip).toBe('203.0.113.79');
  }, 120_000);
});
