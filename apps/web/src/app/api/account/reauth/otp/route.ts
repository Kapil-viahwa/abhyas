import { NextResponse } from 'next/server';

import { TURNSTILE_TEST_TOKEN, webConfig } from '../../../../../lib/config';
import { mobileDisabledResponse } from '../../../../../lib/mobile-auth';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../../lib/route-handler';
import { tokensFromCookies } from '../../../../../lib/session';
import { apiCall, clientIpFrom, errorMessage } from '../../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * Sends a re-authentication code to this account's own verified number.
 *
 * An account created by mobile has no password, so when OTP is on the code is the only way it
 * can prove the holder before adding or removing an identifier (decision 0053). The API reads
 * the destination from the account, never from this form, so it cannot be used to text anybody.
 */
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

  const submitted = stringField(guard.form, 'turnstileToken').trim();
  const turnstileToken = submitted !== '' ? submitted : webConfig().turnstileTestMode ? TURNSTILE_TEST_TOKEN : '';

  const result = await apiCall<{ status: string }>('/v1/auth/reauth/otp', {
    method: 'POST',
    accessToken,
    clientIp: clientIpFrom(request),
    body: { turnstileToken },
  });

  if (result.status !== 202) {
    return errorRedirect('/account', errorMessage(result.body));
  }

  return redirectTo('/account?reauth=sent');
}
