import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { publishTest, type TestView } from '../../../../../../lib/tests-api';
import { errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Publish the submitted (or revised) version. Administrator only.
 *
 * This route does not check the caller's permissions itself: it passes the session to the API,
 * which requires `tests.publish`. An editor who posts here by hand is refused with 403 by the
 * API and comes back with its message, so the page never has to be the enforcement.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const back = `/editor/tests/${encodeURIComponent(id)}`;

  const outcome = await callWithSession<TestView>(request, (accessToken) => publishTest(accessToken, id));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?published=1`)
      : redirectTo(`${back}?error=${encodeURIComponent(errorMessage(outcome.result.body))}`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
