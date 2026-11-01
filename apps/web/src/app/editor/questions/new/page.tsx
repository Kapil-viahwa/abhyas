import type { ReactElement } from 'react';

import { AdminPage } from '../../../../components/admin-shell';
import { QuestionEditor } from '../../../../components/question-editor';
import { catalogChoices } from '../../../../lib/questions-api';
import { csrfFromCookies, loadRoleSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/** A blank authoring form. The API validates everything again when it is submitted. */
export default async function NewQuestionPage(): Promise<ReactElement> {
  const session = await loadRoleSession('/editor/questions/new', ['EDITOR', 'ADMIN']);
  const csrf = await csrfFromCookies();
  const catalog = await catalogChoices(session.accessToken);

  return (
    <AdminPage
      csrf={csrf}
      current="/editor/questions"
      title="New question"
      subtitle="Write it, preview it as a student will see it, then save it as a draft."
    >
      {catalog.exams.length === 0 ? (
        <p className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4 text-sm text-amber-200">
          Create an exam and a subject in the catalog first: a question belongs to both.
        </p>
      ) : (
        <QuestionEditor action="/api/questions/create" csrfToken={csrf} catalog={catalog} question={null} cancelHref="/editor/questions" />
      )}
    </AdminPage>
  );
}
