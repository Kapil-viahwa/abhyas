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

export default async function ForgotPasswordPage({ searchParams }: PageProps): Promise<ReactElement> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const sent = params.sent === '1';
  const config = webConfig();
  const csrf = await csrfFromCookies();

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="We will email a link that lets you choose a new one. Asking for an address we do not have looks exactly the same."
      footer={
        <p>
          <Link href="/login" className="text-sky-400 hover:text-sky-300">
            Back to sign in
          </Link>
        </p>
      }
    >
      <form action="/api/auth/forgot-password" method="post" className="space-y-4">
        <input type="hidden" name="csrfToken" value={csrf} />

        {sent ? (
          <Notice message="If that address has an account, the reset link is on its way. It works once and expires in 30 minutes." />
        ) : null}
        <FieldError message={error} />

        <label className={labelClass}>
          Email
          <input className={inputClass} name="email" type="email" autoComplete="email" required />
        </label>

        <TurnstileField siteKey={config.turnstileSiteKey} testMode={config.turnstileTestMode} />

        <button className={buttonClass} type="submit">
          Send reset link
        </button>
      </form>
    </AuthShell>
  );
}
