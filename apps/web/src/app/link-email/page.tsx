import type { ReactElement } from 'react';

import { AuthShell, buttonClass } from '../../components/auth-shell';
import { csrfFromCookies, loadSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The page the emailed address link opens.
 *
 * It needs a signed-in session: the link is confirmed by the person it was requested for, and
 * the API checks the token belongs to that account. Signing in first and confirming after is
 * one extra click, and it is the difference between "somebody opened this mail" and "the
 * account holder did".
 */
export default async function LinkEmailPage({ searchParams }: PageProps): Promise<ReactElement> {
  await loadSession('/link-email');

  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const csrf = await csrfFromCookies();

  return (
    <AuthShell
      title="Confirm this email address"
      subtitle="This is the address you asked to add. Confirming it here signs nothing in by itself."
    >
      {token === '' ? (
        <p className="text-sm text-rose-300">This link is incomplete. Ask for a new one from your account page.</p>
      ) : (
        <form action="/api/account/email/link/verify" method="post" className="space-y-4">
          <input type="hidden" name="csrfToken" value={csrf} />
          <input type="hidden" name="token" value={token} />
          <button className={buttonClass} type="submit">
            Add this address
          </button>
        </form>
      )}
    </AuthShell>
  );
}
