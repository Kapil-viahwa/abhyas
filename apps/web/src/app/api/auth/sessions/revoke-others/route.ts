import { NextResponse } from 'next/server';

import { callWithSession } from '../../../../../lib/authenticated-write';
import { guardFormPost, redirectTo } from '../../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../../lib/session';
import { apiCall } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Ends every other session of this account, keeping the one that asked. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const outcome = await callWithSession(request, (accessToken) =>
    apiCall<{ status: string; revoked: number }>('/v1/auth/sessions/revoke-others', {
      method: 'POST',
      accessToken,
    }),
  );

  if (!outcome.signedIn) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response = redirectTo('/account?signedOutOthers=1');
  if (outcome.tokens !== undefined) {
    setSessionCookies(response, outcome.tokens);
  }

  return response;
}
