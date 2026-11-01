import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Changes a user's role through the API, which is the authority for `roles.write` and
 * for the session revocation that follows. The web layer only carries the form.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const userId = stringField(guard.form, 'userId').trim();
  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<{ status: string }>(`/v1/admin/users/${encodeURIComponent(userId)}/role`, {
      method: 'PATCH',
      accessToken,
      body: { roleCode: stringField(guard.form, 'roleCode').trim().toUpperCase() },
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo('/admin?role=changed')
      : errorRedirect('/admin', errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
