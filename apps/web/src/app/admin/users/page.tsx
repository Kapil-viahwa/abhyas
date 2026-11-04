import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage, StatusBadge } from '../../../components/admin-shell';
import { FieldError, inputClass, labelClass, secondaryButtonClass } from '../../../components/auth-shell';
import { USER_ROLES, USER_STATUSES, flagLabels, listUsers, type UserListQuery } from '../../../lib/admin-api';
import { csrfFromCookies, loadRoleSession } from '../../../lib/session';

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

function pageHref(query: UserListQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') {
    params.set('search', query.search);
  }
  if (query.role !== undefined && query.role !== '') {
    params.set('role', query.role);
  }
  if (query.status !== undefined && query.status !== '') {
    params.set('status', query.status);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const suffix = params.toString();
  return suffix === '' ? '/admin/users' : `/admin/users?${suffix}`;
}

export default async function AdminUsersPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/admin/users', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  const query: UserListQuery = {
    search: single(params.search).trim(),
    role: single(params.role).trim().toUpperCase(),
    status: single(params.status).trim().toUpperCase(),
    page: Math.max(1, Number.parseInt(single(params.page), 10) || 1),
  };

  const list = await listUsers(session.accessToken, query);
  const error = single(params.error);

  return (
    <AdminPage csrf={csrf} current="/admin/users" title="Accounts" subtitle={`${list.total} accounts match`}>
      <FieldError message={error} />

      <form method="get" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
          <label className={labelClass}>
            Search
            <input
              className={inputClass}
              name="search"
              type="search"
              defaultValue={query.search ?? ''}
              placeholder="Email or name"
            />
          </label>

          <label className={labelClass}>
            Role
            <select className={inputClass} name="role" defaultValue={query.role ?? ''}>
              <option value="">Any</option>
              {USER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <label className={labelClass}>
            Status
            <select className={inputClass} name="status" defaultValue={query.status ?? ''}>
              <option value="">Any</option>
              {USER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button className="w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 sm:w-auto">
              Filter
            </button>
          </div>
        </div>
      </form>

      <ul data-testid="user-list" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
        {list.items.map((user) => {
          const flags = flagLabels(user.editorFlags);

          return (
            <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 space-y-1">
                <Link href={`/admin/users/${user.id}`} className="block truncate text-sm text-sky-300 hover:text-sky-200">
                  {user.email ?? 'No email linked'}
                </Link>
                <p className="truncate text-xs text-slate-500">
                  {user.fullName} · {user.roleCode}
                  {user.roleCode === 'EDITOR' ? ` · ${flags.length === 0 ? 'no capability' : flags.join(', ')}` : ''}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <StatusBadge status={user.status} />
                <Link href={`/admin/users/${user.id}`} className={secondaryButtonClass}>
                  Open
                </Link>
              </div>
            </li>
          );
        })}

        {list.items.length === 0 ? <li className="p-4 text-sm text-slate-400">No accounts match that filter.</li> : null}
      </ul>

      <nav className="flex items-center justify-between text-sm text-slate-400">
        {list.page > 1 ? (
          <Link href={pageHref(query, list.page - 1)} className="text-sky-400 hover:text-sky-300">
            Previous
          </Link>
        ) : (
          <span />
        )}

        <span>
          Page {list.page} of {list.pages}
        </span>

        {list.page < list.pages ? (
          <Link href={pageHref(query, list.page + 1)} className="text-sky-400 hover:text-sky-300">
            Next
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </AdminPage>
  );
}
