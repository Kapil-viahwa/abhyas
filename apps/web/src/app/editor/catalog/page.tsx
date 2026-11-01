import Link from 'next/link';
import type { ReactElement } from 'react';

import { CatalogManager } from '../../../components/catalog-manager';
import { secondaryButtonClass } from '../../../components/auth-shell';
import { getCatalogTree } from '../../../lib/catalog';
import { csrfFromCookies, loadRoleSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function notices(params: Record<string, string | string[] | undefined>): string[] {
  const list: string[] = [];
  if (params.created === '1') {
    list.push('Created.');
  }
  if (params.updated === '1') {
    list.push('Updated.');
  }
  if (params.deleted === '1') {
    list.push('Deleted.');
  }
  return list;
}

/**
 * The editor's catalog screen. It offers the same forms, and the API decides which rows
 * this editor may change: only the ones they created.
 */
export default async function EditorCatalogPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/editor/catalog', ['EDITOR', 'ADMIN']);
  const csrf = await csrfFromCookies();
  const tree = await getCatalogTree(session.accessToken);
  const params = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <nav className="flex flex-wrap gap-2 text-sm">
        <Link href="/editor" className="rounded-lg px-3 py-1.5 text-slate-300 hover:text-white">
          Editor area
        </Link>
        <Link
          href="/editor/catalog"
          aria-current="page"
          className="rounded-lg bg-sky-500/10 px-3 py-1.5 font-medium text-sky-300 ring-1 ring-sky-500/30"
        >
          Catalog
        </Link>
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

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Content</p>
        <h1 className="text-2xl font-semibold text-white">Catalog</h1>
        <p className="text-sm text-slate-400">
          {session.profile.fullName} · you may change the content you created; an Administrator may change all of it.
        </p>
      </header>

      <CatalogManager
        csrf={csrf}
        area="editor"
        tree={tree}
        notices={notices(params)}
        error={typeof params.error === 'string' ? params.error : undefined}
      />
    </main>
  );
}
