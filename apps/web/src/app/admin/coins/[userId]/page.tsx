import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import type { ReactElement } from 'react';

import { AdminPage, StatusBadge } from '../../../../components/admin-shell';
import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from '../../../../components/auth-shell';
import { getUser } from '../../../../lib/admin-api';
import {
  COIN_LEDGER_TYPES,
  coinLedger,
  isUuid,
  ledgerExportPath,
  type CoinLedgerItem,
  type CoinLedgerPage,
} from '../../../../lib/coins-api';
import { csrfFromCookies, loadPermissionSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ userId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return '';
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

function signed(amount: number): string {
  return `${amount > 0 ? '+' : ''}${formatNumber(amount)}`;
}

function pageHref(userId: string, type: string, page: number): string {
  const params = new URLSearchParams();

  if (type !== '') {
    params.set('type', type);
  }
  if (page > 1) {
    params.set('page', String(page));
  }

  const suffix = params.toString();
  return suffix === '' ? `/admin/coins/${userId}` : `/admin/coins/${userId}?${suffix}`;
}

function ledgerRows(ledger: CoinLedgerPage): readonly CoinLedgerItem[] {
  return ledger.items;
}

/**
 * One account's coins: what it holds, what moved, and the form that moves it.
 *
 * The Idempotency-Key is generated here, once per render, and stays the same if the API asks
 * for a proof and the person sends the form again. A second click therefore resends one
 * request, not two.
 */
export default async function AdminAccountCoinsPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { userId } = await params;
  const session = await loadPermissionSession(`/admin/coins/${userId}`, 'coins.write');
  const csrf = await csrfFromCookies();
  const query = await searchParams;

  const type = single(query.type).trim().toUpperCase();
  const page = Math.max(1, Number.parseInt(single(query.page), 10) || 1);

  const [account, ledger] = await Promise.all([
    getUser(session.accessToken, userId),
    coinLedger(session.accessToken, userId, { ...(type === '' ? {} : { type }), page }),
  ]);

  if (account === null || ledger === null) {
    notFound();
  }

  const requestedKey = single(query.key).trim();
  const adjustKey = isUuid(requestedKey) ? requestedKey : randomUUID();
  const needsProof = single(query.reauth) === '1';
  // A refused submission comes back with its own amount and reason, so the retry is the same
  // request: the API's key is bound to that exact body.
  const requestedAmount = single(query.amount).trim();
  const requestedRemark = single(query.remark).trim();
  const pages = Math.max(1, Math.ceil(ledger.total / ledger.pageSize));

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/admin/coins"
      title={account.email ?? account.fullName}
      subtitle={`${account.fullName} · ${account.roleCode}`}
    >
      <Notice message={single(query.adjusted) === '1' ? 'Coins moved. The ledger row below is the proof.' : undefined} />
      <FieldError message={single(query.error) === '' ? undefined : single(query.error)} />
      {needsProof ? (
        <Notice message="That submission was not saved. Confirm it is you below and send it again — the same request is kept." />
      ) : null}

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Balance</p>
          <p data-testid="coin-balance" className="mt-2 text-2xl font-semibold text-white">
            {formatNumber(ledger.balance)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total earned</p>
          <p data-testid="coin-earned" className="mt-2 text-2xl font-semibold text-emerald-300">
            {formatNumber(ledger.totalEarned)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total spent</p>
          <p data-testid="coin-spent" className="mt-2 text-2xl font-semibold text-rose-300">
            {formatNumber(ledger.totalSpent)}
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-slate-100">Adjust</h2>
          <StatusBadge status={account.status} />
        </div>

        <form action="/api/admin/coins/adjust" method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="userId" value={account.id} />
          <input type="hidden" name="idempotencyKey" value={adjustKey} />

          <label className={labelClass}>
            Amount
            <input className={inputClass} name="amount" type="number" step={1} required defaultValue={requestedAmount} />
            <span className="mt-1 block text-xs text-slate-500">Positive credits, negative deducts.</span>
          </label>

          <label className={labelClass}>
            Reason (required)
            <input
              className={inputClass}
              name="remark"
              type="text"
              required
              minLength={3}
              maxLength={200}
              defaultValue={requestedRemark}
            />
          </label>

          <label className={labelClass}>
            Your password
            <input className={inputClass} name="password" type="password" autoComplete="current-password" />
          </label>

          <label className={labelClass}>
            Or the code you were sent
            <input className={inputClass} name="code" inputMode="numeric" autoComplete="one-time-code" />
          </label>

          <p className="text-xs text-slate-500 sm:col-span-2">
            A coin write needs a proof of the person made in the last ten minutes: your password, or the code sent to
            your mobile number. Leave both blank if you have already confirmed in this browser.
          </p>

          <div className="sm:col-span-2">
            <button className={`${buttonClass} sm:w-auto`} type="submit">
              Add or deduct coins
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-slate-100">Ledger</h2>

          <form method="get" action={`/admin/coins/${account.id}`} className="flex flex-wrap items-center gap-2">
            <label htmlFor="type" className="text-xs text-slate-400">
              Type
            </label>
            <select
              id="type"
              name="type"
              defaultValue={type}
              className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
            >
              {COIN_LEDGER_TYPES.map((value) => (
                <option key={value} value={value}>
                  {value === '' ? 'All' : value}
                </option>
              ))}
            </select>
            <button className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200" type="submit">
              Filter
            </button>
          </form>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2">When</th>
                <th className="py-2">Type</th>
                <th className="py-2 text-right">Coins</th>
                <th className="py-2 text-right">Before</th>
                <th className="py-2 text-right">After</th>
              </tr>
            </thead>
            <tbody data-testid="coin-ledger" className="divide-y divide-slate-800">
              {ledgerRows(ledger).map((row) => (
                <tr key={row.id}>
                  <td className="py-2 text-slate-400">{formatMoment(row.createdAt)}</td>
                  <td className="py-2 text-slate-200">{row.type}</td>
                  <td className={`py-2 text-right ${row.amount < 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                    {signed(row.amount)}
                  </td>
                  <td className="py-2 text-right text-slate-300">{formatNumber(row.previousBalance)}</td>
                  <td className="py-2 text-right text-slate-300">{formatNumber(row.newBalance)}</td>
                </tr>
              ))}

              {ledger.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-500">
                    No coins have moved on this account yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <Link className={secondaryButtonClass} href={ledgerExportPath(account.id, type)}>
            Download CSV
          </Link>

          <div className="flex items-center gap-3">
            {page > 1 ? (
              <Link href={pageHref(account.id, type, page - 1)} className="text-sky-400 hover:text-sky-300">
                Previous
              </Link>
            ) : (
              <span className="text-slate-600">Previous</span>
            )}
            <span className="text-slate-500">
              Page {page} of {pages}
            </span>
            {page < pages ? (
              <Link href={pageHref(account.id, type, page + 1)} className="text-sky-400 hover:text-sky-300">
                Next
              </Link>
            ) : (
              <span className="text-slate-600">Next</span>
            )}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/coins" className="text-sky-400 hover:text-sky-300">
          Search another account
        </Link>
        <Link href="/admin/coins/bulk" className="text-sky-400 hover:text-sky-300">
          Bulk assignment
        </Link>
        <Link href={`/admin/users/${account.id}`} className="text-sky-400 hover:text-sky-300">
          Open the account
        </Link>
      </div>
    </AdminPage>
  );
}
