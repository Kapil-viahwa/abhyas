/**
 * The catalog as the pages read it.
 *
 * Two shapes, one source: the authoring tree (every row, inactive included) is fetched
 * with a session, and the public catalog (active rows only) is cached under the
 * `catalog` tag so a write can drop it. Nothing here runs in the browser.
 */

import { apiCall } from './upstream';

export const CATALOG_CACHE_TAG = 'catalog';

export interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly createdBy: string;
}

export interface TopicRow {
  readonly id: string;
  readonly subjectId: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface SubjectRow {
  readonly id: string;
  readonly examId: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly topics: readonly TopicRow[];
}

export interface ExamRow {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly subjects: readonly SubjectRow[];
}

export interface CatalogTree {
  readonly categories: readonly CategoryRow[];
  readonly exams: readonly ExamRow[];
}

export interface PublicExam {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly sortOrder: number;
  readonly subjectCount: number;
}

export interface PublicCatalog {
  readonly categories: readonly CategoryRow[];
  readonly exams: readonly PublicExam[];
}

const EMPTY_PUBLIC: PublicCatalog = { categories: [], exams: [] };
const EMPTY_TREE: CatalogTree = { categories: [], exams: [] };

export async function getPublicCatalog(): Promise<PublicCatalog> {
  const result = await apiCall<PublicCatalog>('/v1/public/catalog', {
    method: 'GET',
    tags: [CATALOG_CACHE_TAG],
  });

  return result.status === 200 && result.body !== null ? result.body : EMPTY_PUBLIC;
}

export async function getCatalogTree(accessToken: string): Promise<CatalogTree> {
  const result = await apiCall<CatalogTree>('/v1/catalog/tree', { method: 'GET', accessToken });
  return result.status === 200 && result.body !== null ? result.body : EMPTY_TREE;
}

/** The public exams grouped by the category a page is showing. */
export function examsInCategory(catalog: PublicCatalog, categorySlug: string): readonly PublicExam[] {
  const category = catalog.categories.find((row) => row.slug === categorySlug);
  if (category === undefined) {
    return [];
  }

  const ids = new Set([category.id, ...catalog.categories.filter((row) => row.parentId === category.id).map((row) => row.id)]);
  return catalog.exams.filter((exam) => ids.has(exam.categoryId));
}

export function childCategories(catalog: PublicCatalog, parentId: string): readonly CategoryRow[] {
  return catalog.categories.filter((row) => row.parentId === parentId);
}

export function rootCategories(catalog: PublicCatalog): readonly CategoryRow[] {
  return catalog.categories.filter((row) => row.parentId === null);
}
