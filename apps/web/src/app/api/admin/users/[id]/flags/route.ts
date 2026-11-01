import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { updateEditorFlags } from '../../../../../../lib/admin-api';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { clientIpFrom, errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Replaces an editor's capability set. A box that was not ticked arrives absent. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const userId = stringField(guard.form, 'userId').trim();
  const back = `/admin/users/${encodeURIComponent(userId)}`;

  const outcome = await callWithSession(request, (accessToken) =>
    updateEditorFlags(
      accessToken,
      userId,
      {
        manage_questions: stringField(guard.form, 'manage_questions') === 'on',
        manage_tests: stringField(guard.form, 'manage_tests') === 'on',
        publish_tests: stringField(guard.form, 'publish_tests') === 'on',
      },
      clientIpFrom(request),
    ),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?flags=saved`)
      : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
