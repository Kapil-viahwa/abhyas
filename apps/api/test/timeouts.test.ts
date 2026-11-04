import { connect } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_TIMEOUTS, createApiApplication } from '../src/bootstrap';
import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The socket timeouts are set, and they actually close a stalled connection (decision 0059).
 *
 * Node has no default connection or request timeout, so a socket that opens and says nothing
 * holds a server slot until something else gives up — a slow-loris lever behind Nginx. The
 * first test pins the values the decision records; the second boots with a short
 * `connectionTimeout` (the test-only override the bootstrap accepts for exactly this) and
 * proves a silent connection is closed rather than left open.
 */
describe('the API socket timeouts', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let port = 0;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('timeouts');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

    const created = await createApiApplication({ logger: ['error'], timeouts: { connectionTimeoutMs: 300 } });
    app = created.app;
    await app.listen(0, '127.0.0.1');
    port = Number(new URL(await app.getUrl()).port);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.dispose();
  }, 60_000);

  it('records the values decision 0059 chose', () => {
    expect(API_TIMEOUTS).toEqual({
      connectionTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      keepAliveTimeoutMs: 72_000,
    });
  });

  it('closes a connection that never sends a request', async () => {
    const socket = connect({ host: '127.0.0.1', port });

    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    // Say nothing at all: the connection timeout is what has to end it.
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 5_000);

      socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    expect(closed).toBe(true);
  }, 20_000);
});
