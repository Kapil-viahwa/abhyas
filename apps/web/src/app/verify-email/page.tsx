import Link from 'next/link';
import type { ReactElement } from 'react';

import { AuthShell, Notice, buttonClass } from '../../components/auth-shell';
import { AutoSubmit } from '../../components/auto-submit';
import { csrfFromCookies } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function VerifyEmailPage({ searchParams }: PageProps): Promise<ReactElement> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : undefined;
  const sent = params.sent === '1';
  const verified = params.status === 'verified';
  const error = typeof params.error === 'string' ? params.error : undefined;
  const csrf = await csrfFromCookies();

  if (verified) {
    return (
      <AuthShell title="Email verified" subtitle="Your account is ready.">
        <Notice message="That address is confirmed. You can sign in now." />
        <Link className={`${buttonClass} mt-4 block text-center`} href="/login">
          Sign in
        </Link>
      </AuthShell>
    );
  }

  if (token !== undefined) {
    return (
      <AuthShell title="Confirming your email" subtitle="One moment while the link is checked.">
        <form id="verify-form" action="/api/auth/verify-email" method="post">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="token" value={token} />
          <AutoSubmit formId="verify-form" />
          <noscript>
            <button className={buttonClass} type="submit">
              Confirm email
            </button>
          </noscript>
        </form>
        <p className="text-sm text-slate-400">If nothing happens, the link may have expired.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={sent ? 'Check your inbox' : 'Confirm your email'}
      subtitle={
        sent
          ? 'If that address can be registered, a confirmation link is on its way. It works once and expires in 30 minutes.'
          : 'Open the link from the confirmation email to finish creating your account.'
      }
      footer={
        <p>
          <Link href="/login" className="text-sky-400 hover:text-sky-300">
            Back to sign in
          </Link>
        </p>
      }
    >
      <Notice message={sent ? 'Nothing else to do here yet.' : undefined} />
      {error !== undefined ? <Notice message={error} /> : null}
    </AuthShell>
  );
}
