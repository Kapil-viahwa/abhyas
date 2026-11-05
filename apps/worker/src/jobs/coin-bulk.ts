/**
 * The bulk coin assignment drain, run by the worker.
 *
 * The ledger has one writer and it lives in the API, so the worker does not write coins: it
 * finds queued jobs and asks the API to run a batch of each. The API route is guarded by
 * `INTERNAL_API_SECRET` and answers 404 without it, so this job needs no session and no
 * permission, and a wrong secret looks like a wrong URL.
 *
 * This is a poller over database state, not a queue of its own: the job row and its per-person
 * rows are the queue, so a killed worker resumes by asking again, and the per-user
 * idempotency key makes every retry harmless (decision 0063).
 *
 * Written as a function over small interfaces so the loop can be proven without Redis,
 * Postgres or an HTTP server.
 */

export interface CoinBulkDrainHost {
  /** Job ids whose status is QUEUED or RUNNING and that still have work. */
  findDrainable(limit: number): Promise<string[]>;
  /** Marks the job FAILED with the reason a person can read in the status screen. */
  markFailed(jobId: string, reason: string): Promise<void>;
}

/** Consecutive failed drains remembered per job, across invocations of this function. */
export interface CoinBulkFailureCounter {
  bump(jobId: string, reason: string): Promise<number>;
  clear(jobId: string): Promise<void>;
}

export interface CoinBulkDrainDeps {
  readonly host: CoinBulkDrainHost;
  readonly failures: CoinBulkFailureCounter;
  readonly apiUrl: string;
  readonly secret: string;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
  readonly fetchImpl?: typeof fetch;
  /** Raised when a job is given up on, so an operator's alert counter moves. */
  readonly alert?: (event: { readonly jobId: string; readonly reason: string }) => Promise<void> | void;
  readonly timeoutMs?: number;
}

export const COIN_BULK_DRAIN_LIMIT = 10;
/** The API drains a batch at a time; the worker asks again until the job reports none left. */
export const COIN_BULK_MAX_ROUNDS = 50;
/** No API call may hold the worker open: a stalled socket is a stalled queue. */
export const COIN_BULK_CALL_TIMEOUT_MS = 15_000;
/** Five drains in a row that fail on one job is a broken job, not a slow one. */
export const COIN_BULK_MAX_CONSECUTIVE_FAILURES = 5;

export interface CoinBulkDrainResult {
  readonly jobs: number;
  readonly rounds: number;
  readonly finished: number;
}

export async function drainCoinBulkJobs(deps: CoinBulkDrainDeps): Promise<CoinBulkDrainResult> {
  const ids = await deps.host.findDrainable(COIN_BULK_DRAIN_LIMIT);
  const call = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? COIN_BULK_CALL_TIMEOUT_MS;
  let rounds = 0;
  let finished = 0;

  for (const jobId of ids) {
    let capped = true;

    for (let round = 0; round < COIN_BULK_MAX_ROUNDS; round += 1) {
      let response: Response;

      try {
        response = await call(`${deps.apiUrl}/v1/internal/coins/bulk/drain`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-secret': deps.secret },
          body: JSON.stringify({ jobId }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        capped = false;
        await thisRoundFailed(deps, jobId, `the API could not be reached (${errorName(error)})`);
        break;
      }

      rounds += 1;

      if (!response.ok) {
        capped = false;
        await thisRoundFailed(deps, jobId, `the API answered ${String(response.status)}`);
        break;
      }

      const body = (await response.json()) as { remaining?: unknown };
      const remaining = typeof body.remaining === 'number' ? body.remaining : 0;

      if (remaining === 0) {
        capped = false;
        finished += 1;
        await deps.failures.clear(jobId);
        deps.log(`bulk job ${jobId} finished`);
        break;
      }
    }

    if (capped) {
      deps.log(`bulk job ${jobId} hit the round cap of ${String(COIN_BULK_MAX_ROUNDS)}; it resumes next time`);
    }
  }

  return { jobs: ids.length, rounds, finished };
}

/** Counts one failed drain and gives the job up after five in a row. */
async function thisRoundFailed(deps: CoinBulkDrainDeps, jobId: string, reason: string): Promise<void> {
  deps.log(`bulk job ${jobId} could not be drained: ${reason}`);

  let consecutive = 0;

  try {
    consecutive = await deps.failures.bump(jobId, reason);
  } catch (error) {
    deps.log(`the failure count for bulk job ${jobId} could not be written`, { error: errorName(error) });
    return;
  }

  if (consecutive < COIN_BULK_MAX_CONSECUTIVE_FAILURES) {
    return;
  }

  deps.log(`bulk job ${jobId} failed after ${String(consecutive)} attempts`);

  try {
    await deps.host.markFailed(jobId, reason);
  } catch (error) {
    deps.log(`bulk job ${jobId} could not be marked failed`, { error: errorName(error) });
  }

  try {
    await deps.failures.clear(jobId);
    await deps.alert?.({ jobId, reason });
  } catch (error) {
    deps.log(`the alert for bulk job ${jobId} could not be raised`, { error: errorName(error) });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
