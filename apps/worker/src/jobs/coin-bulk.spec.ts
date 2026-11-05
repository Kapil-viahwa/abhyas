import { describe, expect, it } from 'vitest';

import {
  COIN_BULK_MAX_CONSECUTIVE_FAILURES,
  COIN_BULK_MAX_ROUNDS,
  drainCoinBulkJobs,
  type CoinBulkFailureCounter,
} from './coin-bulk';

function failureCounter(): { readonly failures: CoinBulkFailureCounter; readonly counts: Map<string, number> } {
  const counts = new Map<string, number>();

  return {
    counts,
    failures: {
      bump: async (jobId) => {
        const next = (counts.get(jobId) ?? 0) + 1;
        counts.set(jobId, next);
        return next;
      },
      clear: async (jobId) => {
        counts.delete(jobId);
      },
    },
  };
}

describe('the bulk coin drain', () => {
  it('sends its own secret and asks again until the job reports none left', async () => {
    const secrets: string[] = [];
    const bodies: string[] = [];
    const remaining = [3, 2, 1, 0];
    const counter = failureCounter();

    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => ['job-1'], markFailed: async () => undefined },
      failures: counter.failures,
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: () => undefined,
      fetchImpl: async (input, init) => {
        secrets.push(String((init?.headers as Record<string, string>)['x-internal-secret']));
        bodies.push(String(init?.body ?? ''));
        expect(String(input)).toBe('http://api:3001/v1/internal/coins/bulk/drain');
        const left = remaining.shift() ?? 0;
        return new Response(JSON.stringify({ processed: 1, remaining: left, status: left === 0 ? 'COMPLETED' : 'RUNNING' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(bodies[0]).toBe(JSON.stringify({ jobId: 'job-1' }));
    expect(new Set(secrets)).toEqual(new Set(['shipped-secret']));
    expect(counter.counts.size).toBe(0);
    expect(result).toEqual({ jobs: 1, rounds: 4, finished: 1 });
  });

  it('stops on a refusal instead of looping', async () => {
    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => ['job-2'], markFailed: async () => undefined },
      failures: failureCounter().failures,
      apiUrl: 'http://api:3001',
      secret: '',
      log: () => undefined,
      fetchImpl: async () => new Response('', { status: 404 }),
    });

    expect(result).toEqual({ jobs: 1, rounds: 1, finished: 0 });
  });

  it('does nothing when no job is queued', async () => {
    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => [], markFailed: async () => undefined },
      failures: failureCounter().failures,
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: () => undefined,
    });

    expect(result).toEqual({ jobs: 0, rounds: 0, finished: 0 });
  });

  it('aborts a call that never answers, rather than holding the queue open', async () => {
    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => ['job-4'], markFailed: async () => undefined },
      failures: failureCounter().failures,
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: () => undefined,
      timeoutMs: 10,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (signal === null || signal === undefined) {
            throw new Error('the drain must pass an abort signal');
          }

          signal.addEventListener('abort', () => {
            reject(new Error('aborted by timeout'));
          });
        }),
    });

    expect(result).toEqual({ jobs: 1, rounds: 0, finished: 0 });
  });

  it('gives up on the round cap and says so, so the next drain resumes from the database', async () => {
    const logged: string[] = [];

    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => ['job-5'], markFailed: async () => undefined },
      failures: failureCounter().failures,
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: (message) => logged.push(message),
      fetchImpl: async () =>
        new Response(JSON.stringify({ processed: 1, remaining: 1, status: 'RUNNING' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    expect(result.rounds).toBe(COIN_BULK_MAX_ROUNDS);
    expect(result.finished).toBe(0);
    expect(logged.some((line) => line.includes('round cap'))).toBe(true);
  });

  it('marks a poison job failed after five failed drains and raises an alert once', async () => {
    const counter = failureCounter();
    const failed: string[] = [];
    const alerts: string[] = [];

    for (let attempt = 0; attempt < COIN_BULK_MAX_CONSECUTIVE_FAILURES; attempt += 1) {
      await drainCoinBulkJobs({
        host: {
          findDrainable: async () => ['job-6'],
          markFailed: async (jobId, reason) => {
            failed.push(`${jobId}:${reason}`);
          },
        },
        failures: counter.failures,
        apiUrl: 'http://api:3001',
        secret: 'shipped-secret',
        log: () => undefined,
        alert: ({ jobId }) => {
          alerts.push(jobId);
        },
        fetchImpl: async () => new Response('', { status: 500 }),
      });
    }

    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('job-6');
    expect(alerts).toEqual(['job-6']);
    expect(counter.counts.size).toBe(0);
  });
});
