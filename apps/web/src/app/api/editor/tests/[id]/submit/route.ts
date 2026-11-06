import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { submitTest, type TestView } from '../../../../../../lib/tests-api';
import { errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Hand a complete draft to an Administrator.
 *
 * The API decides whether the draft is complete (at least one question) and whether the state
 * allows a submit at all; this handler only carries the form and the session.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const back = `/editor/tests/${encodeURIComponent(id)}`;

  const outcome = await callWithSession<TestView>(request, (accessToken) => submitTest(accessToken, id));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?submitted=1`)
      : redirectTo(`${back}?error=${encodeURIComponent(errorMessage(outcome.result.body))}`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
