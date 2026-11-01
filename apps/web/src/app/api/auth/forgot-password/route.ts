import { NextResponse } from 'next/server';

import { TURNSTILE_TEST_TOKEN, webConfig } from '../../../../lib/config';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { apiCall, clientIpFrom, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

function humanCheckToken(form: FormData): string {
  const submitted = stringField(form, 'turnstileToken').trim();
  if (submitted !== '') {
    return submitted;
  }

  return webConfig().turnstileTestMode ? TURNSTILE_TEST_TOKEN : '';
}

/** Always ends on the same "check your inbox" page, for a registered address or not. */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const result = await apiCall<{ status: string }>('/v1/auth/forgot-password', {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: {
      email: stringField(guard.form, 'email').trim().toLowerCase(),
      turnstileToken: humanCheckToken(guard.form),
    },
  });

  if (result.status === 202) {
    return redirectTo('/forgot-password?sent=1');
  }

  return errorRedirect(
    '/forgot-password',
    result.status === 429
      ? 'Too many reset requests. Please try again later.'
      : errorMessage(result.body),
  );
}
