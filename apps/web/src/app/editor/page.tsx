import Link from 'next/link';
import type { ReactElement } from 'react';

import { secondaryButtonClass } from '../../components/auth-shell';
import { csrfFromCookies, loadRoleSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Editor area. Content tools arrive with the authoring phase; what exists now is the
 * server-side gate: a student cannot see this page at all, and an administrator can.
 */
export default async function EditorPage(): Promise<ReactElement> {
  const session = await loadRoleSession('/editor', ['EDITOR', 'ADMIN']);
  const csrf = await csrfFromCookies();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-6 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Content</p>
        <h1 className="text-2xl font-semibold text-white">Editor area</h1>
        <p className="text-sm text-slate-400">
          {session.profile.fullName} · {session.profile.roleCode}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-slate-100">Question authoring</h2>
        <p className="mt-1 text-sm text-slate-400">
          The catalog is live: categories, exams, subjects and topics, and the public pages built from them.
        </p>
        <p className="mt-3 text-sm">
          <Link href="/editor/catalog" className="text-sky-400 hover:text-sky-300">
            Open the catalog
          </Link>
        </p>
        {session.profile.permissions.includes('tests.read') ? (
          <p className="mt-3 text-sm">
            <Link href="/editor/tests" className="text-sky-400 hover:text-sky-300">
              Open the tests
            </Link>
          </p>
        ) : null}
        <p className="mt-3 text-xs text-slate-500">Permissions: {session.profile.permissions.join(', ') || 'none'}</p>
      </section>

      <div className="flex gap-4 text-sm">
        <Link href="/account" className="text-sky-400 hover:text-sky-300">
          Your account
        </Link>
        <form action="/api/auth/logout" method="post">
          <input type="hidden" name="csrfToken" value={csrf} />
          <button className={secondaryButtonClass} type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
