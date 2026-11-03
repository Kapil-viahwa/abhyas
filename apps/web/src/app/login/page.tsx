import Link from 'next/link';
import type { ReactElement } from 'react';

import { AuthShell, FieldError, Notice, buttonClass, inputClass, labelClass } from '../../components/auth-shell';
import { TurnstileField } from '../../components/turnstile-field';
import { webConfig } from '../../lib/config';
import { csrfFromCookies } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: PageProps): Promise<ReactElement> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const config = webConfig();
  const csrf = await csrfFromCookies();

  return (
    <AuthShell
      title="Sign in"
      subtitle="Your mock tests, your coins and your progress are all behind this door."
      footer={
        <p>
          New here?{' '}
          <Link href="/register" className="text-sky-400 hover:text-sky-300">
            Create an account
          </Link>
        </p>
      }
    >
      <form action="/api/auth/login" method="post" className="space-y-4">
        <input type="hidden" name="csrfToken" value={csrf} />

        <Notice message={params.reset === '1' ? 'Your password was reset. Sign in with the new one.' : undefined} />
        <Notice message={params.signedOut === '1' ? 'You are signed out.' : undefined} />
        <Notice
          message={params.deactivated === '1' ? 'Your account is deactivated and cannot sign in.' : undefined}
        />
        <FieldError message={params.expired === '1' ? 'Your session expired. Please sign in again.' : undefined} />
        <FieldError message={error} />

        <label className={labelClass}>
          Email
          <input className={inputClass} name="email" type="email" autoComplete="email" required />
        </label>

        <label className={labelClass}>
          Password
          <input className={inputClass} name="password" type="password" autoComplete="current-password" required />
        </label>

        <TurnstileField siteKey={config.turnstileSiteKey} testMode={config.turnstileTestMode} />

        <button className={buttonClass} type="submit">
          Sign in
        </button>
      </form>

      <p className="mt-4 text-sm text-slate-400">
        <Link href="/forgot-password" className="text-sky-400 hover:text-sky-300">
          Forgot your password?
        </Link>
      </p>

      {config.otpEnabled ? (
        <p className="mt-2 text-sm text-slate-400">
          <Link href="/login/mobile" className="text-sky-400 hover:text-sky-300">
            Sign in with a mobile number
          </Link>
        </p>
      ) : null}
    </AuthShell>
  );
}
