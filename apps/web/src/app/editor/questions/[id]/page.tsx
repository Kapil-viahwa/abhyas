import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../../components/admin-shell';
import { QuestionEditor } from '../../../../components/question-editor';
import { buttonClass, secondaryButtonClass } from '../../../../components/auth-shell';
import { catalogChoices, getQuestion } from '../../../../lib/questions-api';
import { csrfFromCookies, loadRoleSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EditQuestionPage({ params, searchParams }: PageProps): Promise<ReactElement> {
  const { id } = await params;
  const session = await loadRoleSession(`/editor/questions/${id}`, ['EDITOR', 'ADMIN']);
  const csrf = await csrfFromCookies();
  const question = await getQuestion(session.accessToken, id);

  // A question somebody else created is reported as missing, exactly as the API does.
  if (question === null) {
    notFound();
  }

  const catalog = await catalogChoices(session.accessToken);
  const query = await searchParams;

  return (
    <AdminPage
      csrf={csrf}
      current="/editor/questions"
      title="Edit question"
      subtitle={`Version ${String(question.currentVersion)} · ${question.status.toLowerCase()}`}
    >
      {query.created === '1' ? (
        <p className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-3 text-sm text-emerald-200">
          Draft created.
        </p>
      ) : null}
      {typeof query.error === 'string' ? (
        <p className="rounded-xl border border-rose-900/60 bg-rose-950/20 p-3 text-sm text-rose-200">{query.error}</p>
      ) : null}

      <QuestionEditor
        action={`/api/questions/${question.id}/update`}
        csrfToken={csrf}
        catalog={catalog}
        question={question}
        cancelHref="/editor/questions"
      />

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-medium text-slate-200">Publish</h2>
        <p className="mt-1 text-xs text-slate-400">
          Publishing freezes this version: further edits create a new draft version.
        </p>
        <form action={`/api/questions/${question.id}/publish`} method="post" className="mt-3">
          <input type="hidden" name="csrfToken" value={csrf} />
          <button className={buttonClass} type="submit" disabled={question.version.publishedAt !== null}>
            {question.version.publishedAt === null ? 'Publish this version' : 'Already published'}
          </button>
        </form>
        <a className={`${secondaryButtonClass} mt-3 inline-block`} href="/editor/questions">
          Back to questions
        </a>
      </section>
    </AdminPage>
  );
}
