export type HealthStatus = 'ok' | 'degraded';

export type ProbeState = 'ok' | 'down';

export interface HealthPayload {
  status: HealthStatus;
  service: string;
  version: string;
  checkedAt: string;
  checks: {
    database: ProbeState;
    redis: ProbeState;
  };
}

export interface HealthLookup {
  payload: HealthPayload | null;
  error: string | null;
}

/** Minimal shape of fetch that the app depends on, so tests can substitute one. */
export type FetchLike = (
  input: string,
  init?: { cache?: RequestCache; headers?: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const DEFAULT_API_BASE_URL = 'http://localhost:3001';

/**
 * The API base URL is server-side configuration only. It is never exposed to the
 * browser unless a NEXT_PUBLIC_ value is explicitly configured.
 */
export function apiBaseUrl(env: Record<string, string | undefined>): string {
  const configured =
    env.API_INTERNAL_URL?.trim() || env.NEXT_PUBLIC_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;

  return configured.replace(/\/+$/, '');
}

export function isHealthPayload(value: unknown): value is HealthPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<HealthPayload>;
  const checks = candidate.checks as Partial<HealthPayload['checks']> | undefined;

  if (candidate.status !== 'ok' && candidate.status !== 'degraded') {
    return false;
  }
  if (typeof candidate.service !== 'string' || typeof candidate.version !== 'string') {
    return false;
  }
  if (typeof candidate.checkedAt !== 'string' || typeof checks !== 'object' || checks === null) {
    return false;
  }

  const isProbeState = (state: unknown): boolean => state === 'ok' || state === 'down';

  return isProbeState(checks.database) && isProbeState(checks.redis);
}

const defaultFetcher: FetchLike = (input, init) => fetch(input, init);

export async function fetchHealth(baseUrl: string, fetcher: FetchLike = defaultFetcher): Promise<HealthLookup> {
  try {
    // A degraded API answers 503 with a body, so the status code alone is not the answer.
    const response = await fetcher(`${baseUrl}/health`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });

    const body = await response.json();
    if (!isHealthPayload(body)) {
      return { payload: null, error: `Unexpected /health response (HTTP ${response.status})` };
    }

    return { payload: body, error: null };
  } catch (error) {
    return {
      payload: null,
      error: error instanceof Error ? error.message : 'Health request failed',
    };
  }
}
