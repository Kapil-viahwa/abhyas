import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../../components/admin-shell';
import { FieldError, inputClass, labelClass } from '../../../../components/auth-shell';
import { catalogChoices } from '../../../../lib/questions-api';
import { csrfFromCookies, loadPermissionSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Start a paper: which exam it belongs to and what it is called.
 *
 * The pattern (duration, marks, negative marking, attempt cap) is set on the builder page,
 * because it can change until the paper is submitted. Creating needs `tests.write`, and the
 * API refuses an exam this account may not write content for.
 */
export default async function NewTestPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadPermissionSession('/editor/tests/new', 'tests.write');
  const csrf = await csrfFromCookies();
  const params = await searchParams;
  const catalog = await catalogChoices(session.accessToken);

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/editor/tests"
      title="New test"
      subtitle="Choose the exam this paper belongs to. Its questions must come from the same exam."
    >
      <FieldError message={single(params.error) === '' ? undefined : single(params.error)} />

      {catalog.exams.length === 0 ? (
        <p className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-200">
          Create an exam in the catalog first: a paper belongs to one, and its questions must too.
        </p>
      ) : (
        <form action="/api/editor/tests/create" method="post" className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
          <input type="hidden" name="csrfToken" value={csrf} />

          <label className={labelClass}>
            Title
            <input className={inputClass} name="title" defaultValue={single(params.title)} required maxLength={200} data-testid="new-test-title" />
          </label>

          <label className={labelClass}>
            Exam
            <select className={inputClass} name="examId" defaultValue={single(params.examId)} required data-testid="new-test-exam">
              <option value="">Choose an exam</option>
              {catalog.exams.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.name}
                </option>
              ))}
            </select>
          </label>

          <label className={labelClass}>
            Duration in minutes
            <input
              className={inputClass}
              name="durationMinutes"
              type="number"
              min={1}
              max={600}
              defaultValue={single(params.durationMinutes) === '' ? '60' : single(params.durationMinutes)}
              data-testid="new-test-duration"
            />
          </label>

          <div className="flex flex-wrap gap-3">
            <button type="submit" className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400">
              Create draft
            </button>
            <Link href="/editor/tests" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200">
              Cancel
            </Link>
          </div>
        </form>
      )}
    </AdminPage>
  );
}
