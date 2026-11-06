import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../components/admin-shell';
import { FieldError, inputClass, labelClass, secondaryButtonClass } from '../../../components/auth-shell';
import { searchCoinRecipients } from '../../../lib/coins-api';
import { csrfFromCookies, loadPermissionSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
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

/** Find the account whose coins are about to change. */
export default async function AdminCoinsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadPermissionSession('/admin/coins', 'coins.write');
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  const query = single(params.q).trim();
  const recipients = query.length >= 2 ? await searchCoinRecipients(session.accessToken, query) : [];

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/admin/coins"
      title="Coins"
      subtitle="Find an account, adjust its balance with a reason, or credit many from a CSV."
    >
      <FieldError message={single(params.error) === '' ? undefined : single(params.error)} />

      <form method="get" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,3fr)_auto]">
          <label className={labelClass}>
            Search an account
            <input
              className={inputClass}
              name="q"
              type="search"
              defaultValue={query}
              placeholder="Email, name or mobile"
            />
          </label>

          <div className="flex items-end">
            <button className="w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 sm:w-auto">
              Search
            </button>
          </div>
        </div>
      </form>

      {query !== '' && query.length < 2 ? <p className="text-sm text-slate-400">Type at least two characters.</p> : null}

      <ul data-testid="coin-recipients" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
        {recipients.map((person) => (
          <li key={person.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm text-slate-100">{person.email ?? person.mobile ?? person.fullName}</p>
              <p className="truncate text-xs text-slate-500">
                {person.fullName} · {person.status.toLowerCase()}
              </p>
            </div>
            <Link href={`/admin/coins/${person.id}`} className={secondaryButtonClass}>
              Open
            </Link>
          </li>
        ))}

        {recipients.length === 0 && query.length >= 2 ? (
          <li className="p-4 text-sm text-slate-400">No account matches that search.</li>
        ) : null}
      </ul>

      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/admin/coins/bulk" className="text-sky-400 hover:text-sky-300">
          Bulk assignment from a CSV
        </Link>
        <Link href="/admin" className="text-sky-400 hover:text-sky-300">
          Back to administration
        </Link>
      </div>
    </AdminPage>
  );
}
