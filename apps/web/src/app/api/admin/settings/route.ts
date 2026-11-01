import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { updateSetting } from '../../../../lib/operations-api';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** One setting change. The API decides the type, the bounds and who may write. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const key = stringField(guard.form, 'key').trim();
  const value = stringField(guard.form, 'value').trim();

  const outcome = await callWithSession(request, (accessToken) => updateSetting(accessToken, key, value));

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo('/admin/settings?updated=1')
      : errorRedirect('/admin/settings', errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
