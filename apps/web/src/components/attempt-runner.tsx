'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import type { AttemptStart, AttemptState, PaperOption, PaperQuestion } from '../lib/attempts-api';
import { formatCountdown } from '../lib/countdown';
import { renderLatex } from '../lib/latex';

/**
 * Phase 7, A4: the paper on screen.
 *
 * The paper and the answers exist only in this component's memory: they are never written to
 * localStorage, sessionStorage, IndexedDB, a cookie, the URL or the console. A reload loses
 * them, and the server will not deliver them again — that is the owner's no-resume rule.
 *
 * The countdown only displays time. One offset from the start response's `serverNow` gives a
 * monotonic deadline (`performance.now()`), and every re-sync replaces it with the server's
 * remaining seconds, so a changed device clock cannot move the attempt and the server's answer
 * always wins over the browser's.
 */

export interface AttemptSummary {
  readonly title: string;
  readonly durationMinutes: number;
  readonly questionCount: number;
  readonly totalMarks: string;
  readonly marksPerQuestion: string;
  readonly negativeMarksPerQuestion: string;
  readonly cost: number;
}

interface RunnerProps {
  readonly enrollmentId: string;
  readonly csrfToken: string;
  readonly summary: AttemptSummary;
  readonly attempt: AttemptState | null;
}

/** How often the page asks the server for the remaining time. */
const RESYNC_INTERVAL_MS = 30_000;

/** Delays before each automatic retry of the same submit: never faster than every two seconds. */
const AUTO_SUBMIT_RETRY_DELAYS_MS = [2_000, 4_000, 6_000];

const GENERIC_START_ERROR = 'This attempt could not be started. Please try again.';
const GENERIC_SUBMIT_ERROR = 'Your answers could not be submitted. Please submit again.';
const LOST_START_ERROR =
  'The start of this attempt could not be confirmed, and starting again would not help: the paper is delivered once.';
const UNREADABLE_PAPER_ERROR =
  'This attempt has started, but its paper could not be read. It will end automatically at the deadline.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A state body, or `null` when it is not one: an unexpected shape renders an error, never throws. */
function readState(value: unknown): AttemptState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.attemptId !== 'string' || typeof value.status !== 'string') {
    return null;
  }

  const remaining =
    typeof value.remainingSeconds === 'number' && Number.isFinite(value.remainingSeconds)
      ? Math.max(0, Math.floor(value.remainingSeconds))
      : 0;

  return {
    attemptId: value.attemptId,
    status: value.status,
    startedAt: text(value.startedAt),
    deadlineAt: text(value.deadlineAt),
    serverNow: text(value.serverNow),
    remainingSeconds: remaining,
    submittedAt: nullableText(value.submittedAt),
    submitSource: nullableText(value.submitSource),
  };
}

function readOption(value: unknown): PaperOption | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.position !== 'number') {
    return null;
  }

  return {
    id: value.id,
    position: value.position,
    optionHtml: text(value.optionHtml),
    latex: nullableText(value.latex),
  };
}

function readQuestion(value: unknown): PaperQuestion | null {
  if (!isRecord(value) || typeof value.questionId !== 'string' || typeof value.position !== 'number') {
    return null;
  }
  if (!Array.isArray(value.options)) {
    return null;
  }

  const options: PaperOption[] = [];
  for (const entry of value.options) {
    const option = readOption(entry);
    if (option === null) {
      return null;
    }
    options.push(option);
  }
  if (options.length === 0) {
    return null;
  }

  return {
    questionId: value.questionId,
    position: value.position,
    questionType: text(value.questionType),
    contentHtml: text(value.contentHtml),
    latex: nullableText(value.latex),
    marks: text(value.marks),
    negativeMarks: text(value.negativeMarks),
    options,
  };
}

/** The start response, or `null` when it is not the shape the API promises. */
function readStart(value: unknown): AttemptStart | null {
  const state = readState(value);
  if (state === null || !isRecord(value) || !Array.isArray(value.questions)) {
    return null;
  }

  const questions: PaperQuestion[] = [];
  for (const entry of value.questions) {
    const question = readQuestion(entry);
    if (question === null) {
      return null;
    }
    questions.push(question);
  }
  if (questions.length === 0) {
    return null;
  }

  return { ...state, questions };
}

