import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

interface Created {
  readonly id: string;
}

/** The editor page posts one JSON field; the API validates it again in full. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stringField(guard.form, 'payload'));
  } catch {
    return errorRedirect('/editor/questions/new', 'The form could not be read. Please try again.');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<Created>('/v1/questions', { method: 'POST', accessToken, body: payload }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const created = outcome.result.status === 201 ? outcome.result.body : null;
  const response =
    created !== null
      ? redirectTo(`/editor/questions/${created.id}?created=1`)
      : errorRedirect('/editor/questions/new', errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
