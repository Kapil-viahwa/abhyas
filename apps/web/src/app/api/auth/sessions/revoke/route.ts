import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { apiCall } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Ends one of this account's sessions by id; ownership is checked by the API. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const id = stringField(guard.form, 'id').trim();
  if (id === '') {
    return errorRedirect('/account', 'Choose a session to end.');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', accessToken }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo('/account?revoked=1')
      : errorRedirect('/account', 'That session could not be ended.');

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
