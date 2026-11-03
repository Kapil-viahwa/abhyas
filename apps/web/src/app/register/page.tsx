import Link from 'next/link';
import type { ReactElement } from 'react';

import { AuthShell, FieldError, buttonClass, inputClass, labelClass } from '../../components/auth-shell';
import { TurnstileField } from '../../components/turnstile-field';
import { webConfig } from '../../lib/config';
import { csrfFromCookies } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RegisterPage({ searchParams }: PageProps): Promise<ReactElement> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const config = webConfig();
  const csrf = await csrfFromCookies();

  return (
    <AuthShell
      title="Create your account"
      subtitle="1,000 coins to start. Your email has to be confirmed before the first sign-in."
      footer={
        <p>
          Already registered?{' '}
          <Link href="/login" className="text-sky-400 hover:text-sky-300">
            Sign in
          </Link>
        </p>
      }
    >
      <form action="/api/auth/register" method="post" className="space-y-4">
        <input type="hidden" name="csrfToken" value={csrf} />

        <FieldError message={error} />

        <label className={labelClass}>
          Full name
          <input className={inputClass} name="fullName" type="text" autoComplete="name" required />
        </label>

        <label className={labelClass}>
          Email
          <input className={inputClass} name="email" type="email" autoComplete="email" required />
        </label>

        <label className={labelClass}>
          Password
          <input
            className={inputClass}
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <span className="mt-1 block text-xs text-slate-500">
            At least 12 characters, with a letter and a digit.
          </span>
        </label>

        <TurnstileField siteKey={config.turnstileSiteKey} testMode={config.turnstileTestMode} />

        <button className={buttonClass} type="submit">
          Create account
        </button>
      </form>

      {config.otpEnabled ? (
        <p className="mt-4 text-sm text-slate-400">
          <Link href="/register/mobile" className="text-sky-400 hover:text-sky-300">
            Create an account with a mobile number
          </Link>
        </p>
      ) : null}
    </AuthShell>
  );
}
