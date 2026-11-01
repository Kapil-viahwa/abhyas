import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../components/admin-shell';
import { dashboardCounts } from '../../lib/operations-api';
import { csrfFromCookies, loadRoleSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

/** Real counts of what the platform holds today, from the one endpoint that knows. */
export default async function AdminOverviewPage(): Promise<ReactElement> {
  const session = await loadRoleSession('/admin', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const counts = await dashboardCounts(session.accessToken);

  const tiles = [
    { label: 'Accounts', value: counts?.users ?? 0, href: '/admin/users' },
    { label: 'Editors', value: counts?.editors ?? 0, href: '/admin/users?role=EDITOR' },
    { label: 'Live sessions', value: counts?.activeSessions ?? 0, href: '/admin/users' },
    { label: 'Categories', value: counts?.categories ?? 0, href: '/admin/catalog' },
    { label: 'Exams', value: counts?.exams ?? 0, href: '/admin/catalog' },
  ];

  return (
    <AdminPage
      csrf={csrf}
      current="/admin"
      title="Administrator area"
      subtitle={`${session.profile.fullName} · ${session.profile.roleCode}`}
    >
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.label}
            href={tile.href}
            className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 transition hover:border-slate-600"
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">{tile.label}</p>
            <p className="mt-2 text-2xl font-semibold text-white">{tile.value}</p>
          </Link>
        ))}
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-slate-100">Administration</h2>
        <p className="mt-1 text-sm text-slate-400">
          Search and filter every account, create an editor with explicit capabilities, keep the catalog, change the
          settings the platform runs on, and read the audit trail. Every write ends the sessions it invalidates and is
          audited.
        </p>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link href="/admin/users" className="text-sky-400 hover:text-sky-300">
            All accounts
          </Link>
          <Link href="/admin/users/new" className="text-sky-400 hover:text-sky-300">
            Create an editor
          </Link>
          <Link href="/admin/catalog" className="text-sky-400 hover:text-sky-300">
            Catalog
          </Link>
          <Link href="/admin/settings" className="text-sky-400 hover:text-sky-300">
            Settings
          </Link>
          <Link href="/admin/audit" className="text-sky-400 hover:text-sky-300">
            Audit trail
          </Link>
        </div>
      </section>
    </AdminPage>
  );
}
