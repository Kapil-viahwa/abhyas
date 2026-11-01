import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { childCategories, examsInCategory, getPublicCatalog } from '../../../lib/catalog';
import { webConfig } from '../../../lib/config';

// Rendered per request from the tagged catalog cache, as /exams is: the API's
// revalidation call drops that cache after every catalog write.
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ category: string }>;
}

async function findCategory(slug: string) {
  const catalog = await getPublicCatalog();
  return { catalog, category: catalog.categories.find((row) => row.slug === slug) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { category: slug } = await params;
  const { category, catalog } = await findCategory(slug);

  if (category === undefined) {
    return { title: 'Category not found | Abhyas', robots: { index: false } };
  }

  const exams = examsInCategory(catalog, category.slug);
  const title = `${category.name} exams | Abhyas`;
  const description =
    category.description ??
    `${exams.length} ${category.name} exams covered by Abhyas, with mock tests and practice sets for each.`;
  const url = `${webConfig().webUrl}/exams/${category.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: 'Abhyas', type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function CategoryPage({ params }: PageProps) {
  const { category: slug } = await params;
  const { catalog, category } = await findCategory(slug);

  if (category === undefined) {
    notFound();
  }

  const exams = examsInCategory(catalog, category.slug);
  const children = childCategories(catalog, category.id);
  const parent =
    category.parentId === null ? undefined : catalog.categories.find((row) => row.id === category.parentId);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <nav aria-label="Breadcrumb" className="text-xs text-slate-500">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link href="/" className="hover:text-slate-300">
              Abhyas
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/exams" className="hover:text-slate-300">
              Exams
            </Link>
          </li>
          {parent === undefined ? null : (
            <>
              <li aria-hidden="true">/</li>
              <li>
                <Link href={`/exams/${parent.slug}`} className="hover:text-slate-300">
                  {parent.name}
                </Link>
              </li>
            </>
          )}
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-slate-300">
            {category.name}
          </li>
        </ol>
      </nav>

      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">Exams</p>
        <h1 className="text-3xl font-semibold text-white">{category.name}</h1>
        {category.description === null ? null : <p className="max-w-2xl text-sm text-slate-400">{category.description}</p>}
      </header>

      {children.length > 0 ? (
        <section className="flex flex-wrap gap-2 text-sm">
          {children.map((child) => (
            <Link
              key={child.id}
              href={`/exams/${child.slug}`}
              className="rounded-full border border-slate-700 px-3 py-1 text-slate-300 hover:border-slate-500 hover:text-white"
            >
              {child.name}
            </Link>
          ))}
        </section>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        {exams.map((exam) => (
          <article key={exam.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="text-lg font-medium text-white">
              <Link href={`/exams/${category.slug}/${exam.slug}`} className="hover:text-sky-300">
                {exam.name}
              </Link>
            </h2>
            {exam.description === null ? null : <p className="mt-1 text-sm text-slate-400">{exam.description}</p>}
            <p className="mt-3 text-xs text-slate-500">{exam.subjectCount} subjects</p>
          </article>
        ))}

        {exams.length === 0 ? (
          <p className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
            No exams published in this category yet.
          </p>
        ) : null}
      </section>
    </main>
  );
}
