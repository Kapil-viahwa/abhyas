import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { apiCall, errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

interface Params {
  readonly params: Promise<{ id: string }>;
}

/** Publishes the current draft. The API owns `tests.publish` and the freeze. */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const back = `/editor/questions/${encodeURIComponent(id)}`;

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall(`/v1/questions/${encodeURIComponent(id)}/publish`, { method: 'POST', accessToken }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?published=1`)
      : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
