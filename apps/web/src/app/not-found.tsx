import Link from 'next/link';
import type { ReactElement } from 'react';

/**
 * The 404 page, in the app's own shell.
 *
 * Next's built-in not-found renders its message without a `<main>` landmark, so a page that
 * answered "not here" was the one screen the layout could not describe. This keeps the same
 * wording and status, and gives the page the skip link's target.
 */
export default function NotFound(): ReactElement {
  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-3 px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Abhyas</p>
      <h1 className="text-2xl font-semibold text-white">404</h1>
      <p className="text-sm text-slate-400">This page could not be found.</p>
      <p className="text-sm">
        <Link href="/" className="inline-flex min-h-11 items-center text-sky-400 hover:text-sky-300 sm:min-h-0">
          Back to the home page
        </Link>
      </p>
    </main>
  );
}
