import { NextResponse } from 'next/server';

import { mobileDisabledResponse } from '../../../../../../lib/mobile-auth';
import { guardFormPost, redirectTo, stringField } from '../../../../../../lib/route-handler';
import { tokensFromCookies } from '../../../../../../lib/session';
import { apiCall, clientIpFrom, errorMessage } from '../../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/** Confirms the code and writes the number to this account; the API decides whether it may. */
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
  const reauthCode = stringField(guard.form, 'reauthCode').trim();
  const result = await apiCall<{ status: string }>('/v1/auth/mobile/link', {
    method: 'POST',
    accessToken,
    clientIp: clientIpFrom(request),
    body: {
      destination: stringField(guard.form, 'destination').trim(),
      code: stringField(guard.form, 'code').trim(),
      ...(password === '' ? {} : { password }),
      ...(reauthCode === '' ? {} : { reauthCode }),
    },
  });

  if (result.status !== 200) {
    return redirectTo(`/account?error=${encodeURIComponent(errorMessage(result.body))}`);
  }

  return redirectTo('/account?mobile=linked');
}
