import { describe, expect, it, vi } from 'vitest';

import { processPing } from './ping';

const deps = {
  now: () => new Date('2025-01-01T00:00:00.000Z'),
  log: vi.fn(),
};

describe('processPing', () => {
  it('handles a valid ping job', async () => {
    const result = await processPing(
      {
        id: 'job-1',
        data: { requestedBy: 'worker-bootstrap', requestedAt: '2025-01-01T00:00:00.000Z' },
      },
      deps,
    );

    expect(result).toEqual({
      jobId: 'job-1',
      requestedBy: 'worker-bootstrap',
      handledAt: '2025-01-01T00:00:00.000Z',
    });
    expect(deps.log).toHaveBeenCalledOnce();
  });

  it('rejects a ping job without a requester', async () => {
    await expect(
      processPing({ id: 'job-2', data: { requestedAt: '2025-01-01T00:00:00.000Z' } }, deps),
    ).rejects.toThrow(/requestedBy/);
  });

  it('rejects a ping job with an unusable timestamp', async () => {
    await expect(
      processPing({ id: 'job-3', data: { requestedBy: 'tests', requestedAt: 'not-a-date' } }, deps),
    ).rejects.toThrow(/requestedAt/);
  });
});
