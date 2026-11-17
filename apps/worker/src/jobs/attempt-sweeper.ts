/**
 * The deadline sweeper, run by the worker.
 *
 * The attempt engine's one writer lives in the API, so the worker does not finalise anything
 * itself: it asks `POST /v1/internal/attempts/expire-expired` to run one bounded batch, exactly
 * as the bulk-coin drain asks the API to drain a job. The route is guarded by
 * `INTERNAL_API_SECRET` and `INTERNAL_ALLOWED_ADDRESSES` and answers 404 to every wrong caller,
 * so this job needs no session and no permission.
 *
 * This is a poller over database state: the expired attempts are the queue, the API re-checks
 * each one under its own lock, and the A1 constraints plus the shared finalisation make a
 * repeated call harmless. While the API is unreachable the job logs one line and returns — the
 * next tick is the retry, so a worker never crash-loops and never spins.
 *
 * Written over a small interface so the loop can be proven without Redis, Postgres or HTTP.
 */

export const ATTEMPT_SWEEP_BATCH_SIZE = 50;
/** A backlog drains in capped rounds; the cap keeps one tick from holding the queue forever. */
export const ATTEMPT_SWEEP_MAX_ROUNDS = 5;
/** No API call may hold the worker open: a stalled socket is a stalled queue. */
export const ATTEMPT_SWEEP_CALL_TIMEOUT_MS = 15_000;

export interface AttemptSweepDeps {
  readonly apiUrl: string;
  readonly secret: string;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface AttemptSweepJobResult {
  readonly rounds: number;
  readonly finalized: number;
  readonly skipped: number;
  readonly failed: number;
}

interface SweepResponse {
  readonly finalized?: unknown;
  readonly skipped?: unknown;
  readonly failed?: unknown;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export async function sweepExpiredAttempts(deps: AttemptSweepDeps): Promise<AttemptSweepJobResult> {
  const call = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_SWEEP_CALL_TIMEOUT_MS;
  let rounds = 0;
  let finalized = 0;
  let skipped = 0;
  let failed = 0;

  for (let round = 0; round < ATTEMPT_SWEEP_MAX_ROUNDS; round += 1) {
    let response: Response;

    try {
      response = await call(`${deps.apiUrl}/v1/internal/attempts/expire-expired`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': deps.secret },
        body: JSON.stringify({ batchSize: ATTEMPT_SWEEP_BATCH_SIZE }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      deps.log('attempt sweep could not reach the API', { error: errorName(error) });
      break;
    }

    if (!response.ok) {
      deps.log(`attempt sweep answered ${String(response.status)}`);
      break;
    }

    let body: SweepResponse;
    try {
      body = (await response.json()) as SweepResponse;
    } catch (error) {
      deps.log('attempt sweep answered something that is not JSON', { error: errorName(error) });
      break;
    }

    const thisFinalized = count(body.finalized);
    const thisSkipped = count(body.skipped);
    const thisFailed = count(body.failed);

    rounds += 1;
    finalized += thisFinalized;
    skipped += thisSkipped;
    failed += thisFailed;

    // A batch smaller than the cap means the backlog is drained; a full one may be followed by
    // another round, up to the cap above.
    if (thisFinalized + thisSkipped + thisFailed < ATTEMPT_SWEEP_BATCH_SIZE) {
      break;
    }
  }

  const result: AttemptSweepJobResult = { rounds, finalized, skipped, failed };
  deps.log(
    `attempts: ${String(finalized)} expired swept, ${String(skipped)} skipped, ${String(failed)} failed in ${String(rounds)} round(s)`,
  );
  return result;
}
