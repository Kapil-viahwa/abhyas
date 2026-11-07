import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { archiveTest, type TestView } from '../../../../../../lib/tests-api';
import { errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Retire a published paper. Administrator only; the API requires `tests.publish` and refuses the rest. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await params;
  const back = `/editor/tests/${encodeURIComponent(id)}`;

  const outcome = await callWithSession<TestView>(request, (accessToken) => archiveTest(accessToken, id));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?archived=1`)
      : redirectTo(`${back}?error=${encodeURIComponent(errorMessage(outcome.result.body))}`);

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
