import Link from 'next/link';
import type { ReactElement } from 'react';

import { AttemptCountdown } from '../../../../components/attempt-countdown';
import { accuracyPercent, attemptResult, attemptState } from '../../../../lib/attempts-api';
import { loadSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly attemptId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Phase 7, A4: the result, minimal on purpose.
 *
 * A5 adds the per-question review; this page shows the score, the counts, the accuracy and how
 * the attempt ended, and never a question, an option, a correct answer or an explanation. The
 * API's result body carries the review for A5, and this page reads none of it: a field it does
 * not name never reaches the HTML or the RSC payload.
 *
 * The decimals are printed as the API sends them, and the percentage is a string operation, not
 * a float multiplication.
 */
export default async function AttemptResultPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { attemptId } = await params;
  const query = await searchParams;
  const session = await loadSession(`/attempt/result/${attemptId}`);
  const result = await attemptResult(session.accessToken, attemptId);

  // While the attempt runs, the page says so and shows the server's remaining time only.
  const running = result.status === 409 ? await attemptState(session.accessToken, attemptId) : null;
  const runningSeconds = running?.status === 200 ? (running.body?.remainingSeconds ?? 0) : 0;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Result</h1>
        </div>
        <nav className="flex flex-wrap gap-3 text-sm">
          <Link href="/tests" className="text-sky-400 hover:text-sky-300">
            Tests
          </Link>
          <Link href="/wallet" className="text-sky-400 hover:text-sky-300">
            Wallet
          </Link>
        </nav>
      </header>

      {result.status === 404 ? (
        <section
          data-testid="result-missing"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300"
        >
          <p>That result is not available. It may belong to another account, or the attempt may not exist.</p>
          <Link href="/tests" className="mt-3 inline-block text-sky-400 hover:text-sky-300">
            Back to your tests
          </Link>
        </section>
      ) : result.status === 409 ? (
        <section
          data-testid="result-in-progress"
          className="space-y-2 rounded-2xl border border-amber-900/60 bg-amber-950/20 p-6 text-sm text-amber-100"
        >
          <p>This attempt has not ended yet. Its result appears here once it is submitted or the deadline passes.</p>
          <p>
            Time remaining: <AttemptCountdown remainingSeconds={runningSeconds} />
          </p>
        </section>
      ) : result.status !== 200 || result.body === null ? (
        <section
          data-testid="result-unavailable"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300"
        >
          <p>The result could not be loaded. Please try again.</p>
        </section>
      ) : (
        <>
          {one(query.late) === '1' ? (
            <p
              role="status"
              data-testid="result-late"
              className="rounded-2xl border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-100"
            >
              Time ran out before your answers arrived. This attempt was evaluated automatically, without them.
            </p>
          ) : null}

          <section
            data-testid="attempt-result"
            className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6"
          >
            <p className="text-sm text-slate-400" data-testid="result-status">
              {result.body.status === 'SUBMITTED'
                ? 'Submitted by you'
                : result.body.status === 'AUTO_SUBMITTED'
                  ? 'Ended automatically at the deadline'
                  : result.body.status}
            </p>

            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Score</dt>
                <dd className="text-2xl font-semibold text-white" data-testid="result-score">
                  {result.body.score} <span className="text-sm text-slate-400">of {result.body.totalMarks}</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Accuracy</dt>
                <dd className="text-2xl font-semibold text-white" data-testid="result-accuracy">
                  {accuracyPercent(result.body.accuracy)}%
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Attempted</dt>
                <dd className="text-2xl font-semibold text-white" data-testid="result-attempted">
                  {String(result.body.attemptedCount)} of {String(result.body.totalQuestions)}
                </dd>
              </div>
            </dl>

            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-slate-500">Correct</dt>
                <dd className="text-slate-100" data-testid="result-correct">
                  {String(result.body.correctCount)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Wrong</dt>
                <dd className="text-slate-100" data-testid="result-wrong">
                  {String(result.body.wrongCount)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Unattempted</dt>
                <dd className="text-slate-100" data-testid="result-unattempted">
                  {String(result.body.unattemptedCount)}
                </dd>
              </div>
            </dl>
          </section>
        </>
      )}
    </main>
  );
}
