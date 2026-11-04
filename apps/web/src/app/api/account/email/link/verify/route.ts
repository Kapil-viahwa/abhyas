import { NextResponse } from 'next/server';

import { guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { tokensFromCookies } from '../../../../../../lib/session';
import { apiCall, clientIpFrom, errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Confirms the address from the emailed link. Email linking does not depend on OTP, so this
 * route has no mobile switch: it works with `OTP_ENABLED=false` as well.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { accessToken } = await tokensFromCookies();
  if (accessToken === undefined || accessToken === '') {
    return redirectTo('/login');
  }

  const result = await apiCall<{ status: string }>('/v1/auth/email/link/verify', {
    method: 'POST',
    accessToken,
    clientIp: clientIpFrom(request),
    body: { token: stringField(guard.form, 'token').trim() },
  });

  if (result.status !== 200) {
    return redirectTo(`/account?error=${encodeURIComponent(errorMessage(result.body))}`);
  }

  return redirectTo('/account?email=linked');
}
