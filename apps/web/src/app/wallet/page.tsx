import Link from 'next/link';
import type { ReactElement } from 'react';

import { FieldError } from '../../components/auth-shell';
import { loadSession } from '../../lib/session';
import { apiCall, errorMessage } from '../../lib/upstream';

export const dynamic = 'force-dynamic';

const TYPES = ['', 'SIGNUP_GRANT', 'DAILY_REWARD', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ENROLLMENT'];

interface Overview {
  readonly balance: number;
  readonly totalEarned: number;
  readonly totalSpent: number;
  readonly today: { readonly rewardDate: string; readonly paid: boolean; readonly amount: number };
  readonly nextRewardDate: string;
}

interface HistoryItem {
  readonly type: string;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly description: string | null;
  readonly reference: string | null;
  readonly createdAt: string;
}

interface HistoryPage {
  readonly items: HistoryItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-IN');
}

function formatMoment(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'unknown'
    : date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

/** A student's own wallet: balance, totals, today's reward and the ledger, paged and filtered. */
export default async function WalletPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadSession('/wallet');
  const params = await searchParams;
  const type = one(params.type);
  const page = one(params.page) === '' ? '1' : one(params.page);

  const overview = await apiCall<Overview>('/v1/coins/me', { method: 'GET', accessToken: session.accessToken });
  const history = await apiCall<HistoryPage>(
    `/v1/coins/me/history?page=${encodeURIComponent(page)}&pageSize=20${type === '' ? '' : `&type=${encodeURIComponent(type)}`}`,
    { method: 'GET', accessToken: session.accessToken },
  );

  const balance = overview.body;
  const rows = history.body?.items ?? [];
  const total = history.body?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (history.body?.pageSize ?? 20)));
  const current = history.body?.page ?? 1;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Your coins</h1>
          <p className="text-sm text-slate-400">{session.profile.fullName}</p>
        </div>
        <nav className="flex flex-wrap gap-3 text-sm">
          <Link href="/account" className="text-sky-400 hover:text-sky-300">
            Account
          </Link>
          <Link href="/wallet" className="text-slate-200">
            Wallet
          </Link>
          <Link href="/tests" className="text-sky-400 hover:text-sky-300">
            Tests
          </Link>
        </nav>
      </header>

      <FieldError message={overview.status === 200 ? undefined : errorMessage(overview.body)} />

      {balance === null ? null : (
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Balance</p>
            <p data-testid="wallet-balance" className="mt-2 text-2xl font-semibold text-white">
              {formatNumber(balance.balance)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Total earned</p>
            <p data-testid="wallet-earned" className="mt-2 text-2xl font-semibold text-emerald-300">
              {formatNumber(balance.totalEarned)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Total spent</p>
            <p data-testid="wallet-spent" className="mt-2 text-2xl font-semibold text-rose-300">
              {formatNumber(balance.totalSpent)}
            </p>
          </div>
        </section>
      )}

      {balance === null ? null : (
        <section data-testid="wallet-reward" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          {balance.today.paid ? (
            <p className="text-sm text-emerald-300">
              Today’s {formatNumber(balance.today.amount)} coin reward has been added.
            </p>
          ) : (
            <p className="text-sm text-slate-300">
              Today’s reward is not claimed yet. The next one is available on {balance.nextRewardDate}.
            </p>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-slate-100">History</h2>
          {/* A GET form: filters are a URL, so the page stays server-rendered and shareable. */}
          <form method="get" action="/wallet" className="flex flex-wrap items-center gap-2">
            <label htmlFor="type" className="text-xs text-slate-400">
              Type
            </label>
            <select
              id="type"
              name="type"
              defaultValue={type}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
            >
              {TYPES.map((value) => (
                <option key={value} value={value}>
                  {value === '' ? 'All' : value}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200">
              Apply
            </button>
          </form>
        </div>

        <FieldError message={history.status === 200 ? undefined : errorMessage(history.body)} />

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2">When</th>
                <th className="py-2">Type</th>
                <th className="py-2 text-right">Coins</th>
                <th className="py-2 text-right">Balance</th>
                <th className="py-2">Note</th>
              </tr>
            </thead>
            <tbody data-testid="wallet-history" className="divide-y divide-slate-800">
              {rows.map((row) => (
                <tr key={`${row.type}-${row.createdAt}-${String(row.amount)}`}>
                  <td className="py-2 text-slate-400">{formatMoment(row.createdAt)}</td>
                  <td className="py-2 text-slate-200">{row.type}</td>
                  <td className={`py-2 text-right ${row.amount < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                    {row.amount > 0 ? '+' : ''}
                    {formatNumber(row.amount)}
                  </td>
                  <td className="py-2 text-right text-slate-300">{formatNumber(row.balanceAfter)}</td>
                  <td className="py-2 text-slate-400">{row.description ?? row.reference ?? '—'}</td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-500">
                    No coins have moved yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <nav className="mt-4 flex items-center justify-between text-sm">
          {current > 1 ? (
            <Link href={`/wallet?page=${String(current - 1)}${type === '' ? '' : `&type=${type}`}`} className="text-sky-400">
              Previous
            </Link>
          ) : (
            <span className="text-slate-600">Previous</span>
          )}
          <span className="text-slate-500">
            Page {current} of {pageCount}
          </span>
          {current < pageCount ? (
            <Link href={`/wallet?page=${String(current + 1)}${type === '' ? '' : `&type=${type}`}`} className="text-sky-400">
              Next
            </Link>
          ) : (
            <span className="text-slate-600">Next</span>
          )}
        </nav>
      </section>
    </main>
  );
}
