/**
 * The nightly wallet reconciliation, run by the worker (phase 5, item 4a).
 *
 * The ledger code lives in the API, so the worker does not read wallets itself: it asks the
 * API's internal route to run the check, exactly as the bulk drain does. The route is guarded
 * by `INTERNAL_API_SECRET` and `INTERNAL_ALLOWED_ADDRESSES`, and answers 404 otherwise.
 *
 * Written over two small interfaces so the call can be proven without Redis, Postgres or an
 * HTTP server.
 */

export interface CoinReconciliationCounts {
  readonly walletsChecked: number;
  readonly mismatches: number;
}

export interface CoinReconciliationDeps {
  readonly apiUrl: string;
  readonly secret: string;
  readonly log: (message: string, meta?: Record<string, unknown>) => void;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A nightly scan of every wallet is allowed to take its time, but not forever. */
export const COIN_RECONCILIATION_TIMEOUT_MS = 60_000;

export async function reconcileCoinWallets(
  deps: CoinReconciliationDeps,
): Promise<CoinReconciliationCounts | null> {
  const call = deps.fetchImpl ?? fetch;

  const response = await call(`${deps.apiUrl}/v1/internal/coins/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': deps.secret },
    body: '{}',
    signal: AbortSignal.timeout(deps.timeoutMs ?? COIN_RECONCILIATION_TIMEOUT_MS),
  });

  if (!response.ok) {
    deps.log(`the wallet reconciliation could not run`, { status: response.status });
    return null;
  }

  const body = (await response.json()) as { walletsChecked?: unknown; mismatches?: unknown };
  const counts: CoinReconciliationCounts = {
    walletsChecked: typeof body.walletsChecked === 'number' ? body.walletsChecked : 0,
    mismatches: typeof body.mismatches === 'number' ? body.mismatches : 0,
  };

  deps.log(`coins: reconciliation checked ${String(counts.walletsChecked)} wallet(s), ${String(counts.mismatches)} mismatch(es)`);

  return counts;
}
