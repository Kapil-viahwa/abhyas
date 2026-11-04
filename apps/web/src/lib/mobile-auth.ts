import { NextResponse } from 'next/server';

import { TURNSTILE_TEST_TOKEN, webConfig } from './config';
import { errorRedirect, guardFormPost, redirectTo, stringField } from './route-handler';
import { landingPath, setSessionCookies } from './session';
import { apiCall, clientIpFrom, errorMessage } from './upstream';

/**
 * The bits every mobile screen shares.
 *
 * With `OTP_ENABLED=false` all of them answer 404 before they read a form: a URL the browser
 * was never shown must not work either, and that is what makes the switch a switch rather
 * than a hidden link.
 */
export function mobileDisabledResponse(): NextResponse | null {
  if (webConfig().otpEnabled) {
    return null;
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

function turnstileFrom(form: FormData): string {
  const submitted = stringField(form, 'turnstileToken').trim();
  if (submitted !== '') {
    return submitted;
  }

  return webConfig().turnstileTestMode ? TURNSTILE_TEST_TOKEN : '';
}

export interface CodeRequestOptions {
  readonly purpose: 'LOGIN' | 'SIGNUP' | 'LINK';
  /** Where a refusal is shown, and where the code form lives once a code is sent. */
  readonly formPath: string;
  /** Extra fields carried on to the code form in hidden inputs. */
  readonly carry?: readonly string[];
  /** True when this is a resend, so the form can say a new code is on its way. */
  readonly resent?: boolean;
}

/** Asks the API for a code and sends the browser to the form that types it. */
export async function handleCodeRequest(request: Request, options: CodeRequestOptions): Promise<NextResponse> {
  const disabled = mobileDisabledResponse();
  if (disabled !== null) {
    return disabled;
  }

  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const destination = stringField(guard.form, 'destination').trim();
  const result = await apiCall<{ resendAfterSeconds: number }>('/v1/auth/otp', {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: { destination, purpose: options.purpose, turnstileToken: turnstileFrom(guard.form) },
  });

  if (result.status !== 202) {
    return errorRedirect(options.formPath, errorMessage(result.body));
  }

  const query = new URLSearchParams({
    sent: '1',
    destination,
    resend: String(result.body?.resendAfterSeconds ?? 30),
  });
  if (options.resent === true) {
    query.set('resent', '1');
  }
  for (const name of options.carry ?? []) {
    query.set(name, stringField(guard.form, name));
  }

  return redirectTo(`${options.formPath}?${query.toString()}`);
}

export interface CodeVerifyOptions {
  /** The API route that consumes the code. */
  readonly endpoint: '/v1/auth/mobile/login' | '/v1/auth/mobile/register';
  readonly formPath: string;
  /** Fields the API needs besides the code, read from the form. */
  readonly body: (form: FormData) => Record<string, unknown>;
  /** Query carried back on a refusal, so the code form is shown again with the error. */
  readonly back: (form: FormData) => URLSearchParams;
}

/** Consumes a code, and on success writes exactly the cookies password sign-in writes. */
export async function handleCodeVerify(request: Request, options: CodeVerifyOptions): Promise<NextResponse> {
  const disabled = mobileDisabledResponse();
  if (disabled !== null) {
    return disabled;
  }

  const guard = await guardFormPost(request);
  if (!guard.ok) {
    return guard.response;
  }

  const result = await apiCall<{
    accessToken: string;
    refreshToken: string;
    user: { roleCode: string };
  }>(options.endpoint, {
    method: 'POST',
    clientIp: clientIpFrom(request),
    body: options.body(guard.form),
  });

  if ((result.status !== 200 && result.status !== 201) || result.body === null) {
    const back = options.back(guard.form);
    back.set('error', errorMessage(result.body));
    return redirectTo(`${options.formPath}?${back.toString()}`);
  }

  const response = redirectTo(landingPath(result.body.user.roleCode));
  setSessionCookies(response, {
    accessToken: result.body.accessToken,
    refreshToken: result.body.refreshToken,
  });

  return response;
}
