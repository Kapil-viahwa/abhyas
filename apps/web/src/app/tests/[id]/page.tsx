import { randomUUID } from 'node:crypto';

import Link from 'next/link';
import type { ReactElement } from 'react';

import { FieldError, Notice, buttonClass } from '../../../components/auth-shell';
import { csrfFromCookies, loadSession } from '../../../lib/session';
import { getStudentTest, myBalance, refusalCode, refusalMessage } from '../../../lib/student-tests-api';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-IN');
}

/**
 * One paper, its pattern, and the enroll button.
 *
 * The Idempotency-Key is generated once per render and carried in the form. A refused attempt
 * redirects back with the same key in the URL, so pressing the button again replays the first
 * request instead of writing a second debit; only a page reload with no key in the URL starts a
 * new one. The key is not a credential — it only names this intent.
 */
export default async function StudentTestPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { id } = await params;
  const session = await loadSession(`/tests/${id}`);
  const query = await searchParams;
  const csrf = await csrfFromCookies();

  const [test, balance] = await Promise.all([getStudentTest(session.accessToken, id), myBalance(session.accessToken)]);

  const errorCode = refusalCode({ code: one(query.error) });
  const key = one(query.key) === '' ? randomUUID() : one(query.key);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Mock tests</h1>
        </div>
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
      </header>

      {test === null ? (
        <section data-testid="test-missing" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300">
          <p>That test is not available. It may not be published, or it may no longer be sold.</p>
          <Link href="/tests" className="mt-3 inline-block text-sky-400 hover:text-sky-300">
            Back to the catalog
          </Link>
        </section>
      ) : (
        <>
          <div data-testid="enroll-notice">
            <Notice message={one(query.enrolled) === '1' ? 'Enrolled. Your attempt is ready in “Your tests”.' : undefined} />
          </div>
          {one(query.error) === '' ? null : (
            <div data-testid="enroll-error">
              <FieldError message={refusalMessage(errorCode)} />
            </div>
          )}

          <section data-testid="test-detail" className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-white">{test.title}</h2>
              <p className="text-sm text-slate-400">{test.exam.name}</p>
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Duration</dt>
                <dd className="text-slate-100" data-testid="test-duration">
                  {String(test.durationMinutes)} minutes
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Questions</dt>
                <dd className="text-slate-100" data-testid="test-questions">
                  {String(test.questionCount)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Marks</dt>
                <dd className="text-slate-100">{test.totalMarks} in total · {test.marksPerQuestion} each</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Negative marking</dt>
                <dd className="text-slate-100">−{test.negativeMarksPerQuestion} per wrong answer</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Cost</dt>
                <dd className="text-slate-100" data-testid="test-cost">
                  {formatNumber(test.cost)} coins
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Attempts</dt>
                <dd className="text-slate-100">
                  {String(test.enrollment.attemptsUsed)} used
                  {test.maxAttempts === null ? ' · unlimited' : ` of ${String(test.maxAttempts)}`}
                </dd>
              </div>
            </dl>

            {balance === null ? null : (
              <p className="text-sm text-slate-400">
                Your balance: <span className="text-slate-100" data-testid="student-balance">{formatNumber(balance)}</span> coins
              </p>
            )}
          </section>

          <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Your attempt</h2>

            {test.enrollment.status === 'OPEN' ? (
              <p className="text-sm text-sky-200" data-testid="open-enrollment">
                You have an open attempt at this test (attempt {String(test.enrollment.attemptNumber ?? 1)}). Taking it is
                the next phase; it will appear here when it starts.
              </p>
            ) : test.maxAttempts !== null && test.enrollment.attemptsUsed >= test.maxAttempts ? (
              <p className="text-sm text-slate-300" data-testid="attempts-used">
                You have used every attempt this test allows ({String(test.maxAttempts)}).
              </p>
            ) : (
              <form action="/api/enrollments/enroll" method="post" className="space-y-3">
                <input type="hidden" name="csrfToken" value={csrf} />
                <input type="hidden" name="testId" value={test.id} />
                <input type="hidden" name="idempotencyKey" value={key} />
                <button type="submit" className={buttonClass} data-testid="enroll-button">
                  Enroll for {formatNumber(test.cost)} coins
                </button>
                <p className="text-xs text-slate-500">
                  One attempt of this paper. Pressing the button twice charges once — the form carries one key.
                </p>
              </form>
            )}
          </section>
        </>
      )}
    </main>
  );
}
