import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { AuthShell, FieldError, Notice, buttonClass, inputClass, labelClass } from '../../../components/auth-shell';
import { ResendButton } from '../../../components/resend-button';
import { TurnstileField } from '../../../components/turnstile-field';
import { webConfig } from '../../../lib/config';
import { csrfFromCookies } from '../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Signing in with a mobile number.
 *
 * The page does not exist at all while `OTP_ENABLED=false`: `notFound()` answers 404, the
 * same as the API's routes, so the switch cannot be proven by hiding a link alone.
 *
 * Two steps on one URL: ask for a code, then type it. The second form carries the number
 * back in a hidden field, and its second button posts the same form to the request route
 * again — that is the resend, and it is disabled until the countdown the API gave us runs
 * out.
 */
export default async function MobileLoginPage({ searchParams }: PageProps): Promise<ReactElement> {
  const config = webConfig();
  if (!config.otpEnabled) {
    notFound();
  }

  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const destination = typeof params.destination === 'string' ? params.destination : '';
  const sent = params.sent === '1' && destination !== '';
  const csrf = await csrfFromCookies();
  const resendAfter = Number(params.resend) > 0 ? Number(params.resend) : 30;

  return (
    <AuthShell
      title={sent ? 'Enter the code' : 'Sign in with your mobile'}
      subtitle={sent ? `We sent a six-digit code to ${destination}.` : 'We will text you a single-use code.'}
      footer={
        <p>
          Prefer your password? <Link href="/login">Sign in with email</Link>
        </p>
      }
    >
      {sent ? (
        <form action="/api/auth/mobile/login/verify" method="post" className="space-y-4">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="destination" value={destination} />
          <Notice message={`A code was sent to ${destination}.`} />
          <Notice message={typeof params.resent === 'string' ? 'A new code is on its way.' : undefined} />
          <FieldError message={error} />

          <label className={labelClass}>
            Six-digit code
            <input
              className={inputClass}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
            />
          </label>

          <TurnstileField siteKey={config.turnstileSiteKey} testMode={config.turnstileTestMode} />

          <div className="flex flex-wrap items-center gap-3">
            <button className={buttonClass} type="submit">
              Sign in
            </button>
            <ResendButton action="/api/auth/mobile/login/resend" seconds={resendAfter} />
          </div>
        </form>
      ) : (
        <form action="/api/auth/mobile/login" method="post" className="space-y-4">
          <input type="hidden" name="csrfToken" value={csrf} />
          <FieldError message={error} />

          <label className={labelClass}>
            Mobile number
            <input className={inputClass} name="destination" type="tel" autoComplete="tel" required />
          </label>

          <TurnstileField siteKey={config.turnstileSiteKey} testMode={config.turnstileTestMode} />

          <button className={buttonClass} type="submit">
            Send code
          </button>
        </form>
      )}
    </AuthShell>
  );
}
