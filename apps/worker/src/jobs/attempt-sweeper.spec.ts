import { describe, expect, it } from 'vitest';

import {
  ATTEMPT_SWEEP_BATCH_SIZE,
  ATTEMPT_SWEEP_MAX_ROUNDS,
  sweepExpiredAttempts,
  type AttemptSweepDeps,
} from './attempt-sweeper';

/**
 * The sweeper's loop, proven without Redis, Postgres or an HTTP server: what it asks for, how
 * it sums a capped run, and how it fails without crashing the worker.
 */

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function depsWith(
  responses: Array<() => Promise<Response>>,
  logs: string[] = [],
): { deps: AttemptSweepDeps; calls: Call[]; logs: string[] } {
  const calls: Call[] = [];
  let index = 0;

  return {
    calls,
    logs,
    deps: {
      apiUrl: 'http://api:3001',
      secret: 'internal-secret',
      log: (message) => {
        logs.push(message);
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = responses[index];
        index += 1;
        if (next === undefined) {
          throw new Error('the test ran out of responses');
        }
        return next();
      }) as typeof fetch,
    },
  };
}

function json(body: unknown, status = 200): () => Promise<Response> {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('the attempt expiry sweeper', () => {
  it('asks the API once for a partial batch and stops', async () => {
    const { deps, calls, logs } = depsWith([json({ finalized: 2, skipped: 1, failed: 0 })]);

    const result = await sweepExpiredAttempts(deps);

    expect(result).toEqual({ rounds: 1, finalized: 2, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://api:3001/v1/internal/attempts/expire-expired');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['x-internal-secret']).toBe('internal-secret');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ batchSize: ATTEMPT_SWEEP_BATCH_SIZE }));
    expect(logs.at(-1)).toMatch(/2 expired swept/);
  });

  it('runs again while the API answers a full batch, and stops at the cap', async () => {
    const full = json({ finalized: ATTEMPT_SWEEP_BATCH_SIZE, skipped: 0, failed: 0 });
    const { deps, calls } = depsWith(Array.from({ length: ATTEMPT_SWEEP_MAX_ROUNDS + 2 }, () => full));

    const result = await sweepExpiredAttempts(deps);

    expect(calls).toHaveLength(ATTEMPT_SWEEP_MAX_ROUNDS);
    expect(result.rounds).toBe(ATTEMPT_SWEEP_MAX_ROUNDS);
    expect(result.finalized).toBe(ATTEMPT_SWEEP_BATCH_SIZE * ATTEMPT_SWEEP_MAX_ROUNDS);
  });

  it('stops after a full batch followed by a partial one, summing both', async () => {
    const { deps, calls } = depsWith([
      json({ finalized: ATTEMPT_SWEEP_BATCH_SIZE, skipped: 0, failed: 0 }),
      json({ finalized: 3, skipped: 1, failed: 2 }),
    ]);

    const result = await sweepExpiredAttempts(deps);

    expect(calls).toHaveLength(2);
    expect(result).toEqual({ rounds: 2, finalized: ATTEMPT_SWEEP_BATCH_SIZE + 3, skipped: 1, failed: 2 });
  });

  it('logs an unreachable API and returns without throwing', async () => {
    const { deps, calls, logs } = depsWith([
      async () => {
        throw new Error('connect ECONNREFUSED');
      },
    ]);

    const result = await sweepExpiredAttempts(deps);

    expect(result).toEqual({ rounds: 0, finalized: 0, skipped: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(logs[0]).toMatch(/could not reach the API/);
  });

  it('logs a non-200 answer and returns without throwing', async () => {
    const { deps, logs } = depsWith([json({}, 404)]);

    const result = await sweepExpiredAttempts(deps);

    expect(result.rounds).toBe(0);
    expect(logs[0]).toMatch(/answered 404/);
  });

  it('treats a body that is not JSON as a failure of that round', async () => {
    const { deps, logs } = depsWith([async () => new Response('<html>no</html>', { status: 200 })]);

    const result = await sweepExpiredAttempts(deps);

    expect(result.rounds).toBe(0);
    expect(logs[0]).toMatch(/not JSON/);
  });

  it('ignores a body whose counts are not numbers', async () => {
    const { deps } = depsWith([json({ finalized: 'lots', skipped: null, failed: -1 })]);

    const result = await sweepExpiredAttempts(deps);

    // No usable numbers means an empty partial batch: one round, nothing counted.
    expect(result).toEqual({ rounds: 1, finalized: 0, skipped: 0, failed: 0 });
  });
});
