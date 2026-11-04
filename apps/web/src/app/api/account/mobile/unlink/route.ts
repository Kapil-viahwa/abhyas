import { NextResponse } from 'next/server';

import { mobileDisabledResponse } from '../../../../../lib/mobile-auth';
import { guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { tokensFromCookies } from '../../../../../lib/session';
import { apiCall, clientIpFrom, errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Removes the number from this account. The API refuses when it is the only identifier. */
export async function POST(request: Request): Promise<NextResponse> {
  const disabled = mobileDisabledResponse();
  if (disabled !== null) {
    return disabled;
  }

  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { accessToken } = await tokensFromCookies();
  if (accessToken === undefined || accessToken === '') {
    return redirectTo('/login');
  }

  const password = stringField(guard.form, 'password');
  const result = await apiCall<{ status: string }>('/v1/auth/mobile/link', {
    method: 'DELETE',
    accessToken,
    clientIp: clientIpFrom(request),
    body: password === '' ? {} : { password },
  });

  if (result.status !== 200) {
    return redirectTo(`/account?error=${encodeURIComponent(errorMessage(result.body))}`);
  }

  return redirectTo('/account?mobile=removed');
}
