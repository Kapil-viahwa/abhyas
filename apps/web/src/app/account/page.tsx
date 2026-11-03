import Link from 'next/link';
import type { ReactElement } from 'react';

import { FieldError, Notice, buttonClass, inputClass, labelClass, secondaryButtonClass } from '../../components/auth-shell';
import { TurnstileField } from '../../components/turnstile-field';
import { webConfig } from '../../lib/config';
import { csrfFromCookies, loadSession, loadSessions } from '../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function formatMoment(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

export default async function AccountPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadSession('/account');
  const sessions = await loadSessions(session.accessToken);
  const csrf = await csrfFromCookies();
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const mobile = typeof params.mobile === 'string' ? params.mobile : '';
  const config = webConfig();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
          <h1 className="text-2xl font-semibold text-white">Your account</h1>
          <p className="text-sm text-slate-400">
            {session.profile.fullName} · {session.profile.email ?? 'No email linked'}
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <input type="hidden" name="csrfToken" value={csrf} />
          <button className={secondaryButtonClass} type="submit">
            Sign out
          </button>
        </form>
      </header>

      <Notice message={params.denied === '1' ? 'You do not have access to that page.' : undefined} />
      <Notice message={params.password === 'changed' ? 'Password changed. Other devices were signed out.' : undefined} />
      <Notice message={params.revoked === '1' ? 'That session was ended.' : undefined} />
      <Notice message={params.signedOutOthers === '1' ? 'Every other session was ended.' : undefined} />
      <FieldError message={error} />

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-medium text-slate-100">Sessions</h2>
          <form action="/api/auth/sessions/revoke-others" method="post">
            <input type="hidden" name="csrfToken" value={csrf} />
            <button className={secondaryButtonClass} type="submit">
              End every other session
            </button>
          </form>
        </div>

        <ul data-testid="session-list" className="mt-4 divide-y divide-slate-800">
          {sessions.map((sessionRow) => (
            <li key={sessionRow.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="space-y-1">
                <p className="text-sm text-slate-200">
                  {sessionRow.deviceLabel ?? sessionRow.userAgent ?? 'Unknown device'}
                  {sessionRow.current ? (
                    <span className="ml-2 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300 ring-1 ring-sky-500/30">
                      this device
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500">
                  {sessionRow.ip ?? 'unknown address'} · last used {formatMoment(sessionRow.lastUsedAt)}
                </p>
              </div>
              <form action="/api/auth/sessions/revoke" method="post">
                <input type="hidden" name="csrfToken" value={csrf} />
                <input type="hidden" name="id" value={sessionRow.id} />
                <button className={secondaryButtonClass} type="submit">
                  End session
                </button>
              </form>
            </li>
          ))}
        </ul>

        {sessions.length === 0 ? <p className="mt-4 text-sm text-slate-400">No live sessions.</p> : null}
      </section>

      {config.otpEnabled ? (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-medium text-slate-100">Mobile number</h2>
          <p className="mt-1 text-sm text-slate-400">
            A verified number lets you sign in with a six-digit code. Adding or removing one asks you to confirm it is
            you first.
          </p>

          <Notice message={mobile === 'linked' ? 'Your mobile number was added.' : undefined} />
          <Notice message={mobile === 'removed' ? 'Your mobile number was removed.' : undefined} />
          <Notice message={params.email === 'linked' ? 'Your email address was added and verified.' : undefined} />

          <form action="/api/account/mobile/link" method="post" className="mt-4 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />

            <label className={labelClass}>
              Mobile number to add
              <input className={inputClass} name="destination" type="tel" autoComplete="tel" required />
            </label>

            {session.profile.email !== null ? (
              <label className={labelClass}>
                Your password
                <input className={inputClass} name="password" type="password" autoComplete="current-password" />
              </label>
            ) : null}

            <TurnstileField siteKey={config.turnstileSiteKey} testMode={config.turnstileTestMode} />

            <button className={buttonClass} type="submit">
              Send code
            </button>
          </form>

          <form action="/api/account/mobile/link/verify" method="post" className="mt-4 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />

            <label className={labelClass}>
              Number the code was sent to
              <input className={inputClass} name="destination" type="tel" required />
            </label>

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

            {session.profile.email !== null ? (
              <label className={labelClass}>
                Your password
                <input className={inputClass} name="password" type="password" autoComplete="current-password" />
              </label>
            ) : null}

            <button className={buttonClass} type="submit">
              Confirm number
            </button>
          </form>

          <form action="/api/account/mobile/unlink" method="post" className="mt-4 space-y-3">
            <input type="hidden" name="csrfToken" value={csrf} />

            <label className={labelClass}>
              Your password, if you have one
              <input className={inputClass} name="password" type="password" autoComplete="current-password" />
            </label>

            <button className={secondaryButtonClass} type="submit">
              Remove mobile number
            </button>
          </form>
        </section>
      ) : null}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-slate-100">Change password</h2>
        <p className="mt-1 text-sm text-slate-400">
          This device stays signed in; every other session ends as soon as you save.
        </p>

        <form action="/api/account/password" method="post" className="mt-4 space-y-3">
          <input type="hidden" name="csrfToken" value={csrf} />

          <label className={labelClass}>
            Current password
            <input
              className={inputClass}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>

          <label className={labelClass}>
            New password
            <input
              className={inputClass}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>

          <button className={buttonClass} type="submit">
            Save new password
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6">
        <h2 className="text-lg font-medium text-rose-200">Deactivate account</h2>
        <p className="mt-1 text-sm text-slate-400">
          This ends every session and the account can no longer sign in. Your password is required.
        </p>

        <form action="/api/account/deactivate" method="post" className="mt-4 space-y-3">
          <input type="hidden" name="csrfToken" value={csrf} />

          <label className={labelClass}>
            Password
            <input className={inputClass} name="password" type="password" autoComplete="current-password" required />
          </label>

          <button
            className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-rose-400"
            type="submit"
          >
            Deactivate
          </button>
        </form>
      </section>

      <p className="text-sm text-slate-500">
        Signed in as {session.profile.roleCode}.{' '}
        <Link href="/" className="text-sky-400 hover:text-sky-300">
          Back to the home page
        </Link>
      </p>
    </main>
  );
}
