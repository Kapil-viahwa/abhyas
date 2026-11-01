import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../../lib/authenticated-write';
import { changeUserStatus } from '../../../../../../lib/admin-api';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../../lib/session';
import { clientIpFrom, errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Activates, suspends or deactivates an account. The API enforces `users.write`. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const userId = stringField(guard.form, 'userId').trim();
  const status = stringField(guard.form, 'status').trim().toUpperCase();
  const back = `/admin/users/${encodeURIComponent(userId)}`;

  const outcome = await callWithSession(request, (accessToken) =>
    changeUserStatus(accessToken, userId, status, clientIpFrom(request)),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo(`${back}?status=saved`)
      : errorRedirect(back, errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
