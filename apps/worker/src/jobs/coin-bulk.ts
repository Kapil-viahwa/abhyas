/**
 * The bulk coin assignment drain, run by the worker.
 *
 * The ledger has one writer and it lives in the API, so the worker does not write coins: it
 * finds queued jobs and asks the API to run a batch of each. The API route is guarded by the
 * shared internal secret and answers 404 without it, so this job needs no session and no
 * permission, and a wrong secret looks like a wrong URL.
 *
 * Written as a function over two small interfaces so the loop can be proven without Redis,
 * Postgres or an HTTP server.
 */

export interface CoinBulkDrainHost {
  /** Job ids whose status is QUEUED or RUNNING and that still have work. */
  findDrainable(limit: number): Promise<string[]>;
}

export interface CoinBulkDrainDeps {
  readonly host: CoinBulkDrainHost;
  readonly apiUrl: string;
  readonly secret: string;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
  readonly fetchImpl?: typeof fetch;
}

export const COIN_BULK_DRAIN_LIMIT = 10;
/** The API drains a batch at a time; the worker asks again until the job reports none left. */
export const COIN_BULK_MAX_ROUNDS = 50;

export interface CoinBulkDrainResult {
  readonly jobs: number;
  readonly rounds: number;
  readonly finished: number;
}

export async function drainCoinBulkJobs(deps: CoinBulkDrainDeps): Promise<CoinBulkDrainResult> {
  const ids = await deps.host.findDrainable(COIN_BULK_DRAIN_LIMIT);
  const call = deps.fetchImpl ?? fetch;
  let rounds = 0;
  let finished = 0;

  for (const jobId of ids) {
    for (let round = 0; round < COIN_BULK_MAX_ROUNDS; round += 1) {
      const response = await call(`${deps.apiUrl}/v1/internal/coins/bulk/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': deps.secret },
        body: JSON.stringify({ jobId }),
      });

      rounds += 1;

      if (!response.ok) {
        deps.log(`bulk job ${jobId} could not be drained`, { status: response.status });
        break;
      }

      const body = (await response.json()) as { remaining?: unknown };
      const remaining = typeof body.remaining === 'number' ? body.remaining : 0;

      if (remaining === 0) {
        finished += 1;
        deps.log(`bulk job ${jobId} finished`);
        break;
      }
    }
  }

  return { jobs: ids.length, rounds, finished };
}
