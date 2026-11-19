import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactElement } from 'react';

import { AttemptRunner } from '../../../components/attempt-runner';
import { StudentNav } from '../../../components/student-shell';
import { controlTapTargetClass } from '../../../components/tap-target';
import { attemptForEnrollment } from '../../../lib/attempts-api';
import { csrfFromCookies, loadSession } from '../../../lib/session';
import { listMyEnrollments } from '../../../lib/student-tests-api';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ readonly enrollmentId: string }>;
}

/**
 * Phase 7, A4: the way into an attempt.
 *
 * The page renders one of four states and never the paper: the instructions before a start, the
 * "already started" screen when an attempt exists but this page holds no questions (a reload, a
 * second tab, a lost response), a redirect to the result once the attempt has ended, or the
 * not-available screen for an enrollment that is not this student's, does not exist, or is no
 * longer open. The questions themselves only ever arrive in the start response, which the client
 * component keeps in memory.
 */
export default async function AttemptEntryPage({ params }: PageProps): Promise<ReactElement> {
  const { enrollmentId } = await params;
  const session = await loadSession(`/attempt/${enrollmentId}`);
  const csrf = await csrfFromCookies();

  const [page, envelope] = await Promise.all([
    // The API's largest enrollment page. A student past 100 enrollments sees the not-available
    // screen rather than another student's paper, which is the safe way to be wrong.
    listMyEnrollments(session.accessToken, 1, 100),
    attemptForEnrollment(session.accessToken, enrollmentId),
  ]);

  const enrollment = page?.items.find((item) => item.id === enrollmentId) ?? null;

  if (enrollment === null || envelope.kind === 'missing') {
    return (
      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <section
          data-testid="attempt-missing"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300"
        >
          <h1 className="text-lg font-semibold text-white">Attempt</h1>
          <p>That attempt is not available. It may belong to another account, or the enrollment may not exist.</p>
          <Link href="/tests" className={`${controlTapTargetClass} mt-3 text-sky-400 hover:text-sky-300`}>
            Back to your tests
          </Link>
        </section>
      </main>
    );
  }

  if (envelope.kind === 'unauthorised') {
    // The session went stale between the session check and this call: sign in again, then return.
    redirect(`/login?next=${encodeURIComponent(`/attempt/${enrollmentId}`)}`);
  }

  if (envelope.kind === 'unavailable') {
    return (
      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <section
          data-testid="attempt-unavailable"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300"
        >
          <h1 className="text-lg font-semibold text-white">Attempt</h1>
          <p>That attempt could not be loaded. Please try again.</p>
          <Link href="/tests" className={`${controlTapTargetClass} mt-3 text-sky-400 hover:text-sky-300`}>
            Back to your tests
          </Link>
        </section>
      </main>
    );
  }

  const attempt = envelope.attempt;

  if (attempt !== null && attempt.status !== 'IN_PROGRESS') {
    redirect(`/attempt/result/${attempt.attemptId}`);
  }

  if (enrollment.status !== 'OPEN') {
    return (
      <main id="main" className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <section
          data-testid="attempt-missing"
          className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-300"
        >
          <h1 className="text-lg font-semibold text-white">Attempt</h1>
          <p>That enrollment is no longer open, so it cannot be taken.</p>
          <Link href="/tests" className={`${controlTapTargetClass} mt-3 text-sky-400 hover:text-sky-300`}>
            Back to your tests
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Attempt</h1>
        </div>
        <StudentNav current="/tests" />
      </header>

      <AttemptRunner
        enrollmentId={enrollment.id}
        csrfToken={csrf}
        summary={{
          title: enrollment.test.title,
          durationMinutes: enrollment.test.durationMinutes,
          questionCount: enrollment.test.questionCount,
          totalMarks: enrollment.test.totalMarks,
          marksPerQuestion: enrollment.test.marksPerQuestion,
          negativeMarksPerQuestion: enrollment.test.negativeMarksPerQuestion,
          cost: enrollment.cost,
        }}
        attempt={attempt}
      />
    </main>
  );
}
