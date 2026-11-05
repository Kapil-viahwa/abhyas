import { describe, expect, it } from 'vitest';

import { drainCoinBulkJobs } from './coin-bulk';

describe('the bulk coin drain', () => {
  it('asks the API for a batch until the job reports nothing left', async () => {
    const asked: string[] = [];
    const bodies: string[] = [];
    const remaining = [3, 2, 1, 0];

    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => ['job-1'] },
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: () => undefined,
      fetchImpl: async (input, init) => {
        asked.push(String(input));
        bodies.push(String(init?.body ?? ''));
        const left = remaining.shift() ?? 0;
        return new Response(JSON.stringify({ processed: 1, remaining: left, status: left === 0 ? 'COMPLETED' : 'RUNNING' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(asked).toHaveLength(4);
    expect(new Set(asked)).toEqual(new Set(['http://api:3001/v1/internal/coins/bulk/drain']));
    expect(bodies[0]).toBe(JSON.stringify({ jobId: 'job-1' }));
    expect(result).toEqual({ jobs: 1, rounds: 4, finished: 1 });
  });

  it('stops on a refusal instead of looping', async () => {
    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => ['job-2'] },
      apiUrl: 'http://api:3001',
      secret: '',
      log: () => undefined,
      fetchImpl: async () => new Response('', { status: 404 }),
    });

    expect(result).toEqual({ jobs: 1, rounds: 1, finished: 0 });
  });

  it('does nothing when no job is queued', async () => {
    const result = await drainCoinBulkJobs({
      host: { findDrainable: async () => [] },
      apiUrl: 'http://api:3001',
      secret: 'shipped-secret',
      log: () => undefined,
    });

    expect(result).toEqual({ jobs: 0, rounds: 0, finished: 0 });
  });
});
