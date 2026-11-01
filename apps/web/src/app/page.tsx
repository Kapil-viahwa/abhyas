import type { ReactElement } from 'react';

import { apiBaseUrl, fetchHealth } from '../lib/api';

// Rendered per request: this page's whole job is to report the API's current state.
export const dynamic = 'force-dynamic';

function badgeClass(status: string): string {
  if (status === 'ok') {
    return 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30';
  }
  if (status === 'degraded') {
    return 'bg-amber-500/10 text-amber-300 ring-amber-500/30';
  }
  return 'bg-rose-500/10 text-rose-300 ring-rose-500/30';
}

export default async function HomePage(): Promise<ReactElement> {
  const baseUrl = apiBaseUrl(process.env);
  const health = await fetchHealth(baseUrl);
  const status = health.payload?.status ?? 'unreachable';

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Mock tests for India&apos;s competitive exams
        </h1>
        <p className="text-slate-400">
          Walking skeleton. The web app renders on the server and asks the API whether its
          dependencies are reachable.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-medium text-slate-100">API health</h2>
          <span
            data-testid="api-status"
            data-status={status}
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ${badgeClass(
              status,
            )}`}
          >
            {status}
          </span>
        </div>

        {health.payload ? (
          <dl className="mt-6 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">Database</dt>
              <dd data-testid="database-status" className="font-medium text-slate-200">
                {health.payload.checks.database}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Redis</dt>
              <dd data-testid="redis-status" className="font-medium text-slate-200">
                {health.payload.checks.redis}
              </dd>
            </div>
          </dl>
        ) : (
          <p role="alert" className="mt-4 text-sm text-rose-300">
            {health.error ?? 'Health endpoint unreachable'}
          </p>
        )}

        <p className="mt-6 text-xs text-slate-500">
          API {baseUrl} · version {health.payload?.version ?? 'unknown'}
        </p>
      </section>
    </main>
  );
}
