import type { PrismaClient } from '@prisma/client';

/**
 * A small, realistic catalog for a fresh installation.
 *
 * Every row records its creator, so the seed needs an existing Administrator and
 * refuses to invent one. It is idempotent by slug: running it twice changes nothing,
 * and anything an Administrator edited stays edited.
 */

export const CATALOG_SEED_CONFIRM_VALUE = 'seed-example-catalog';

export class CatalogSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSeedError';
  }
}

interface SampleExam {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly subjects: readonly string[];
}

interface SampleCategory {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly exams: readonly SampleExam[];
}

export const SAMPLE_CATALOG: readonly SampleCategory[] = [
  {
    name: 'Staff Selection Commission',
    slug: 'ssc',
    description: 'SSC examinations for central government posts.',
    exams: [
      {
        name: 'SSC CGL',
        slug: 'ssc-cgl',
        description: 'Combined Graduate Level examination.',
        subjects: ['Quantitative Aptitude', 'General Intelligence', 'English Language', 'General Awareness'],
      },
      {
        name: 'SSC CHSL',
        slug: 'ssc-chsl',
        description: 'Combined Higher Secondary Level examination.',
        subjects: ['Quantitative Aptitude', 'General Intelligence', 'English Language'],
      },
    ],
  },
  {
    name: 'Banking',
    slug: 'banking',
    description: 'Bank and insurance recruitment examinations.',
    exams: [
      {
        name: 'IBPS PO',
        slug: 'ibps-po',
        description: 'Probationary Officer recruitment.',
        subjects: ['Reasoning Ability', 'Quantitative Aptitude', 'English Language', 'General Awareness'],
      },
      {
        name: 'SBI Clerk',
        slug: 'sbi-clerk',
        description: 'Junior Associate recruitment.',
        subjects: ['Numerical Ability', 'Reasoning Ability', 'English Language'],
      },
    ],
  },
  {
    name: 'Railways',
    slug: 'railways',
    description: 'Indian Railways recruitment examinations.',
    exams: [
      {
        name: 'RRB NTPC',
        slug: 'rrb-ntpc',
        description: 'Non-Technical Popular Categories.',
        subjects: ['Mathematics', 'General Intelligence and Reasoning', 'General Awareness'],
      },
    ],
  },
  {
    name: 'UPSC',
    slug: 'upsc',
    description: 'Union Public Service Commission examinations.',
    exams: [
      {
        name: 'UPSC Civil Services Preliminary',
        slug: 'upsc-cse-prelims',
        description: 'Civil Services Preliminary examination.',
        subjects: ['General Studies Paper I', 'General Studies Paper II'],
      },
    ],
  },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface CatalogSeedOptions {
  readonly createdBy: string;
  readonly nodeEnv: string;
  readonly confirm: string | undefined;
}

export interface CatalogSeedResult {
  readonly categories: number;
  readonly exams: number;
  readonly subjects: number;
}

export async function seedCatalog(
  client: PrismaClient,
  options: CatalogSeedOptions,
): Promise<CatalogSeedResult> {
  if (options.nodeEnv === 'production' && options.confirm !== CATALOG_SEED_CONFIRM_VALUE) {
    throw new CatalogSeedError(
      `Refusing to seed example content in production. Set CATALOG_SEED_CONFIRM=${CATALOG_SEED_CONFIRM_VALUE} to proceed.`,
    );
  }

  const result = { categories: 0, exams: 0, subjects: 0 };

  for (const category of SAMPLE_CATALOG) {
    const existingCategory = await client.examCategory.findUnique({
      where: { slug: category.slug },
      select: { id: true },
    });

    const categoryId =
      existingCategory?.id ??
      (
        await client.examCategory.create({
          data: {
            name: category.name,
            slug: category.slug,
            description: category.description,
            sortOrder: SAMPLE_CATALOG.indexOf(category),
            createdBy: options.createdBy,
          },
          select: { id: true },
        })
      ).id;

    if (existingCategory === null) {
      result.categories += 1;
    }

    for (const exam of category.exams) {
      const existingExam = await client.exam.findUnique({ where: { slug: exam.slug }, select: { id: true } });

      const examId =
        existingExam?.id ??
        (
          await client.exam.create({
            data: {
              categoryId,
              name: exam.name,
              slug: exam.slug,
              description: exam.description,
              sortOrder: category.exams.indexOf(exam),
              createdBy: options.createdBy,
            },
            select: { id: true },
          })
        ).id;

      if (existingExam === null) {
        result.exams += 1;
      }

      for (const [index, subjectName] of exam.subjects.entries()) {
        const subjectSlug = slugify(subjectName);
        const existingSubject = await client.subject.findUnique({
          where: { examId_slug: { examId, slug: subjectSlug } },
          select: { id: true },
        });

        if (existingSubject === null) {
          await client.subject.create({
            data: {
              examId,
              name: subjectName,
              slug: subjectSlug,
              sortOrder: index,
              createdBy: options.createdBy,
            },
          });
          result.subjects += 1;
        }
      }
    }
  }

  return result;
}

/** Every catalog row records its creator, so the seed needs a real Administrator. */
export async function findSeedActor(client: PrismaClient): Promise<{ id: string; email: string }> {
  const admin = await client.user.findFirst({
    where: { role: { code: 'ADMIN' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true },
  });

  if (admin === null) {
    throw new CatalogSeedError(
      'No Administrator exists. Create one with `pnpm db:seed:admin` first: every catalog row records its creator.',
    );
  }

  return admin;
}
