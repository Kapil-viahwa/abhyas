import Link from 'next/link';
import type { ReactElement } from 'react';

import { AdminPage } from '../../../components/admin-shell';
import { listQuestions } from '../../../lib/questions-api';
import { questionPreview } from '../../../lib/question-preview';
import { csrfFromCookies, loadRoleSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** The authoring list. An editor sees their own work; an administrator sees everything. */
export default async function QuestionsPage({ searchParams }: PageProps): Promise<ReactElement> {
  const session = await loadRoleSession('/editor/questions', ['EDITOR', 'ADMIN']);
  const csrf = await csrfFromCookies();
  const params = await searchParams;

  const filters = {
    search: single(params.search),
    difficulty: single(params.difficulty),
    status: single(params.status),
    language: single(params.language),
    page: Number.parseInt(single(params.page), 10) || 1,
  };
  const result = await listQuestions(session.accessToken, filters);

  return (
    <AdminPage
      csrf={csrf}
      current="/editor/questions"
      title="Questions"
      subtitle="Drafts and published questions. Publishing freezes the version it publishes."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input
            name="search"
            defaultValue={filters.search}
            placeholder="Search text"
            className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
          />
          <select name="status" defaultValue={filters.status} className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm">
            <option value="">Any status</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
          </select>
          <select name="difficulty" defaultValue={filters.difficulty} className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm">
            <option value="">Any difficulty</option>
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </select>
          <select name="language" defaultValue={filters.language} className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2 text-sm">
            <option value="">Any language</option>
            <option value="EN">English</option>
            <option value="HI">Hindi</option>
          </select>
          <button type="submit" className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200">
            Filter
          </button>
        </form>

        <div className="flex gap-2 text-sm">
          <Link href="/editor/questions/new" className="rounded-xl bg-sky-600 px-3 py-2 font-medium text-white">
            New question
          </Link>
          <a href="/api/questions/export" className="rounded-xl border border-slate-700 px-3 py-2 text-slate-200">
            Export CSV
          </a>
        </div>
      </div>

      <p className="text-sm text-slate-400" data-testid="question-count">
        {result === null ? 'The list could not be loaded.' : `${String(result.total)} question(s), page ${String(result.page)} of ${String(result.pages)}`}
      </p>

      <ul data-testid="question-list" className="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900/60">
        {(result?.items ?? []).map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm text-slate-100">{questionPreview(item.version.contentHtml)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {item.version.questionType} · {item.version.language} · {item.version.difficulty} · v{item.currentVersion} · {item.status}
              </p>
            </div>
            <Link href={`/editor/questions/${item.id}`} className="text-sm text-sky-400 hover:text-sky-300">
              Open
            </Link>
          </li>
        ))}
      </ul>

      {result !== null && result.pages > 1 ? (
        <nav className="flex gap-2 text-sm text-slate-300">
          {Array.from({ length: result.pages }, (_, index) => index + 1).map((page) => (
            <Link key={page} href={`/editor/questions?page=${String(page)}`} className={page === result.page ? 'font-semibold text-sky-400' : ''}>
              {page}
            </Link>
          ))}
        </nav>
      ) : null}
    </AdminPage>
  );
}
