import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** One create endpoint for the four catalog kinds; the API validates each shape. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const area = stringField(guard.form, 'area') === 'editor' ? 'editor' : 'admin';
  const type = stringField(guard.form, 'type').trim();
  const back = `/${area}/catalog`;

  const payload: Record<string, unknown> = { name: stringField(guard.form, 'name').trim() };
  const parentId = stringField(guard.form, 'parentId').trim();
  const categoryId = stringField(guard.form, 'categoryId').trim();
  const examId = stringField(guard.form, 'examId').trim();
  const subjectId = stringField(guard.form, 'subjectId').trim();

  if (parentId !== '') {
    payload.parentId = parentId;
  }
  if (categoryId !== '') {
    payload.categoryId = categoryId;
  }
  if (examId !== '') {
    payload.examId = examId;
  }
  if (subjectId !== '') {
    payload.subjectId = subjectId;
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<{ id: string }>(`/v1/catalog/${encodeURIComponent(type)}`, {
      method: 'POST',
      accessToken,
      body: payload,
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 201
      ? redirectTo(`${back}?created=1`)
      : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
