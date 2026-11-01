import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../components/admin-shell';
import { listUsers } from '../../lib/admin-api';
import { csrfFromCookies, loadRoleSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

/** The administrator's landing page: real counts from the endpoints that exist today. */
export default async function AdminOverviewPage(): Promise<ReactElement> {
  const session = await loadRoleSession('/admin', ['ADMIN']);
  const csrf = await csrfFromCookies();

  const [students, editors, admins] = await Promise.all([
    listUsers(session.accessToken, { role: 'USER' }),
    listUsers(session.accessToken, { role: 'EDITOR' }),
    listUsers(session.accessToken, { role: 'ADMIN' }),
  ]);

  const tiles = [
    { label: 'Students', value: students.total, href: '/admin/users?role=USER' },
    { label: 'Editors', value: editors.total, href: '/admin/users?role=EDITOR' },
    { label: 'Administrators', value: admins.total, href: '/admin/users?role=ADMIN' },
  ];

  return (
    <AdminPage
      csrf={csrf}
      current="/admin"
      title="Administrator area"
      subtitle={`${session.profile.fullName} · ${session.profile.roleCode}`}
    >
      <section className="grid gap-3 sm:grid-cols-3">
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
        <h2 className="text-lg font-medium text-slate-100">People</h2>
        <p className="mt-1 text-sm text-slate-400">
          Search and filter every account, create an editor with explicit capabilities, and suspend or restore an
          account. Every write ends the sessions it invalidates and is audited.
        </p>
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link href="/admin/users" className="text-sky-400 hover:text-sky-300">
            All accounts
          </Link>
          <Link href="/admin/users?role=EDITOR" className="text-sky-400 hover:text-sky-300">
            Editors
          </Link>
          <Link href="/admin/users/new" className="text-sky-400 hover:text-sky-300">
            Create an editor
          </Link>
          <Link href="/admin/catalog" className="text-sky-400 hover:text-sky-300">
            Catalog
          </Link>
        </div>
      </section>
    </AdminPage>
  );
}
