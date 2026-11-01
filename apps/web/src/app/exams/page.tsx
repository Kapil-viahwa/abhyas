import type { Metadata } from 'next';
import Link from 'next/link';

import { childCategories, getPublicCatalog, rootCategories } from '../../lib/catalog';
import { webConfig } from '../../lib/config';

// Cached, and dropped by the API's revalidation call after every catalog write.
export const revalidate = 3600;

const TITLE = 'Exams | Abhyas';
const DESCRIPTION =
  'Every exam Abhyas covers, from SSC and Banking to Railways and UPSC. Open one to see the sections and the mock tests built for it.';

export async function generateMetadata(): Promise<Metadata> {
  const url = `${webConfig().webUrl}/exams`;

  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: url },
    openGraph: { title: TITLE, description: DESCRIPTION, url, siteName: 'Abhyas', type: 'website' },
    twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
  };
}

export default async function ExamsPage() {
  const catalog = await getPublicCatalog();
  const roots = rootCategories(catalog);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
        <ol className="flex gap-2">
          <li>
            <Link href="/" className="hover:text-slate-300">
              Abhyas
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-slate-300">
            Exams
          </li>
        </ol>
      </nav>

      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Catalog</p>
        <h1 className="text-3xl font-semibold text-white">Exams</h1>
        <p className="max-w-2xl text-sm text-slate-400">{DESCRIPTION}</p>
      </header>

      {roots.length === 0 ? (
        <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
          The catalog is being prepared. Please check back soon.
        </p>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2">
          {roots.map((category) => {
            const children = childCategories(catalog, category.id);
            const examCount = catalog.exams.filter(
              (exam) => exam.categoryId === category.id || children.some((child) => child.id === exam.categoryId),
            ).length;

            return (
              <article key={category.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
                <h2 className="text-lg font-medium text-white">
                  <Link href={`/exams/${category.slug}`} className="hover:text-sky-300">
                    {category.name}
                  </Link>
                </h2>
                {category.description === null ? null : (
                  <p className="mt-1 text-sm text-slate-400">{category.description}</p>
                )}
                <p className="mt-3 text-xs text-slate-500">{examCount} exams</p>

                {children.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                    {children.map((child) => (
                      <li key={child.id}>
                        <Link href={`/exams/${child.slug}`} className="text-sky-400 hover:text-sky-300">
                          {child.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
