import Link from 'next/link';
import type { ReactElement } from 'react';

import { Notice } from '../../components/auth-shell';
import { loadSession } from '../../lib/session';
import {
  enrollmentLabel,
  listMyEnrollments,
  listStudentTests,
  type EnrollmentView,
  type StudentTestView,
} from '../../lib/student-tests-api';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Anything but a positive page number is page 1, so a hand-edited URL cannot throw. */
function pageNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : 1;
}

function StudentNav(): ReactElement {
  return (
    <nav className="flex flex-wrap gap-3 text-sm">
      <Link href="/account" className="text-sky-400 hover:text-sky-300">
        Account
      </Link>
      <Link href="/wallet" className="text-sky-400 hover:text-sky-300">
        Wallet
      </Link>
      <Link href="/tests" className="text-slate-200">
        Tests
      </Link>
    </nav>
  );
}

/**
 * The student catalog: the papers on sale, and the ones this student has bought.
 *
 * The account is the session's — there is no id in the URL, and the API has none either. The
 * answer is a whitelist of summary fields, so no question, option, answer key or creator can
 * reach this page even by accident.
 */
export default async function StudentTestsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadSession('/tests');
  const params = await searchParams;
  const page = pageNumber(one(params.page));

  const [catalog, enrollments] = await Promise.all([
    listStudentTests(session.accessToken, page),
    listMyEnrollments(session.accessToken, 1),
  ]);

  const items = catalog?.items ?? [];
  const mine: readonly EnrollmentView[] = enrollments?.items ?? [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Mock tests</h1>
          <p className="text-sm text-slate-400">{session.profile.fullName}</p>
        </div>
        <StudentNav />
      </header>

      <Notice message={one(params.enrolled) === '1' ? 'Enrolled. Your attempt is ready in “Your tests”.' : undefined} />

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-slate-100">Your tests</h2>

        {enrollments === null ? (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
            Your enrollments could not be loaded.
          </p>
        ) : null}

        <ul data-testid="enrollment-list" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
          {mine.map((enrollment) => (
            <li key={enrollment.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="enrollment-row">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium text-slate-100">{enrollment.test.title}</p>
                <p className="text-xs text-slate-500">
                  attempt {String(enrollment.attemptNumber)} · {String(enrollment.test.durationMinutes)} min ·{' '}
                  {String(enrollment.test.questionCount)} question(s) · paid {String(enrollment.cost)} coins
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={
                    enrollment.status === 'OPEN'
                      ? 'rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300 ring-1 ring-sky-500/30'
                      : 'rounded-full bg-slate-500/10 px-2 py-0.5 text-xs text-slate-300 ring-1 ring-slate-500/30'
                  }
                  data-testid="enrollment-status"
                >
                  {enrollment.status.toLowerCase()}
                </span>
                <Link href={`/tests/${enrollment.testId}`} className="text-sm text-sky-400 hover:text-sky-300">
                  Open
                </Link>
              </div>
            </li>
          ))}

          {enrollments !== null && mine.length === 0 ? (
            <li className="p-4 text-sm text-slate-400">No attempt yet. Pick a paper below to start one.</li>
          ) : null}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-slate-100">Available papers</h2>

        {catalog === null ? (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
            The catalog could not be loaded.
          </p>
        ) : (
          <p className="text-sm text-slate-400" data-testid="student-test-count">
            {catalog.total === 0
              ? 'No test is published yet.'
              : `${String(catalog.total)} paper(s), page ${String(catalog.page)} of ${String(catalog.pages)}`}
          </p>
        )}

        <ul data-testid="student-test-list" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
          {items.map((test: StudentTestView) => (
            <li key={test.id} className="flex flex-wrap items-start justify-between gap-3 p-4" data-testid="student-test">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium text-slate-100">{test.title}</p>
                <p className="text-xs text-slate-500">{test.exam.name}</p>
                <p className="text-xs text-slate-500">
                  {String(test.durationMinutes)} min · {String(test.questionCount)} question(s) · {test.totalMarks} marks ·{' '}
                  −{test.negativeMarksPerQuestion} per wrong answer · {String(test.cost)} coins
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-400" data-testid="student-test-state">
                  {enrollmentLabel(test.enrollment)}
                  {test.maxAttempts === null ? '' : ` · ${String(test.enrollment.attemptsUsed)} of ${String(test.maxAttempts)}`}
                </span>
                <Link
                  href={`/tests/${test.id}`}
                  className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-200"
                  data-testid="student-test-open"
                >
                  View
                </Link>
              </div>
            </li>
          ))}

          {catalog !== null && items.length === 0 ? (
            <li className="p-4 text-sm text-slate-400">
              No published paper yet. An Administrator publishes each test before it appears here.
            </li>
          ) : null}
        </ul>

        {catalog !== null && catalog.pages > 1 ? (
          <nav className="flex items-center justify-between text-sm">
            {catalog.page > 1 ? (
              <Link href={`/tests?page=${String(catalog.page - 1)}`} className="text-sky-400 hover:text-sky-300">
                Previous
              </Link>
            ) : (
              <span className="text-slate-600">Previous</span>
            )}
            <span className="text-slate-500">
              Page {String(catalog.page)} of {String(catalog.pages)}
            </span>
            {catalog.page < catalog.pages ? (
              <Link href={`/tests?page=${String(catalog.page + 1)}`} className="text-sky-400 hover:text-sky-300">
                Next
              </Link>
            ) : (
              <span className="text-slate-600">Next</span>
            )}
          </nav>
        ) : null}
      </section>
    </main>
  );
}
