import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../../components/admin-shell';
import { inputClass, labelClass, Notice } from '../../../../components/auth-shell';
import { questionPreview } from '../../../lib/question-preview';
import { listQuestions } from '../../../../lib/questions-api';
import { csrfFromCookies, loadPermissionSession } from '../../../../lib/session';
import {
  answerKeySentence,
  getTest,
  statusTone,
  type TestQuestionView,
  type TestView,
} from '../../../../lib/tests-api';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The notice that fits whichever action just succeeded. */
function noticeFor(params: Record<string, string | string[] | undefined>): string | undefined {
  if (single(params.created) === '1') {
    return 'Draft created. Set its pattern, add questions from the bank, then submit it.';
  }
  if (single(params.saved) === '1') {
    return 'Saved.';
  }
  if (single(params.submitted) === '1') {
    return 'Submitted. An Administrator reviews and publishes it.';
  }
  if (single(params.published) === '1') {
    return 'Published. The version is frozen and is what new enrollments receive.';
  }
  if (single(params.archived) === '1') {
    return 'Archived. Its enrollments stay.';
  }
  return undefined;
}

function PatternField({
  label,
  name,
  value,
  disabled,
  error,
  type = 'text',
  step,
  min,
  max,
  testId,
}: {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly error?: string | undefined;
  readonly type?: 'text' | 'number';
  readonly step?: string | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly testId: string;
}): ReactElement {
  return (
    <label className={labelClass}>
      {label}
      <input
        className={inputClass}
        name={name}
        type={type}
        defaultValue={value}
        disabled={disabled}
        step={step}
        min={min}
        max={max}
        data-testid={testId}
      />
      {error === undefined ? null : <span className="mt-1 block text-xs text-rose-300">{error}</span>}
    </label>
  );
}

function QuestionRow({
  question,
  index,
  total,
  csrf,
  actionBase,
  canEdit,
}: {
  readonly question: TestQuestionView;
  readonly index: number;
  readonly total: number;
  readonly csrf: string;
  readonly actionBase: string;
  readonly canEdit: boolean;
}): ReactElement {
  const correctPositions = new Set(question.options.filter((option) => option.isCorrect).map((option) => option.position));

  return (
    <li className="space-y-2 p-4" data-testid="paper-question">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Question {String(index + 1)}</p>
          <p className="truncate text-sm text-slate-100">{questionPreview(question.contentHtml)}</p>
          <p className="mt-1 text-xs text-slate-500">
            {question.questionType} · {question.marks} marks · −{question.negativeMarks} for a wrong answer
          </p>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap gap-1">
            <form action={actionBase} method="post">
              <input type="hidden" name="csrfToken" value={csrf} />
              <input type="hidden" name="action" value="move" />
              <input type="hidden" name="questionId" value={question.questionId} />
              <input type="hidden" name="direction" value="up" />
              <button
                type="submit"
                disabled={index === 0}
                className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 disabled:opacity-40"
                data-testid="move-up"
              >
                Up
              </button>
            </form>
            <form action={actionBase} method="post">
              <input type="hidden" name="csrfToken" value={csrf} />
              <input type="hidden" name="action" value="move" />
              <input type="hidden" name="questionId" value={question.questionId} />
              <input type="hidden" name="direction" value="down" />
              <button
                type="submit"
                disabled={index === total - 1}
                className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200 disabled:opacity-40"
                data-testid="move-down"
              >
                Down
              </button>
            </form>
            <form action={actionBase} method="post">
              <input type="hidden" name="csrfToken" value={csrf} />
              <input type="hidden" name="action" value="remove" />
              <input type="hidden" name="questionId" value={question.questionId} />
              <button type="submit" className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-200" data-testid="remove-question">
                Remove
              </button>
            </form>
          </div>
        ) : null}
      </div>

      <ol className="space-y-1 text-xs text-slate-400">
        {question.options.map((option) => (
          <li key={option.position} className={correctPositions.has(option.position) ? 'font-semibold text-emerald-300' : ''}>
            {correctPositions.has(option.position) ? '✓ ' : ''}
            {option.position}. {questionPreview(option.optionHtml)}
          </li>
        ))}
      </ol>

      <p className="text-xs text-slate-500" data-testid="answer-key">
        {answerKeySentence(question)}
        {question.explanationHtml === null ? '' : ` · ${questionPreview(question.explanationHtml)}`}
      </p>
    </li>
  );
}

