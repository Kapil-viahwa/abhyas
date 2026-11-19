import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import { tapTargetClass } from './tap-target';

/** One shell for every auth page, so the screens look like one product. */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}): ReactElement {
  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <Link
          href="/"
          className={`${tapTargetClass} text-xs font-semibold uppercase tracking-[0.3em] text-sky-400`}
        >
          Abhyas
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="text-sm text-slate-400">{subtitle}</p>
      </header>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">{children}</div>

      {footer ? <div className="text-sm text-slate-400">{footer}</div> : null}
    </main>
  );
}

/**
 * A form's error message.
 *
 * `role="alert"` announces it when it appears; the optional `id` is what a field points at with
 * `aria-describedby`, so the message a sighted user reads above the form is also the one a screen
 * reader reads when the field it belongs to takes focus.
 */
export function FieldError({ id, message }: { readonly id?: string; readonly message?: string }): ReactElement | null {
  if (message === undefined || message === '') {
    return null;
  }

  return (
    <p
      id={id}
      role="alert"
      className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30"
    >
      {message}
    </p>
  );
}

export function Notice({ message }: { readonly message?: string }): ReactElement | null {
  if (message === undefined || message === '') {
    return null;
  }

  return (
    <p role="status" className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/30">
      {message}
    </p>
  );
}

// No `outline-none` here: keyboard focus has to stay visible, and `app/globals.css` draws the ring
// every control shares. The border colour is the second, quieter cue on top of it. A 44px minimum
// on the phone keeps every text field and select a real tap target; the desktop keeps 38px.
export const inputClass =
  'mt-1 min-h-11 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-sky-500 sm:min-h-0';

export const labelClass = 'block text-sm font-medium text-slate-300';

export const buttonClass =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-60';

export const secondaryButtonClass = `${tapTargetClass} rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-500`;

/** The inline links the auth pages carry — footers, "Forgot your password?" — with a thumb-sized target. */
export const authLinkClass = `${tapTargetClass} text-sky-400 hover:text-sky-300`;
