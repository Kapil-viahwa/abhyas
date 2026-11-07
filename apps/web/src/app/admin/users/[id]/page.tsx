import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage, StatusBadge } from '../../../../components/admin-shell';
import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from '../../../../components/auth-shell';
import { flagLabels, getUser } from '../../../../lib/admin-api';
import { csrfFromCookies, loadRoleSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

export default async function AdminUserDetailPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { id } = await params;
  const session = await loadRoleSession(`/admin/users/${id}`, ['ADMIN']);
  const csrf = await csrfFromCookies();
  const user = await getUser(session.accessToken, id);

  if (user === null) {
    notFound();
  }

  const query = await searchParams;
  const flags = flagLabels(user.editorFlags);
  const notices = [
    single(query.created) === '1' ? 'Editor created. They can sign in with the password you set.' : undefined,
    single(query.flags) === 'saved' ? 'Capabilities saved. That editor was signed out everywhere.' : undefined,
    single(query.status) === 'saved' ? 'Status saved. Sessions were ended if the account left the active state.' : undefined,
    single(query.role) === 'changed' ? 'Role changed. That user was signed out everywhere.' : undefined,
  ].filter((notice): notice is string => notice !== undefined);

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/admin/users"
      title={user.email ?? user.fullName}
      subtitle={`${user.fullName} · ${user.roleCode}`}
    >
      {notices.map((notice) => (
        <Notice key={notice} message={notice} />
      ))}
      <FieldError message={single(query.error) === '' ? undefined : single(query.error)} />

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-slate-100">Account</h2>
          <StatusBadge status={user.status} />
        </div>

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Role</dt>
            <dd className="text-slate-200">{user.roleCode}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Email verified</dt>
            <dd className="text-slate-200">{user.emailVerifiedAt === null ? 'No' : 'Yes'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Live sessions</dt>
            <dd className="text-slate-200">{user.activeSessions}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Editor capability</dt>
            <dd className="text-slate-200">
              {user.roleCode !== 'EDITOR' ? 'Not an editor' : flags.length === 0 ? 'None' : flags.join(', ')}
            </dd>
          </div>
        </dl>

        <form action={`/api/admin/users/${user.id}/status`} method="post" className="mt-5 flex flex-wrap gap-2">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="userId" value={user.id} />
          <button className={secondaryButtonClass} name="status" value="ACTIVE" type="submit">
            Activate
          </button>
          <button className={secondaryButtonClass} name="status" value="SUSPENDED" type="submit">
            Suspend
          </button>
          <button className={secondaryButtonClass} name="status" value="DISABLED" type="submit">
            Deactivate
          </button>
        </form>
      </section>

      {user.roleCode === 'EDITOR' ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
          <h2 className="text-lg font-medium text-slate-100">Editor capability</h2>
          <p className="mt-1 text-sm text-slate-400">
            A box that is not ticked is not granted. Saving ends this editor&apos;s sessions, so the new set applies
            from their next sign-in.
          </p>

          <form action={`/api/admin/users/${user.id}/flags`} method="post" className="mt-4 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />
            <input type="hidden" name="userId" value={user.id} />

            <label className="flex items-start gap-3 text-sm text-slate-300">
              <input className="mt-1" type="checkbox" name="manage_questions" value="on" defaultChecked={user.editorFlags.manage_questions} />
              Manage questions
            </label>
            <label className="flex items-start gap-3 text-sm text-slate-300">
              <input className="mt-1" type="checkbox" name="manage_tests" value="on" defaultChecked={user.editorFlags.manage_tests} />
              Manage tests
            </label>

            <button className={buttonClass} type="submit">
              Save capabilities
            </button>
          </form>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <h2 className="text-lg font-medium text-slate-100">Role</h2>
        <p className="mt-1 text-sm text-slate-400">
          Changing a role ends every session this person holds. Demoting an editor also clears the capabilities the
          editor role justified.
        </p>

        <form action="/api/admin/role" method="post" className="mt-4 space-y-3">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="userId" value={user.id} />

          <label className={labelClass}>
            New role
            <select className={inputClass} name="roleCode" defaultValue={user.roleCode}>
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

      <div className="text-sm">
        <Link href="/admin/users" className="text-sky-400 hover:text-sky-300">
          Back to accounts
        </Link>
      </div>
    </AdminPage>
  );
}
