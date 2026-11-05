import { describe, expect, it } from 'vitest';

import { OTP_RETENTION_MINUTES } from '../jobs/otp-purge';
import { runMaintenanceJob } from './dispatch';
import { COIN_BULK_DRAIN_JOB, OTP_PURGE_JOB } from './maintenance';
import { OTP_PURGE_INTERVAL_MS, REPEATABLE_JOBS, registerRepeatableJobs, type RepeatableQueueHost } from './schedule';

interface RecordedAdd {
  readonly name: string;
  readonly data: Record<string, unknown>;
  readonly options: { readonly repeat: { readonly every: number } };
}

function stubQueue(): { queue: RepeatableQueueHost; calls: RecordedAdd[] } {
  const calls: RecordedAdd[] = [];
  const queue: RepeatableQueueHost = {
    add: async (name, data, options) => {
      calls.push({ name, data, options });
      return { id: `${name}-1` };
    },
  };
  return { queue, calls };
}

describe('the worker schedule', () => {
  it('registers the OTP purge as a repeatable job', async () => {
    const { queue, calls } = stubQueue();

    const registered = await registerRepeatableJobs(queue);

    expect(registered).toContain(OTP_PURGE_JOB);
    const purge = calls.find((call) => call.name === OTP_PURGE_JOB);
    expect(purge).toBeDefined();
    expect(purge?.options.repeat.every).toBe(OTP_PURGE_INTERVAL_MS);
    expect(purge?.data.retentionMinutes).toBe(OTP_RETENTION_MINUTES);
  });

  it('has a handler for every repeatable job it registers', async () => {
    for (const job of REPEATABLE_JOBS) {
      let deleted = 0;
      let drained = 0;
      const result = await runMaintenanceJob(
        { name: job.name, data: job.data },
        {
          now: () => new Date('2025-01-01T00:00:00Z'),
          log: () => undefined,
          database: {
            otpRequest: {
              deleteMany: async () => {
                deleted += 1;
                return { count: 0 };
              },
            },
          },
          coinBulk: {
            drain: async () => {
              drained += 1;
              return { jobs: 0, rounds: 0, finished: 0 };
            },
          },
        },
      );

      expect(result, job.name).toBeDefined();
      expect(deleted, job.name).toBe(job.name === OTP_PURGE_JOB ? 1 : 0);
      expect(drained, job.name).toBe(job.name === COIN_BULK_DRAIN_JOB ? 1 : 0);
    }
  });

  it('refuses a job it does not know, instead of silently completing it', async () => {
    await expect(
      runMaintenanceJob(
        { name: 'not-a-job', data: {} },
        { now: () => new Date(), log: () => undefined, database: { otpRequest: { deleteMany: async () => ({ count: 0 }) } } },
      ),
    ).rejects.toThrow(/Unknown job "not-a-job"/);
  });
});
