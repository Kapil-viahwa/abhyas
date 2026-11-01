import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Disables the account and ends every session, then forgets the cookies. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<{ status: string }>('/v1/auth/deactivate', {
      method: 'POST',
      accessToken,
      body: { password: stringField(guard.form, 'password') },
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  if (outcome.result.status !== 200) {
    return errorRedirect('/account', errorMessage(outcome.result.body));
  }

  const response = redirectTo('/login?deactivated=1');
  clearSessionCookies(response);
  return response;
}