/**
 * One paper.
 *
 * The pattern form is the PATCH route, the question list is the whole-list PUT the API
 * exposes, and submit/publish/archive are their own forms. Which controls render is decided
 * here from the session's permissions, but the API is the authority: an editor's publish or
 * archive is refused with 403, and a student never reaches this page at all.
 *
 * Editing a published paper opens a new draft version in the API; this page says so and shows
 * the live version beside it, so nobody expects a change to reach students before an
 * Administrator publishes the revision (decision 0070).
 */
export default async function TestBuilderPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadPermissionSession('/editor/tests', 'tests.read');
  const csrf = await csrfFromCookies();
  const { id } = await params;
  const query = await searchParams;

  const test: TestView | null = await getTest(session.accessToken, id);

  if (test === null) {
    return (
      <AdminPage
        csrf={csrf}
        permissions={session.profile.permissions}
        current="/editor/tests"
        title="Test"
        subtitle="That paper is not there, or it belongs to another editor."
      >
        <Link href="/editor/tests" className="text-sm text-sky-400 hover:text-sky-300">
          Back to the list
        </Link>
      </AdminPage>
    );
  }

  const canWrite = session.profile.permissions.includes('tests.write');
  const canPublish = session.profile.permissions.includes('tests.publish');
  const editableStatus = test.status === 'DRAFT' || test.status === 'PUBLISHED';
  const versionIsDraft = test.version.publishedAt === null;
  const canEdit = canWrite && editableStatus && versionIsDraft;
  const canSubmit = canWrite && editableStatus && versionIsDraft && test.questions.length > 0;
  const canArchive = canPublish && test.status === 'PUBLISHED';

  const search = single(query.search);
  const pickerPage = Number.parseInt(single(query.page), 10) || 1;
  const candidates = await listQuestions(session.accessToken, {
    examId: test.examId,
    status: 'PUBLISHED',
    ...(search === '' ? {} : { search }),
    page: pickerPage,
  });
  const onPaper = new Set(test.questions.map((question) => question.questionId));
  const addable = (candidates?.items ?? []).filter((question) => !onPaper.has(question.id));

  const field = single(query.field);
  const error = single(query.error);
  const fieldError = (name: string): string | undefined => (field === name && error !== '' ? error : undefined);
  const value = (name: string, fallback: string): string => (single(query[name]) === '' ? fallback : single(query[name]));

  return (
    <AdminPage
      csrf={csrf}
      permissions={session.profile.permissions}
      current="/editor/tests"
      title={test.title}
      subtitle={`Version ${String(test.currentVersion)} · ${String(test.version.questionCount)} question(s) · ${test.version.totalMarks} marks`}
    >
      <Notice message={noticeFor(query)} />

      {error !== '' && field === '' ? (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span data-testid="test-status" className={`rounded-full px-2 py-0.5 text-xs ring-1 ${statusTone(test.status)}`}>
          {test.status.toLowerCase()}
        </span>
        <Link href="/editor/tests" className="text-sm text-slate-400 hover:text-slate-200">
          Back to the list
        </Link>
      </div>

      {test.status === 'PUBLISHED' && test.publishedVersion !== null ? (
        <section className="rounded-2xl border border-emerald-900/60 bg-emerald-950/20 p-4 text-sm text-emerald-100" data-testid="live-version">
          <p className="font-medium">
            Live version {String(test.publishedVersion.version)} is published ({String(test.publishedVersion.durationMinutes)} min,{' '}
            {test.publishedVersion.totalMarks} marks) and stays exactly as it is.
          </p>
          <p className="mt-1 text-emerald-200/80">
            {versionIsDraft
              ? 'You are editing a new draft version. Students keep the live one until an Administrator publishes this revision.'
              : 'Any change here opens a new draft version; the live one is untouched until an Administrator publishes the revision.'}
          </p>
        </section>
      ) : null}

      {test.status === 'ARCHIVED' ? (
        <p className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
          This paper is archived. It cannot be changed or published again; its enrollments stay.
        </p>
      ) : null}

      {test.status === 'SUBMITTED' ? (
        <p className="rounded-xl border border-sky-900/60 bg-sky-950/20 p-4 text-sm text-sky-100">
          This paper is with an Administrator for review. It cannot be edited until it is published.
        </p>
      ) : null}

      <form action={`/api/editor/tests/${test.id}/pattern`} method="post" className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <input type="hidden" name="csrfToken" value={csrf} />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Pattern</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <PatternField
            label="Title"
            name="title"
            value={value('title', test.title)}
            disabled={!canEdit}
            error={fieldError('title')}
            testId="test-title"
          />
          <PatternField
            label="Duration in minutes"
            name="durationMinutes"
            value={value('durationMinutes', String(test.version.durationMinutes))}
            disabled={!canEdit}
            error={fieldError('durationMinutes')}
            type="number"
            min={1}
            max={600}
            testId="test-duration"
          />
          <PatternField
            label="Marks per question"
            name="marksPerQuestion"
            value={value('marksPerQuestion', test.version.marksPerQuestion)}
            disabled={!canEdit}
            error={fieldError('marksPerQuestion')}
            type="number"
            step="0.01"
            min={0.01}
            max={100}
            testId="test-marks"
          />
          <PatternField
            label="Negative marks per wrong answer"
            name="negativeMarksPerQuestion"
            value={value('negativeMarksPerQuestion', test.version.negativeMarksPerQuestion)}
            disabled={!canEdit}
            error={fieldError('negativeMarksPerQuestion')}
            type="number"
            step="0.01"
            min={0}
            max={100}
            testId="test-negative"
          />
          <PatternField
            label="Maximum attempts (blank means unlimited)"
            name="maxAttempts"
            value={value('maxAttempts', test.maxAttempts === null ? '' : String(test.maxAttempts))}
            disabled={!canEdit}
            error={fieldError('maxAttempts')}
            type="number"
            min={1}
            max={100}
            testId="test-max-attempts"
          />
        </div>

        {canEdit ? (
          <button type="submit" className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400" data-testid="save-pattern">
            Save pattern
          </button>
        ) : null}
      </form>

      <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Questions, in order</h2>

        <ul data-testid="question-order" className="divide-y divide-slate-800 rounded-xl border border-slate-800">
          {test.questions.map((question, index) => (
            <QuestionRow
              key={question.questionId}
              question={question}
              index={index}
              total={test.questions.length}
              csrf={csrf}
              actionBase={`/api/editor/tests/${test.id}/questions`}
              canEdit={canEdit}
            />
          ))}

          {test.questions.length === 0 ? (
            <li className="p-4 text-sm text-slate-400">No question yet. Add published questions of this exam below.</li>
          ) : null}
        </ul>

        {canEdit ? (
          <div className="space-y-3">
            <form method="get" className="flex flex-wrap items-end gap-2">
              <label className="text-sm text-slate-300">
                Find a published question
                <input
                  name="search"
                  defaultValue={search}
                  className="ml-2 rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm"
                  placeholder="Search text"
                />
              </label>
              <button type="submit" className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200">
                Search
              </button>
            </form>

            <ul data-testid="question-candidates" className="divide-y divide-slate-800 rounded-xl border border-slate-800">
              {addable.map((question) => (
                <li key={question.id} className="flex flex-wrap items-center justify-between gap-2 p-3" data-testid="question-candidate">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-100">{questionPreview(question.version.contentHtml)}</p>
                    <p className="text-xs text-slate-500">
                      {question.version.questionType} · {question.version.marks} marks · answer key visible to editors
                    </p>
                  </div>
                  <form action={`/api/editor/tests/${test.id}/questions`} method="post">
                    <input type="hidden" name="csrfToken" value={csrf} />
                    <input type="hidden" name="action" value="add" />
                    <input type="hidden" name="questionId" value={question.id} />
                    <button type="submit" className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200" data-testid="add-question">
                      Add
                    </button>
                  </form>
                </li>
              ))}

              {addable.length === 0 ? (
                <li className="p-3 text-sm text-slate-400">
                  {candidates === null
                    ? 'The question bank could not be loaded.'
                    : 'No published question of this exam is left to add.'}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="flex flex-wrap gap-3">
        {canSubmit ? (
          <form action={`/api/editor/tests/${test.id}/submit`} method="post">
            <input type="hidden" name="csrfToken" value={csrf} />
            <button type="submit" className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400" data-testid="submit-test">
              Submit for review
            </button>
          </form>
        ) : null}

        {/* These two render only for `tests.publish`. An editor never sees them, and the
            API refuses the routes even if one is posted by hand. */}
        {canPublish && test.status !== 'ARCHIVED' && versionIsDraft ? (
          <form action={`/api/admin/tests/${test.id}/publish`} method="post">
            <input type="hidden" name="csrfToken" value={csrf} />
            <button type="submit" className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400" data-testid="publish-test">
              Publish
            </button>
          </form>
        ) : null}

        {canArchive ? (
          <form action={`/api/admin/tests/${test.id}/archive`} method="post">
            <input type="hidden" name="csrfToken" value={csrf} />
            <button type="submit" className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200" data-testid="archive-test">
              Archive
            </button>
          </form>
        ) : null}
      </div>
    </AdminPage>
  );
}
