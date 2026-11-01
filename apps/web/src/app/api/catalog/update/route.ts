import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Activate, deactivate or rename one catalog row. Ownership is the API's call. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const area = stringField(guard.form, 'area') === 'editor' ? 'editor' : 'admin';
  const type = stringField(guard.form, 'type').trim();
  const id = stringField(guard.form, 'id').trim();
  const action = stringField(guard.form, 'action').trim();
  const back = `/${area}/catalog`;

  const payload: Record<string, unknown> =
    action === 'activate' ? { isActive: true } : action === 'deactivate' ? { isActive: false } : {};

  if (Object.keys(payload).length === 0) {
    return errorRedirect(back, 'Unknown action');
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<{ id: string }>(`/v1/catalog/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      accessToken,
      body: payload,
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?updated=1`)
      : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
