import { NextResponse } from 'next/server';

import { redirectTo } from '../../../../lib/route-handler';
import { clearSessionCookies, setSessionCookies } from '../../../../lib/session';
import { apiCall } from '../../../../lib/upstream';
import { REFRESH_COOKIE, cookieFromRequest } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

interface RotatedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/**
 * Reached only when a page found an expired access cookie: exchange the refresh cookie
 * for a new pair, store the cookies and send the person back where they were going.
 * A failure clears the cookies and lands on the sign-in page.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const requested = url.searchParams.get('next') ?? '/account';
  // Only same-site paths are followed: an absolute URL here would be an open redirect.
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/account';

  const refreshToken = cookieFromRequest(request, REFRESH_COOKIE);
  if (refreshToken === undefined || refreshToken === '') {
    return redirectTo('/login?next=' + encodeURIComponent(next));
  }

  const rotated = await apiCall<RotatedTokens>('/v1/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  });

  if (rotated.status !== 200 || rotated.body === null) {
    const response = redirectTo('/login?expired=1');
    clearSessionCookies(response);
    return response;
  }

  const response = redirectTo(next);
  setSessionCookies(response, {
    accessToken: rotated.body.accessToken,
    refreshToken: rotated.body.refreshToken,
  });
  return response;
}
