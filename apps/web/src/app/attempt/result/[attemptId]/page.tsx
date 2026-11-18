import Link from 'next/link';
import type { ReactElement } from 'react';

import { AttemptCountdown } from '../../../../components/attempt-countdown';
import { StudentNav } from '../../../../components/student-shell';
import { accuracyPercent, attemptResult, attemptState, type ReviewQuestion } from '../../../../lib/attempts-api';
import { renderLatex } from '../../../../lib/latex';
import { loadSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly attemptId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'wrong', label: 'Wrong' },
  { value: 'unattempted', label: 'Unattempted' },
] as const;

type ReviewFilter = (typeof FILTERS)[number]['value'];
type Outcome = 'correct' | 'wrong' | 'unattempted';

const OUTCOME_LABEL: Record<Outcome, string> = {
  correct: 'Correct ✓',
  wrong: 'Wrong ✗',
  unattempted: 'Not attempted —',
};

function one(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The filter is an allowlist, so a hand-edited URL can never widen what is shown. */
function filterFrom(value: string): ReviewFilter {
  return FILTERS.find((entry) => entry.value === value)?.value ?? 'all';
}

function outcomeOf(question: ReviewQuestion): Outcome {
  if (question.chosenOptionId === null) {
    return 'unattempted';
  }

  return question.chosenOptionId === question.correctOptionId ? 'correct' : 'wrong';
}

/** What one question earned or lost, from the API's own decimal strings and nothing else. */
function marksText(question: ReviewQuestion, outcome: Outcome): string {
  if (outcome === 'correct') {
    return `+${question.marks}`;
  }
  if (outcome === 'wrong') {
    return `−${question.negativeMarks}`;
  }

  return '0';
}

function ReviewCard({ question }: { readonly question: ReviewQuestion }): ReactElement {
  const outcome = outcomeOf(question);

  return (
    <article
      id={`question-${String(question.position)}`}
      data-testid="review-question"
      data-outcome={outcome}
      className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-white">Question {String(question.position)}</h3>
        <p className="text-xs text-slate-400">
          <span
            data-testid="review-marks"
            className={
              outcome === 'correct'
                ? 'font-mono text-sm text-emerald-300'
                : outcome === 'wrong'
                  ? 'font-mono text-sm text-rose-300'
                  : 'font-mono text-sm text-slate-300'
            }
          >
            {marksText(question, outcome)}
          </span>{' '}
          marks
        </p>
      </div>

      <p
        data-testid="review-outcome"
        className={
          outcome === 'correct'
            ? 'text-sm font-medium text-emerald-300'
            : outcome === 'wrong'
              ? 'text-sm font-medium text-rose-300'
              : 'text-sm font-medium text-slate-400'
        }
      >
        {OUTCOME_LABEL[outcome]}
      </p>

      {/* The API serves this through `sanitizeStoredContent`; the page never reads raw content. */}
      <div className="text-sm leading-relaxed text-slate-100" dangerouslySetInnerHTML={{ __html: question.contentHtml }} />
      {question.latex === null ? null : (
        // LaTeX is not HTML: KaTeX renders it with `trust: false` and escapes what it cannot render.
        <div className="text-sm text-slate-100" dangerouslySetInnerHTML={{ __html: renderLatex(question.latex) }} />
      )}

      <ol className="space-y-2">
        {question.options.map((option) => {
          const wrongChoice = option.isChosen && !option.isCorrect;

          return (
            <li
              key={option.id}
              data-testid="review-option"
              data-correct={option.isCorrect ? 'true' : 'false'}
              data-chosen={option.isChosen ? 'true' : 'false'}
              className={`space-y-1 rounded-xl border px-3 py-2 text-sm ${
                option.isCorrect
                  ? 'border-emerald-700 bg-emerald-950/30 text-emerald-50'
                  : wrongChoice
                    ? 'border-rose-800 bg-rose-950/20 text-rose-50'
                    : 'border-slate-700 text-slate-200'
              }`}
            >
              <span className="block" dangerouslySetInnerHTML={{ __html: option.optionHtml }} />
              {option.latex === null ? null : (
                <span className="block" dangerouslySetInnerHTML={{ __html: renderLatex(option.latex) }} />
              )}
              {option.isChosen || option.isCorrect ? (
                <span className="flex flex-wrap gap-2 pt-1 text-xs">
                  {option.isChosen ? (
                    <span data-testid="review-your-answer" className="rounded-full bg-slate-700/60 px-2 py-0.5 text-slate-100">
                      Your answer
                    </span>
                  ) : null}
                  {option.isCorrect ? (
                    <span
                      data-testid="review-correct-answer"
                      className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-200"
                    >
                      Correct answer
                    </span>
                  ) : null}
                  {wrongChoice ? (
                    <span data-testid="review-wrong-answer" className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-200">
                      Your answer was wrong
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>

      {outcome === 'unattempted' ? (
        <p data-testid="review-unattempted" className="text-xs text-slate-400">
          You did not answer this question.
        </p>
      ) : null}

      {question.explanationHtml === null ? null : (
        <div className="space-y-1 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Explanation</p>
          <div
            data-testid="review-explanation"
            className="text-sm leading-relaxed text-slate-200"
            dangerouslySetInnerHTML={{ __html: question.explanationHtml }}
          />
        </div>
      )}
    </article>
  );
}

/**
 * Phase 7, A5: the result and the per-question review.
 *
 * This is the only page a student ever sees the answer key on. It is a server component: the
 * result, the key and the explanations are read on the server with the session's token, the
 * review is filtered on the server through a validated `?show=` value, and the only things that
 * reach the browser are the rendered HTML of this ended attempt. `next.config.ts` adds
 * `Cache-Control: no-store` to this route, and nothing here logs or stores the review.
 *
 * While the attempt runs the page shows the in-progress message and the countdown and no data;
 * an unknown or another student's attempt gets the same not-available screen as everywhere else.
 */
export default async function AttemptResultPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { attemptId } = await params;
  const query = await searchParams;
  const session = await loadSession(`/attempt/result/${attemptId}`);
  const result = await attemptResult(session.accessToken, attemptId);

  // While the attempt runs, the page says so and shows the server's remaining time only.
  const running = result.status === 409 ? await attemptState(session.accessToken, attemptId) : null;
  const runningSeconds = running?.status === 200 ? (running.body?.remainingSeconds ?? 0) : 0;

  const filter = filterFrom(one(query.show));
  const lateQuery = one(query.late) === '1' ? '&late=1' : '';

  // An unexpected shape renders an empty review rather than throwing inside the page.
  const loaded = result.status === 200 ? result.body : null;
  const review: readonly ReviewQuestion[] =
    loaded !== null && Array.isArray(loaded.review) ? loaded.review : [];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Result</h1>
        </div>
        <StudentNav current="/tests" />
      </header>

      {result.status === 404 || result.status === 400 ? (
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
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-white" data-testid="result-test-title">
                {result.body.testTitle ?? 'Attempt result'}
              </h2>
              <p className="text-sm text-slate-400" data-testid="result-status">
                {result.body.status === 'SUBMITTED'
                  ? 'Submitted by you'
                  : result.body.status === 'AUTO_SUBMITTED'
                    ? 'Ended automatically at the deadline'
                    : result.body.status}
              </p>
            </div>

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

            {result.body.status === 'AUTO_SUBMITTED' ? (
              <p
                data-testid="result-auto-note"
                className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-3 text-sm text-amber-100"
              >
                Time ran out before this attempt was submitted, so it was evaluated automatically. Only answers
                sent before the deadline count.
                {result.body.attemptedCount === 0
                  ? ' No answers were received, so every question is marked unattempted — that is the deadline, not a mistake you made.'
                  : ''}
              </p>
            ) : null}

            <p className="text-sm">
              <Link href="/tests" className="text-sky-400 hover:text-sky-300">
                Back to your tests
              </Link>
            </p>
          </section>

          <section data-testid="result-retake" className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Take it again</h2>
            <p className="text-sm text-slate-300">
              A retake needs a new enrollment — and a new fee.
            </p>
            {result.body.testId === null ? null : (
              <Link
                href={`/tests/${result.body.testId}`}
                className="inline-block min-h-11 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
                data-testid="result-retake-link"
              >
                Take this test again
              </Link>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-medium text-slate-100">Your answers</h2>
              <p className="text-xs text-slate-400" data-testid="review-count">
                {String(review.length)} question(s) on this paper
              </p>
            </div>

            <nav data-testid="review-filter" className="flex flex-wrap gap-2" aria-label="Review filter">
              {FILTERS.map((entry) => (
                <Link
                  key={entry.value}
                  href={`/attempt/result/${attemptId}?show=${entry.value}${lateQuery}`}
                  aria-current={filter === entry.value ? 'page' : undefined}
                  data-testid={`review-filter-${entry.value}`}
                  className={`flex min-h-11 items-center rounded-lg border px-3 text-sm ${
                    filter === entry.value
                      ? 'border-sky-500 bg-sky-950/40 text-white'
                      : 'border-slate-700 text-slate-200'
                  }`}
                >
                  {entry.label}
                </Link>
              ))}
            </nav>

            <ol data-testid="review-jump" className="flex flex-wrap gap-2" aria-label="Jump to a question">
              {review.map((question) => {
                const outcome = outcomeOf(question);

                return (
                  <li key={question.questionId}>
                    <a
                      href={`#question-${String(question.position)}`}
                      aria-label={`Question ${String(question.position)}, ${outcome}`}
                      data-testid="review-jump-link"
                      className={`flex h-11 w-11 items-center justify-center rounded-lg border text-sm ${
                        outcome === 'correct'
                          ? 'border-emerald-700 text-emerald-200'
                          : outcome === 'wrong'
                            ? 'border-rose-800 text-rose-200'
                            : 'border-slate-700 text-slate-300'
                      }`}
                    >
                      {String(question.position)}
                    </a>
                  </li>
                );
              })}
            </ol>

            {review.filter((question) => (filter === 'all' ? true : outcomeOf(question) === filter)).length ===
            0 ? (
              <p data-testid="review-empty" className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
                No question matches that filter.
              </p>
            ) : (
              <div className="space-y-3">
                {review
                  .filter((question) => (filter === 'all' ? true : outcomeOf(question) === filter))
                  .map((question) => (
                    <ReviewCard key={question.questionId} question={question} />
                  ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
