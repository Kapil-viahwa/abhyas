import Link from 'next/link';
import type { ReactElement } from 'react';

import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from '../../components/auth-shell';
import { csrfFromCookies, loadRoleSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Administrator area. The role check happens here, on the server, before a byte of the
 * page is sent: a student who types /admin lands back on their account page.
 */
export default async function AdminPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/admin', ['ADMIN']);
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-6 py-12">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Administration</p>
        <h1 className="text-2xl font-semibold text-white">Administrator area</h1>
        <p className="text-sm text-slate-400">
          {session.profile.fullName} · {session.profile.roleCode}
        </p>
      </header>

      <Notice message={params.role === 'changed' ? 'Role changed. That user was signed out everywhere.' : undefined} />
      <FieldError message={typeof params.error === 'string' ? params.error : undefined} />

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-slate-100">Change a role</h2>
        <p className="mt-1 text-sm text-slate-400">
          Every session held by that user ends immediately, so the new permissions take effect from the next sign-in.
        </p>

        <form action="/api/admin/role" method="post" className="mt-4 space-y-3">
          <input type="hidden" name="csrfToken" value={csrf} />

          <label className={labelClass}>
            User id
            <input className={inputClass} name="userId" type="text" required />
          </label>

          <label className={labelClass}>
            Role
            <select className={inputClass} name="roleCode" defaultValue="EDITOR">
              <option value="USER">USER</option>
              <option value="EDITOR">EDITOR</option>
              <option value="ADMIN">ADMIN</option>
            </select>
          </label>

          <button className={buttonClass} type="submit">
            Save role
          </button>
        </form>
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