/** `{ attempt }` from the enrollment route; `null` when the body is not one. */
function readEnvelope(value: unknown): { readonly attempt: AttemptState | null } | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.attempt === null || value.attempt === undefined) {
    return { attempt: null };
  }

  const attempt = readState(value.attempt);
  return attempt === null ? null : { attempt };
}

/** The answers the page holds, and nothing else: no account, no timestamp, no attempt id. */
function answerForm(csrfToken: string, answers: Record<string, string>): FormData {
  const form = new FormData();
  form.set('csrfToken', csrfToken);
  form.set(
    'answers',
    JSON.stringify(Object.entries(answers).map(([questionId, chosenOptionId]) => ({ questionId, chosenOptionId }))),
  );

  return form;
}

export function AttemptRunner({ enrollmentId, csrfToken, summary, attempt }: RunnerProps): ReactElement {
  const router = useRouter();
  const [paper, setPaper] = useState<AttemptStart | null>(null);
  const [state, setState] = useState<AttemptState | null>(attempt);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(attempt?.remainingSeconds ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const deadlineMono = useRef<number>(0);
  const paperRef = useRef<AttemptStart | null>(null);
  const answersRef = useRef<Record<string, string>>({});
  const stateRef = useRef<AttemptState | null>(attempt);
  const startingRef = useRef(false);
  const submittingRef = useRef(false);
  const settledRef = useRef(false);
  const resyncedAtZeroRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const attemptId = paper?.attemptId ?? state?.attemptId ?? null;

  const goResult = useCallback(
    (id: string, late = false): void => {
      settledRef.current = true;
      router.push(`/attempt/result/${encodeURIComponent(id)}${late ? '?late=1' : ''}`);
    },
    [router],
  );

  const sendToSignIn = useCallback((): void => {
    router.push(`/login?next=${encodeURIComponent(`/attempt/${enrollmentId}`)}`);
  }, [enrollmentId, router]);

  /** The server's remaining time always wins; if the attempt has ended, leave for the result. */
  const applyState = useCallback((next: AttemptState): void => {
    stateRef.current = next;
    setState(next);
    setRemaining(next.remainingSeconds);
    if (next.status === 'IN_PROGRESS') {
      deadlineMono.current = performance.now() + next.remainingSeconds * 1000;
    }
  }, []);

  const resync = useCallback(async (): Promise<void> => {
    const id = paperRef.current?.attemptId ?? stateRef.current?.attemptId;
    if (id === undefined || settledRef.current) {
      return;
    }

    try {
      const response = await fetch(`/api/attempts/${encodeURIComponent(id)}/state`, { cache: 'no-store' });
      if (response.status === 401) {
        sendToSignIn();
        return;
      }
      if (!response.ok) {
        return;
      }

      const next = readState(await response.json().catch(() => null));
      if (next === null || settledRef.current) {
        return;
      }

      applyState(next);
      if (next.status !== 'IN_PROGRESS') {
        goResult(id);
      }
    } catch {
      // A failed re-sync changes nothing: the last known server time keeps counting down.
    }
  }, [applyState, goResult, sendToSignIn]);

  const submit = useCallback(
    async (auto: boolean): Promise<void> => {
      const id = paperRef.current?.attemptId;
      if (id === undefined || submittingRef.current || settledRef.current) {
        return;
      }
      submittingRef.current = true;
      setSubmitting(true);
      setError(null);

      // Right before submitting, ask the server where it is: an ended attempt goes to its result.
      await resync();
      if (settledRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }

      // One form, built once: every retry is the same request, and the API is idempotent per attempt.
      const form = answerForm(csrfToken, answersRef.current);
      const delays = auto ? AUTO_SUBMIT_RETRY_DELAYS_MS : [];
      let rounds = 0;

      for (;;) {
        if (rounds > 0) {
          const pause = delays[rounds - 1];
          if (pause === undefined) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, pause));
          if (settledRef.current) {
            return;
          }
        }
        rounds += 1;

        try {
          const response = await fetch(`/api/attempts/${encodeURIComponent(id)}/submit`, {
            method: 'POST',
            body: form,
            cache: 'no-store',
          });

          if (response.ok) {
            goResult(id);
            return;
          }

          if (response.status === 401) {
            sendToSignIn();
            return;
          }

          const payload: unknown = await response.json().catch(() => null);
          const code = isRecord(payload) && typeof payload.error === 'string' ? payload.error : '';

          if (code === 'attempt_expired') {
            // The deadline passed before these answers arrived; the result page says so.
            goResult(id, true);
            return;
          }

          // A rejected body will never be accepted by retrying it.
          if (response.status === 400 || response.status === 404) {
            setError(GENERIC_SUBMIT_ERROR);
            break;
          }
        } catch {
          // A network failure: the loop retries below while the grace window can still be open.
        }

        if (rounds > delays.length) {
          break;
        }
      }

      if (!settledRef.current) {
        setError(GENERIC_SUBMIT_ERROR);
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [csrfToken, goResult, resync, sendToSignIn],
  );

  /**
   * The start response may have been refused or lost. The paper is never delivered twice, so the
   * page asks the enrollment route what exists and shows the state-only screen instead of ever
   * retrying the start.
   */
  const recover = useCallback(
    async (message: string): Promise<void> => {
      try {
        const response = await fetch(`/api/enrollments/${encodeURIComponent(enrollmentId)}/attempt`, {
          cache: 'no-store',
        });

        if (response.status === 401) {
          sendToSignIn();
          return;
        }
        if (!response.ok) {
          setError(message);
          return;
        }

        const envelope = readEnvelope(await response.json().catch(() => null));
        if (envelope === null || envelope.attempt === null) {
          // No attempt exists: nothing was created, and the instructions may be shown again.
          setError(message);
          return;
        }

        applyState(envelope.attempt);
        if (envelope.attempt.status !== 'IN_PROGRESS') {
          goResult(envelope.attempt.attemptId);
          return;
        }

        setError(null);
      } catch {
        setError(message);
      }
    },
    [applyState, enrollmentId, goResult, sendToSignIn],
  );

  const start = useCallback(async (): Promise<void> => {
    if (startingRef.current || settledRef.current) {
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setError(null);

    const form = new FormData();
    form.set('csrfToken', csrfToken);
    form.set('enrollmentId', enrollmentId);

    try {
      const response = await fetch('/api/attempts/start', { method: 'POST', body: form, cache: 'no-store' });

      if (response.status === 401) {
        sendToSignIn();
        return;
      }

      if (response.status === 201) {
        const started = readStart(await response.json().catch(() => null));
        if (started === null) {
          await recover(UNREADABLE_PAPER_ERROR);
          return;
        }

        paperRef.current = started;
        applyState(started);
        setPaper(started);
        return;
      }

      if (response.status === 409) {
        await recover('This attempt has already been started and cannot be resumed.');
        return;
      }

      setError(GENERIC_START_ERROR);
    } catch {
      // The request may have reached the server: ask what exists rather than starting again.
      await recover(LOST_START_ERROR);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [applyState, csrfToken, enrollmentId, recover, sendToSignIn]);

  // A page that arrives with an attempt already running seeds its countdown from the server's
  // remaining seconds; without this the display would sit at its first render forever.
  useEffect(() => {
    if (attempt !== null && attempt.status === 'IN_PROGRESS') {
      applyState(attempt);
    }
  }, [applyState, attempt]);

  // The monotonic tick: it reads the deadline ref, never the device clock.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (deadlineMono.current === 0) {
        return;
      }

      const seconds = Math.max(0, Math.ceil((deadlineMono.current - performance.now()) / 1000));
      setRemaining(seconds);
      if (seconds > 0) {
        return;
      }

      if (paperRef.current !== null) {
        if (!settledRef.current && !submittingRef.current) {
          void submit(true);
        }
        return;
      }

      // No paper on this screen: the attempt is running elsewhere and the server ends it. Ask
      // once more for its state so the page can leave for the result, rather than polling.
      if (stateRef.current?.status === 'IN_PROGRESS' && !resyncedAtZeroRef.current) {
        resyncedAtZeroRef.current = true;
        void resync();
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [resync, submit]);

  // Re-sync every 30 seconds and whenever the tab becomes visible again.
  useEffect(() => {
    if (attemptId === null) {
      return;
    }

    const timer = window.setInterval(() => void resync(), RESYNC_INTERVAL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void resync();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [attemptId, resync]);

  // Ask before a reload or a close while the paper is on screen.
  useEffect(() => {
    if (paper === null) {
      return;
    }

    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (settledRef.current) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);

    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [paper]);

  // Move focus to the question when it changes, so a keyboard reader is not left on the old one.
  useEffect(() => {
    headingRef.current?.focus();
  }, [index, paper]);

  function choose(questionId: string, optionId: string): void {
    setAnswers((current) => {
      const next: Record<string, string> = { ...current };
      if (current[questionId] === optionId) {
        delete next[questionId];
      } else {
        next[questionId] = optionId;
      }
      answersRef.current = next;
      return next;
    });
    setConfirming(false);
  }

  function clearAnswer(questionId: string): void {
    setAnswers((current) => {
      const next: Record<string, string> = { ...current };
      delete next[questionId];
      answersRef.current = next;
      return next;
    });
    setConfirming(false);
  }

  // -------------------------------------------------------------------------
  // Not started yet: instructions
  // -------------------------------------------------------------------------

  if (paper === null && (state === null || state.status !== 'IN_PROGRESS')) {
    return (
      <section
        data-testid="attempt-instructions"
        className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6"
      >
        <h2 className="text-xl font-semibold text-white">{summary.title}</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Duration</dt>
            <dd className="text-slate-100">{String(summary.durationMinutes)} minutes, timed by the server</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Questions</dt>
            <dd className="text-slate-100">{String(summary.questionCount)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Marks</dt>
            <dd className="text-slate-100">
              {summary.totalMarks} in total · {summary.marksPerQuestion} for a correct answer
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Negative marking</dt>
            <dd className="text-slate-100">−{summary.negativeMarksPerQuestion} for a wrong answer</dd>
          </div>
        </dl>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">
          <li>The clock starts when you press Start, and it runs on the server, not in this browser.</li>
          <li>Your answers are sent only when you submit. There is no autosave.</li>
          <li>Closing or reloading this page ends your access to the paper, and the attempt cannot be resumed.</li>
          <li>The {String(summary.cost)}-coin fee is not refunded.</li>
        </ul>
        {error === null ? null : (
          <p role="alert" data-testid="attempt-error" className="text-sm text-rose-300">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          className="min-h-11 rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
          data-testid="start-attempt"
        >
          {starting ? 'Starting…' : 'Start'}
        </button>
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // Started elsewhere: no paper, no resume
  // -------------------------------------------------------------------------

  if (paper === null) {
    return (
      <section
        data-testid="attempt-cannot-resume"
        className="space-y-4 rounded-2xl border border-amber-900/60 bg-amber-950/20 p-6"
      >
        <h2 className="text-lg font-semibold text-amber-100">This attempt has already started</h2>
        <p className="text-sm text-amber-100/90">
          The paper is delivered once, so it cannot be shown again and this attempt cannot be resumed. It ends and is
          evaluated automatically when the server&apos;s clock reaches the deadline.
        </p>
        <p className="text-sm text-amber-100/90">
          Time remaining: <span data-testid="attempt-countdown">{formatCountdown(remaining)}</span>
        </p>
        {error === null ? null : (
          <p role="alert" data-testid="attempt-error" className="text-sm text-rose-300">
            {error}
          </p>
        )}
      </section>
    );
  }

  // -------------------------------------------------------------------------
  // Taking the paper
  // -------------------------------------------------------------------------

  const current: PaperQuestion | undefined = paper.questions[index];
  const answered = Object.keys(answers).length;
  const unanswered = paper.questions.length - answered;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <p className="text-sm text-slate-300">
          {summary.title} · Question {String(index + 1)} of {String(paper.questions.length)}
        </p>
        <p className="text-sm text-slate-300">
          Time left: <span data-testid="attempt-countdown">{formatCountdown(remaining)}</span>
        </p>
      </div>

      {current === undefined ? null : (
        <article className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-semibold text-white"
            data-testid="attempt-question"
          >
            Question {String(current.position)}
          </h2>
          {/* The API serves this through `sanitizeStoredContent`, the same sanitiser the editor preview uses. */}
          <div
            className="text-sm leading-relaxed text-slate-100"
            dangerouslySetInnerHTML={{ __html: current.contentHtml }}
          />
          {current.latex === null ? null : (
            // LaTeX is not HTML: it goes through KaTeX, which escapes what it cannot render (trust off).
            <div className="text-sm text-slate-100" dangerouslySetInnerHTML={{ __html: renderLatex(current.latex) }} />
          )}

          <fieldset className="space-y-2">
            <legend className="sr-only">Question {String(current.position)}: choose one answer</legend>
            {current.options.map((option) => {
              const chosen = answers[current.questionId] === option.id;

              return (
                <label
                  key={option.id}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm ${
                    chosen ? 'border-sky-500 bg-sky-950/40 text-white' : 'border-slate-700 text-slate-200'
                  }`}
                  data-testid="attempt-option"
                >
                  <input
                    type="radio"
                    name={`question-${current.questionId}`}
                    value={option.id}
                    checked={chosen}
                    onChange={() => choose(current.questionId, option.id)}
                    className="mt-1"
                  />
                  <span className="space-y-1">
                    <span className="block" dangerouslySetInnerHTML={{ __html: option.optionHtml }} />
                    {option.latex === null ? null : (
                      <span className="block" dangerouslySetInnerHTML={{ __html: renderLatex(option.latex) }} />
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {answers[current.questionId] === undefined ? null : (
            <button
              type="button"
              onClick={() => clearAnswer(current.questionId)}
              className="min-h-11 text-xs text-slate-400 underline hover:text-slate-200"
              data-testid="clear-answer"
            >
              Clear this answer
            </button>
          )}
        </article>
      )}

      <nav className="flex flex-wrap items-center gap-2" aria-label="Questions">
        <button
          type="button"
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
          disabled={index === 0}
          className="min-h-11 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 disabled:opacity-40"
          data-testid="previous-question"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => setIndex((value) => Math.min(paper.questions.length - 1, value + 1))}
          disabled={index === paper.questions.length - 1}
          className="min-h-11 rounded-lg border border-slate-700 px-3 text-sm text-slate-200 disabled:opacity-40"
          data-testid="next-question"
        >
          Next
        </button>
        <span className="ml-auto text-xs text-slate-400" data-testid="answered-count">
          {String(answered)} answered · {String(unanswered)} unanswered
        </span>
      </nav>

      <ol data-testid="question-palette" className="grid grid-cols-6 gap-2 sm:grid-cols-10">
        {paper.questions.map((question, position) => {
          const isAnswered = answers[question.questionId] !== undefined;

          return (
            <li key={question.questionId}>
              <button
                type="button"
                onClick={() => setIndex(position)}
                aria-current={position === index ? 'step' : undefined}
                aria-label={`Question ${String(position + 1)}${isAnswered ? ', answered' : ', not answered'}`}
                className={`min-h-11 w-full rounded-lg border text-sm ${
                  isAnswered ? 'border-emerald-500 bg-emerald-950/40 text-emerald-100' : 'border-slate-700 text-slate-300'
                } ${position === index ? 'ring-2 ring-sky-500' : ''}`}
                data-testid="palette-question"
              >
                {String(position + 1)}
              </button>
            </li>
          );
        })}
      </ol>

      {error === null ? null : (
        <p role="alert" data-testid="attempt-error" className="text-sm text-rose-300">
          {error}
        </p>
      )}

      {confirming ? (
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4" data-testid="submit-confirm">
          <p className="text-sm text-slate-200">
            {unanswered === 0
              ? 'Every question is answered. Submit the paper?'
              : `You have left ${String(unanswered)} question${unanswered === 1 ? '' : 's'} unanswered. Submit the paper?`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void submit(false)}
              disabled={submitting}
              className="min-h-11 rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50"
              data-testid="confirm-submit"
            >
              {submitting ? 'Submitting…' : 'Submit test'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-lg border border-slate-700 px-4 text-sm text-slate-200"
              data-testid="cancel-submit"
            >
              Keep working
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={submitting}
          className="min-h-11 rounded-lg bg-sky-500 px-4 text-sm font-semibold text-slate-950 hover:bg-sky-400 disabled:opacity-50"
          data-testid="submit-attempt"
        >
          Submit
        </button>
      )}
    </section>
  );
}
