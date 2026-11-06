import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

import { secondaryButtonClass } from './auth-shell';

/**
 * The chrome every administration screen shares. It is deliberately small and wraps on
 * a narrow screen: the admin screens are tables and forms first, navigation second.
 *
 * The coin tools appear only for an account that holds `coins.write`: the pages check the
 * same permission on the server, and the API checks it on every route they call.
 */
export function AdminNav({
  csrf,
  current,
  permissions,
}: {
  readonly csrf: string;
  readonly current: string;
  readonly permissions?: readonly string[] | undefined;
}): ReactElement {
  const links = [
    { href: '/admin', label: 'Overview' },
    { href: '/admin/users', label: 'Users' },
    ...(permissions?.includes('coins.write') === true ? [{ href: '/admin/coins', label: 'Coins' }] : []),
    { href: '/admin/catalog', label: 'Catalog' },
    { href: '/editor/questions', label: 'Question bank' },
    { href: '/admin/settings', label: 'Settings' },
    { href: '/admin/audit', label: 'Audit' },
  ];

  return (
    <nav className="flex flex-wrap items-center gap-2 text-sm">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={current === link.href ? 'page' : undefined}
          className={
            current === link.href
              ? 'rounded-lg bg-sky-500/10 px-3 py-1.5 font-medium text-sky-300 ring-1 ring-sky-500/30'
              : 'rounded-lg px-3 py-1.5 text-slate-300 hover:text-white'
          }
        >
          {link.label}
        </Link>
      ))}

      <span className="grow" />

      <Link href="/account" className="px-2 py-1.5 text-slate-400 hover:text-slate-200">
        Account
      </Link>
      <form action="/api/auth/logout" method="post">
        <input type="hidden" name="csrfToken" value={csrf} />
        <button className={secondaryButtonClass} type="submit">
          Sign out
        </button>
      </form>
    </nav>
  );
}

export function AdminPage({
  csrf,
  current,
  permissions,
  title,
  subtitle,
  children,
}: {
  readonly csrf: string;
  readonly current: string;
  readonly permissions?: readonly string[] | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <AdminNav csrf={csrf} current={current} permissions={permissions} />

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Administration</p>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        <p className="text-sm text-slate-400">{subtitle}</p>
      </header>

      {children}
    </main>
  );
}

export function StatusBadge({ status }: { readonly status: string }): ReactElement {
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30'
      : status === 'SUSPENDED'
        ? 'bg-amber-500/10 text-amber-300 ring-amber-500/30'
        : 'bg-rose-500/10 text-rose-300 ring-rose-500/30';

  return <span className={`rounded-full px-2 py-0.5 text-xs ring-1 ${tone}`}>{status.toLowerCase()}</span>;
}
