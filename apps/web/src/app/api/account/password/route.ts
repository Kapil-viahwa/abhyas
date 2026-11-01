import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../lib/authenticated-write';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Changes the password; the API keeps this session and ends the others. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<{ status: string }>('/v1/auth/password/change', {
      method: 'POST',
      accessToken,
      body: {
        currentPassword: stringField(guard.form, 'currentPassword'),
        newPassword: stringField(guard.form, 'newPassword'),
      },
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response =
    outcome.result.status === 200
      ? redirectTo('/account?password=changed')
      : errorRedirect('/account', errorMessage(outcome.result.body));

  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
