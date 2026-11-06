import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { createTest, type TestView } from '../../../../../lib/tests-api';
import { errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Start a draft. The exam is checked again by the API, which refuses an exam this account
 * may not write content for; the title and duration are validated there too.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const examId = stringField(guard.form, 'examId').trim();
  const title = stringField(guard.form, 'title').trim();
  const durationText = stringField(guard.form, 'durationMinutes').trim();

  const back = `/editor/tests/new?title=${encodeURIComponent(title)}&examId=${encodeURIComponent(examId)}&durationMinutes=${encodeURIComponent(durationText)}`;

  if (examId === '' || title === '') {
    return redirectTo(`${back}&error=${encodeURIComponent('Choose an exam and give the paper a title.')}`);
  }

  const durationMinutes = durationText === '' ? 60 : Number.parseInt(durationText, 10);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600) {
    return redirectTo(`${back}&error=${encodeURIComponent('durationMinutes must be a whole number between 1 and 600')}`);
  }

  const outcome = await callWithSession(request, (accessToken) =>
    createTest(accessToken, { examId, title, durationMinutes }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const created: TestView | null = outcome.result.status === 201 ? outcome.result.body : null;
  const response =
    created === null
      ? redirectTo(`${back}&error=${encodeURIComponent(errorMessage(outcome.result.body))}`)
      : redirectTo(`/editor/tests/${created.id}?created=1`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
