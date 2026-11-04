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

/** Creating an account from a mobile number. 404 while `OTP_ENABLED=false`, like sign-in. */
export default async function MobileRegisterPage({ searchParams }: PageProps): Promise<ReactElement> {
  const config = webConfig();
  if (!config.otpEnabled) {
    notFound();
  }

  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const destination = typeof params.destination === 'string' ? params.destination : '';
  // The code-request route carries the name as `fullName`; `name` is still read so a link
  // that was copied before this fix keeps working.
  const nameParam = typeof params.fullName === 'string' ? params.fullName : params.name;
  const fullName = typeof nameParam === 'string' ? nameParam : '';
  const sent = params.sent === '1' && destination !== '';
  const csrf = await csrfFromCookies();
  const resendAfter = Number(params.resend) > 0 ? Number(params.resend) : 30;

  return (
    <AuthShell
      title={sent ? 'Confirm your number' : 'Create an account with your mobile'}
      subtitle={
        sent
          ? `Enter the six-digit code we sent to ${destination}.`
          : 'A verified number is all you need; you can add an email later.'
      }
      footer={
        <p>
          Already registered? <Link href="/login/mobile">Sign in</Link>
        </p>
      }
    >
      {sent ? (
        <form action="/api/auth/mobile/register/verify" method="post" className="space-y-4">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="destination" value={destination} />
          <input type="hidden" name="fullName" value={fullName} />
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
              Create account
            </button>
            <ResendButton action="/api/auth/mobile/register/resend" seconds={resendAfter} />
          </div>
        </form>
      ) : (
        <form action="/api/auth/mobile/register" method="post" className="space-y-4">
          <input type="hidden" name="csrfToken" value={csrf} />
          <FieldError message={error} />

          <label className={labelClass}>
            Full name
            <input className={inputClass} name="fullName" type="text" autoComplete="name" required />
          </label>

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
