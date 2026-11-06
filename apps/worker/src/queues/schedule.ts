import { OTP_RETENTION_MINUTES } from '../jobs/otp-purge';
import { COIN_BULK_DRAIN_JOB, COIN_RECONCILIATION_JOB, OTP_PURGE_JOB } from './maintenance';

/**
 * The repeatable jobs the worker registers on boot.
 *
 * A repeatable job is a declaration, not a timer: BullMQ keeps the schedule in Redis, so a
 * restarted or duplicated worker does not add a second copy of the same work.
 */
export const OTP_PURGE_INTERVAL_MS = 15 * 60 * 1000;
/** A queued bulk assignment should start within half a minute of the Administrator's click. */
export const COIN_BULK_DRAIN_INTERVAL_MS = 30 * 1000;
/** Once a day: a wallet that drifted should be noticed before a person spends from it. */
export const COIN_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RepeatableJob {
  readonly name: string;
  readonly every: number;
  readonly data: Record<string, unknown>;
}

/** The narrow slice of a BullMQ queue this module needs, so it can be tested with a stub. */
export interface RepeatableQueueHost {
  add(
    name: string,
    data: Record<string, unknown>,
    options: { readonly repeat: { readonly every: number }; readonly removeOnComplete: number; readonly removeOnFail: number },
  ): Promise<unknown>;
}

export const REPEATABLE_JOBS: readonly RepeatableJob[] = [
  {
    name: OTP_PURGE_JOB,
    every: OTP_PURGE_INTERVAL_MS,
    data: { retentionMinutes: OTP_RETENTION_MINUTES },
  },
  {
    name: COIN_BULK_DRAIN_JOB,
    every: COIN_BULK_DRAIN_INTERVAL_MS,
    data: {},
  },
  {
    name: COIN_RECONCILIATION_JOB,
    every: COIN_RECONCILIATION_INTERVAL_MS,
    data: {},
  },
];

export async function registerRepeatableJobs(queue: RepeatableQueueHost): Promise<string[]> {
  const registered: string[] = [];

  for (const job of REPEATABLE_JOBS) {
    await queue.add(job.name, job.data, {
      repeat: { every: job.every },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
    registered.push(job.name);
  }

  return registered;
}
