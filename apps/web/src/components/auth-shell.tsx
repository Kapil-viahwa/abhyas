import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <Link href="/" className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">
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

export function FieldError({ message }: { readonly message?: string }): ReactElement | null {
  if (message === undefined || message === '') {
    return null;
  }

  return (
    <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30">
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

export const inputClass =
  'mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500';

export const labelClass = 'block text-sm font-medium text-slate-300';

export const buttonClass =
  'w-full rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-60';

export const secondaryButtonClass =
  'rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-slate-500';
