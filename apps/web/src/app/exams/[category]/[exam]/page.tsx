import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { examsInCategory, getPublicCatalog } from '../../../../lib/catalog';
import { webConfig } from '../../../../lib/config';

export const revalidate = 3600;

interface PageProps {
  readonly params: Promise<{ category: string; exam: string }>;
}

async function findExam(categorySlug: string, examSlug: string) {
  const catalog = await getPublicCatalog();
  const category = catalog.categories.find((row) => row.slug === categorySlug);
  const exam = examsInCategory(catalog, categorySlug).find((row) => row.slug === examSlug);
  return { catalog, category, exam };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { category: categorySlug, exam: examSlug } = await params;
  const { category, exam } = await findExam(categorySlug, examSlug);

  if (category === undefined || exam === undefined) {
    return { title: 'Exam not found | Abhyas', robots: { index: false } };
  }

  const title = `${exam.name} mock tests | Abhyas`;
  const description =
    exam.description ?? `${exam.name} mock tests on Abhyas: full-length papers and sectional practice.`;
  const url = `${webConfig().webUrl}/exams/${category.slug}/${exam.slug}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, siteName: 'Abhyas', type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

export default async function ExamPage({ params }: PageProps) {
  const { category: categorySlug, exam: examSlug } = await params;
  const { category, exam } = await findExam(categorySlug, examSlug);

  if (category === undefined || exam === undefined) {
    notFound();
  }

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
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`/exams/${category.slug}`} className="hover:text-slate-300">
              {category.name}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-slate-300">
            {exam.name}
          </li>
        </ol>
      </nav>

      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-sky-400">{category.name}</p>
        <h1 className="text-3xl font-semibold text-white">{exam.name}</h1>
        {exam.description === null ? null : <p className="max-w-2xl text-sm text-slate-400">{exam.description}</p>}
      </header>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <h2 className="text-lg font-medium text-slate-100">What this exam covers</h2>
        <p className="mt-1 text-sm text-slate-400">
          {exam.subjectCount} subjects are defined for {exam.name}. Mock tests for this exam arrive with the testing
          phase; the syllabus is ready before them.
        </p>
        <p className="mt-4 text-sm">
          <Link href={`/exams/${category.slug}`} className="text-sky-400 hover:text-sky-300">
            All {category.name} exams
          </Link>
        </p>
      </section>
    </main>
  );
}
