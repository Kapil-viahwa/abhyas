import { NextResponse } from 'next/server';

import { TURNSTILE_TEST_TOKEN, webConfig } from '../../../../lib/config';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { apiCall, clientIpFrom, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

/**
 * The bot check: a real widget token in production, and in development/CI — where the
 * site key is Cloudflare's always-pass test key — the fixed token the API's test
 * verifier accepts. `webConfig()` refuses a test site key in production, so this
 * fallback cannot exist there.
 */
function humanCheckToken(form: FormData): string {
  const submitted = stringField(form, 'turnstileToken').trim();
  if (submitted !== '') {
    return submitted;
  }

  return webConfig().turnstileTestMode ? TURNSTILE_TEST_TOKEN : '';
}

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const result = await apiCall<{ status: string }>('/v1/auth/register', {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: {
      email: stringField(guard.form, 'email').trim().toLowerCase(),
      password: stringField(guard.form, 'password'),
      fullName: stringField(guard.form, 'fullName').trim(),
      turnstileToken: humanCheckToken(guard.form),
    },
  });

  if (result.status === 202) {
    return redirectTo('/verify-email?sent=1');
  }

  return errorRedirect(
    '/register',
    result.status === 429
      ? 'Too many registrations from this network. Please try again later.'
      : errorMessage(result.body),
  );
}
