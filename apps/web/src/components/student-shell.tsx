import Link from 'next/link';
import type { ReactElement } from 'react';

/**
 * The student's navigation, in one place.
 *
 * It used to be copied into every student page, which is how the same three links ended up with
 * different sizes. On a phone every link is at least 44×44 CSS pixels — the whole row, padding
 * included, is the tap target — while the desktop layout keeps the compact inline look (the
 * `sm:` overrides reset the height above the `sm` breakpoint).
 */
export const NAV_LINK_CLASS =
  'inline-flex min-h-11 items-center rounded-lg px-2 text-sm sm:min-h-0 sm:px-0';

export const NAV_CURRENT_CLASS = 'text-slate-200';

export const NAV_OTHER_CLASS = 'text-sky-400 hover:text-sky-300';

const LINKS = [
  { href: '/account', label: 'Account' },
  { href: '/wallet', label: 'Wallet' },
  { href: '/tests', label: 'Tests' },
] as const;

export function StudentNav({ current }: { readonly current: string }): ReactElement {
  return (
    <nav aria-label="Your account" className="flex flex-wrap items-center gap-3 text-sm sm:gap-3">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={current === link.href ? 'page' : undefined}
          className={`${NAV_LINK_CLASS} ${current === link.href ? NAV_CURRENT_CLASS : NAV_OTHER_CLASS}`}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
