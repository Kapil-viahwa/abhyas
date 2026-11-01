import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Deletes one catalog row. The API refuses when something still depends on it. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const area = stringField(guard.form, 'area') === 'editor' ? 'editor' : 'admin';
  const type = stringField(guard.form, 'type').trim();
  const id = stringField(guard.form, 'id').trim();
  const back = `/${area}/catalog`;

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<null>(`/v1/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      accessToken,
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 204
      ? redirectTo(`${back}?deleted=1`)
      : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
