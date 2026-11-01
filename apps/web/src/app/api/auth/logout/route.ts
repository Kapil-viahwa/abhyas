import { NextResponse } from 'next/server';

import { guardFormPost, redirectTo } from '../../../../lib/route-handler';
import { ACCESS_COOKIE, clearSessionCookies, cookieFromRequest } from '../../../../lib/session';
import { apiCall, clientIpFrom } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Revokes the session in the API, then forgets the cookies. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const accessToken = cookieFromRequest(request, ACCESS_COOKIE);
  if (accessToken !== undefined && accessToken !== '') {
    await apiCall('/v1/auth/logout', {
      method: 'POST',
      accessToken,
      clientIp: clientIpFrom(request),
    });
  }

  const response = redirectTo('/login?signedOut=1');
  clearSessionCookies(response);

  return response;
}
