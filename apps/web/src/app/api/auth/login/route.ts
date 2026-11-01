import { NextResponse } from 'next/server';

import { TURNSTILE_TEST_TOKEN, webConfig } from '../../../../lib/config';
import { errorRedirect, guardFormPost, redirectTo, stringField } from '../../../../lib/route-handler';
import { landingPath, setSessionCookies } from '../../../../lib/session';
import { apiCall, clientIpFrom, errorMessage } from '../../../../lib/upstream';

export const dynamic = 'force-dynamic';

interface LoginBody {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: { readonly roleCode: string };
}

function humanCheckToken(form: FormData): string {
  const submitted = stringField(form, 'turnstileToken').trim();
  if (submitted !== '') {
    return submitted;
  }

  return webConfig().turnstileTestMode ? TURNSTILE_TEST_TOKEN : '';
}

/**
 * The only place tokens become cookies. The response the browser receives carries a
 * redirect and two httpOnly cookies — never a token in a body, a URL or a script.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const result = await apiCall<LoginBody>('/v1/auth/login', {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: {
      email: stringField(guard.form, 'email').trim().toLowerCase(),
      password: stringField(guard.form, 'password'),
      turnstileToken: humanCheckToken(guard.form),
    },
  });

  if (result.status !== 200 || result.body === null) {
    const status = result.status;

    return errorRedirect(
      '/login',
      status === 429
        ? 'Too many attempts from this network. Please try again later.'
        : errorMessage(result.body),
    );
  }

  const response = redirectTo(landingPath(result.body.user.roleCode));
  setSessionCookies(response, {
    accessToken: result.body.accessToken,
    refreshToken: result.body.refreshToken,
  });

  return response;
}
