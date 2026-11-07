import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../components/admin-shell';
import { csrfFromCookies, loadPermissionSession } from '../../../lib/session';
import { listTests, statusTone, TEST_STATUSES, type TestView } from '../../../lib/tests-api';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function StatusBadge({ status }: { readonly status: string }): ReactElement {
  return (
    <span data-testid="test-status" className={`rounded-full px-2 py-0.5 text-xs ring-1 ${statusTone(status)}`}>
      {status.toLowerCase()}
    </span>
  );
}

/**
 * The papers this account may see: an editor's own, an administrator's all.
 *
 * Reading needs `tests.read`, which the editor role carries; the "New test" control renders
 * only for `tests.write` and the review queue only for `tests.publish`, and the API refuses
 * both regardless of what this page draws (decision 0069).
 */
export default async function TestsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadPermissionSession('/editor/tests', 'tests.read');
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  const status = single(params.status);
  const page = Number.parseInt(single(params.page), 10) || 1;
  const result = await listTests(session.accessToken, { status, page });

  const canWrite = session.profile.permissions.includes('tests.write');
  const canPublish = session.profile.permissions.includes('tests.publish');

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/editor/tests"
      title="Tests"
      subtitle="Drafts you assemble from the question bank. Only an Administrator publishes or archives one."
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-slate-300">
            Status
            <select
              name="status"
              defaultValue={status}
              className="ml-2 rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm"
            >
              <option value="">Any status</option>
              {TEST_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {value.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200">
            Filter
          </button>
        </form>

        <div className="flex flex-wrap gap-2 text-sm">
          {canWrite ? (
            <Link
              href="/editor/tests/new"
              className="rounded-xl bg-sky-600 px-3 py-2 font-medium text-white"
              data-testid="new-test"
            >
              New test
            </Link>
          ) : null}
          {canPublish ? (
            <Link href="/admin/tests" className="rounded-xl border border-slate-700 px-3 py-2 text-slate-200">
              Review queue
            </Link>
          ) : null}
        </div>
      </div>

      {single(params.error) !== '' ? (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
          {single(params.error)}
        </p>
      ) : null}

      <p className="text-sm text-slate-400" data-testid="test-count">
        {result === null
          ? 'The list could not be loaded.'
          : `${String(result.total)} test(s), page ${String(result.page)} of ${String(result.pages)}`}
      </p>

      <ul data-testid="test-list" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
        {(result?.items ?? []).map((test: TestView) => (
          <li key={test.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium text-slate-100">{test.title}</p>
              <p className="text-xs text-slate-500">
                v{String(test.currentVersion)} · {String(test.version.durationMinutes)} min ·{' '}
                {String(test.version.questionCount)} question(s) · {test.version.totalMarks} marks
                {test.publishedVersion === null ? '' : ` · live v${String(test.publishedVersion.version)}`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge status={test.status} />
              <Link href={`/editor/tests/${test.id}`} className="text-sm text-sky-400 hover:text-sky-300">
                Open
              </Link>
            </div>
          </li>
        ))}

        {result !== null && result.items.length === 0 ? (
          <li className="p-4 text-sm text-slate-400">No test yet. A draft is the first step.</li>
        ) : null}
      </ul>

      {result !== null && result.pages > 1 ? (
        <nav className="flex gap-2 text-sm text-slate-300">
          {Array.from({ length: result.pages }, (_, index) => index + 1).map((value) => (
            <Link
              key={value}
              href={`/editor/tests?page=${String(value)}${status === '' ? '' : `&status=${status}`}`}
              className={value === result.page ? 'font-semibold text-sky-400' : ''}
            >
              {value}
            </Link>
          ))}
        </nav>
      ) : null}
    </AdminPage>
  );
}
