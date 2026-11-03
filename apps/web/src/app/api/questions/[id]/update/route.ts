import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { apiCall, errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

interface Params {
  readonly params: Promise<{ id: string }>;
}

/** Saves the draft the editor page posted as one JSON field. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const back = `/editor/questions/${encodeURIComponent(id)}`;

  let payload: unknown;
  try {
    payload = JSON.parse(stringField(guard.form, 'payload'));
  } catch {
    return errorRedirect('/editor/questions', 'The form could not be read. Please try again.');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall(`/v1/questions/${encodeURIComponent(id)}`, { method: 'PATCH', accessToken, body: payload }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200 ? redirectTo(`${back}?saved=1`) : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
