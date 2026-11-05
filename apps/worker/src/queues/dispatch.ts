import { processPing } from '../jobs/ping';
import { OTP_RETENTION_MINUTES, purgeOtpRequests, type OtpPurgeClient } from '../jobs/otp-purge';
import { COIN_BULK_DRAIN_JOB, MAINTENANCE_QUEUE, OTP_PURGE_JOB, PING_JOB } from './maintenance';

/**
 * The one place a maintenance job is dispatched. Keeping it out of `main.ts` means the job
 * table can be proven by a unit test without a Redis connection, and the worker and the test
 * cannot drift apart.
 */
export interface MaintenanceJob {
  readonly id?: string | undefined;
  readonly name: string;
  readonly data: unknown;
}

export interface MaintenanceDeps {
  readonly now: () => Date;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
  readonly database: OtpPurgeClient;
  /** Drains queued bulk coin assignments through the API, which owns the ledger writer. */
  readonly coinBulk?: { drain(): Promise<{ jobs: number; rounds: number; finished: number }> } | undefined;
}

export interface OtpPurgeResult {
  readonly deleted: number;
}

export async function runMaintenanceJob(job: MaintenanceJob, deps: MaintenanceDeps): Promise<unknown> {
  if (job.name === PING_JOB) {
    return processPing(
      { id: job.id, data: job.data },
      {
        now: deps.now,
        log: deps.log,
      },
    );
  }

  if (job.name === OTP_PURGE_JOB) {
    const deleted = await purgeOtpRequests(deps.database, deps.now(), OTP_RETENTION_MINUTES);
    deps.log(`purged ${String(deleted)} otp requests`);
    const result: OtpPurgeResult = { deleted };
    return result;
  }

  if (job.name === COIN_BULK_DRAIN_JOB) {
    if (deps.coinBulk === undefined) {
      throw new Error('The worker has no coin bulk drain configured');
    }

    const result = await deps.coinBulk.drain();
    deps.log(`coins: ${String(result.jobs)} bulk job(s), ${String(result.finished)} finished`);
    return result;
  }

  throw new Error(`Unknown job "${job.name}" on queue "${MAINTENANCE_QUEUE}"`);
}
