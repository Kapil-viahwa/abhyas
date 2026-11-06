import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../components/admin-shell';
import { csrfFromCookies, loadPermissionSession } from '../../../lib/session';
import { listTests, statusTone } from '../../../lib/tests-api';

export const dynamic = 'force-dynamic';

/**
 * The Administrator's review queue: every paper, whatever its editor, with the ones waiting
 * on a decision first in the eye. The publish and archive controls themselves live on the
 * builder page and render only for `tests.publish`, which is an Administrator's alone.
 */
export default async function AdminTestsPage(): Promise<ReactElement> {
  const session = await loadPermissionSession('/admin/tests', 'tests.publish');
  const csrf = await csrfFromCookies();
  const result = await listTests(session.accessToken, { page: 1 });

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/admin/tests"
      title="Test review"
      subtitle="Every paper. Open one to publish a submitted paper, publish a revision, or archive a live test."
    >
      <p className="text-sm text-slate-400" data-testid="admin-test-count">
        {result === null
          ? 'The list could not be loaded.'
          : `${String(result.total)} test(s), page ${String(result.page)} of ${String(result.pages)}`}
      </p>

      <ul data-testid="admin-test-list" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
        {(result?.items ?? []).map((test) => (
          <li key={test.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium text-slate-100">{test.title}</p>
              <p className="text-xs text-slate-500">
                v{String(test.currentVersion)} · {String(test.version.questionCount)} question(s)
                {test.submittedAt === null ? '' : ' · handed over for review'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span data-testid="admin-test-status" className={`rounded-full px-2 py-0.5 text-xs ring-1 ${statusTone(test.status)}`}>
                {test.status.toLowerCase()}
              </span>
              <Link href={`/editor/tests/${test.id}`} className="text-sm text-sky-400 hover:text-sky-300">
                Review
              </Link>
            </div>
          </li>
        ))}

        {result !== null && result.items.length === 0 ? (
          <li className="p-4 text-sm text-slate-400">No paper has been submitted yet.</li>
        ) : null}
      </ul>
    </AdminPage>
  );
}
