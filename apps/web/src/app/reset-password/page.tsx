import Link from 'next/link';
import type { ReactElement } from 'react';

import { AuthShell, FieldError, buttonClass, inputClass, labelClass } from '../../components/auth-shell';
import { csrfFromCookies } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ResetPasswordPage({ searchParams }: PageProps): Promise<ReactElement> {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : '';
  const error = typeof params.error === 'string' ? params.error : undefined;
  const csrf = await csrfFromCookies();

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="This link works once. Setting the password ends every session on every device."
      footer={
        <p>
          <Link href="/login" className="text-sky-400 hover:text-sky-300">
            Back to sign in
          </Link>
        </p>
      }
    >
      <form action="/api/auth/reset-password" method="post" className="space-y-4">
        <input type="hidden" name="csrfToken" value={csrf} />
        <input type="hidden" name="token" value={token} />

        <FieldError message={error} />

        <label className={labelClass}>
          New password
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

        <button className={buttonClass} type="submit">
          Set password
        </button>
      </form>
    </AuthShell>
  );
}
