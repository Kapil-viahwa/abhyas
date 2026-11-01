import { BadRequestException } from '@nestjs/common';

/**
 * Catalog input, hand-validated like the rest of the API: every rule here becomes a
 * sentence the editor reads, and nothing is coerced quietly.
 */

export const MIN_NAME_LENGTH = 2;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_LOGO_KEY_LENGTH = 200;
export const MAX_SLUG_LENGTH = 80;
export const MAX_SORT_ORDER = 10_000;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }
  return body as Record<string, unknown>;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** A readable slug from a name, so a caller may omit it. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

export function parseCatalogName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Enter a name');
  }

  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH || hasControlCharacter(name)) {
    throw new BadRequestException(`Enter a name (${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters)`);
  }

  return name;
}

export function parseSlug(value: unknown, fallbackName: string | undefined): string {
  if (value === undefined || value === null || value === '') {
    const derived = fallbackName === undefined ? '' : slugify(fallbackName);
    if (derived === '') {
      throw new BadRequestException('Enter a slug (lower-case letters, digits and hyphens)');
    }
    return derived;
  }

  if (typeof value !== 'string') {
    throw new BadRequestException('Enter a slug (lower-case letters, digits and hyphens)');
  }

  const slug = value.trim().toLowerCase();
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug)) {
    throw new BadRequestException('Enter a slug (lower-case letters, digits and hyphens)');
  }

  return slug;
}

export function parseOptionalText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${label} must be text`);
  }

  const text = value.trim();
  if (text === '') {
    return null;
  }
  if (text.length > maxLength || hasControlCharacter(text.replace(/\n/g, ''))) {
    throw new BadRequestException(`${label} must be at most ${maxLength} characters`);
  }

  return text;
}

export function parseSortOrder(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SORT_ORDER) {
    throw new BadRequestException(`Order must be a whole number between 0 and ${MAX_SORT_ORDER}`);
  }

  return parsed;
}

export function parseActive(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'on' || value === 1) {
    return true;
  }
  if (value === 'false' || value === 'off' || value === 0) {
    return false;
  }

  throw new BadRequestException('Active must be true or false');
}

export function parseOptionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new BadRequestException(`Choose a valid ${label}`);
  }
  return value.trim();
}

export function parseRequiredUuid(value: unknown, label: string): string {
  const parsed = parseOptionalUuid(value, label);
  if (parsed === null) {
    throw new BadRequestException(`Choose a ${label}`);
  }
  return parsed;
}

export interface NamedCatalogInput {
  readonly name: string;
  readonly slug?: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export function parseNamedCatalogBody(body: unknown, { requireActive = false } = {}): NamedCatalogInput {
  const record = asRecord(body);
  const name = parseCatalogName(record.name);
  const slugRaw = record.slug;

  return {
    name,
    slug: slugRaw === undefined || slugRaw === null || slugRaw === '' ? undefined : parseSlug(slugRaw, name),
    description: parseOptionalText(record.description, MAX_DESCRIPTION_LENGTH, 'Description'),
    logoKey: parseOptionalText(record.logoKey, MAX_LOGO_KEY_LENGTH, 'Logo'),
    sortOrder: parseSortOrder(record.sortOrder),
    isActive: requireActive ? true : parseActive(record.isActive),
  };
}

export interface CategoryInput extends NamedCatalogInput {
  readonly parentId: string | null;
}

export function parseCategoryBody(body: unknown): CategoryInput {
  const record = asRecord(body);
  return { ...parseNamedCatalogBody(body), parentId: parseOptionalUuid(record.parentId, 'parent category') };
}

export interface ExamInput extends NamedCatalogInput {
  readonly categoryId: string;
}

export function parseExamBody(body: unknown): ExamInput {
  const record = asRecord(body);
  return { ...parseNamedCatalogBody(body), categoryId: parseRequiredUuid(record.categoryId, 'category') };
}

export interface SubjectInput extends NamedCatalogInput {
  readonly examId: string;
}

export function parseSubjectBody(body: unknown): SubjectInput {
  const record = asRecord(body);
  return { ...parseNamedCatalogBody(body), examId: parseRequiredUuid(record.examId, 'exam') };
}

export interface TopicInput extends NamedCatalogInput {
  readonly subjectId: string;
}

export function parseTopicBody(body: unknown): TopicInput {
  const record = asRecord(body);
  return { ...parseNamedCatalogBody(body), subjectId: parseRequiredUuid(record.subjectId, 'subject') };
}

/** An update only touches what was sent, so a field the form left out is not cleared. */
export interface CatalogUpdateInput {
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string | null;
  readonly logoKey?: string | null;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
  readonly parentId?: string | null;
}

export function parseCatalogUpdateBody(body: unknown): CatalogUpdateInput {
  const record = asRecord(body);
  const update: {
    name?: string;
    slug?: string;
    description?: string | null;
    logoKey?: string | null;
    sortOrder?: number;
    isActive?: boolean;
    parentId?: string | null;
  } = {};

  if (record.name !== undefined) {
    update.name = parseCatalogName(record.name);
  }
  if (record.slug !== undefined) {
    update.slug = parseSlug(record.slug, update.name);
  }
  if ('description' in record) {
    update.description = parseOptionalText(record.description, MAX_DESCRIPTION_LENGTH, 'Description');
  }
  if ('logoKey' in record) {
    update.logoKey = parseOptionalText(record.logoKey, MAX_LOGO_KEY_LENGTH, 'Logo');
  }
  if (record.sortOrder !== undefined) {
    update.sortOrder = parseSortOrder(record.sortOrder);
  }
  if (record.isActive !== undefined) {
    update.isActive = parseActive(record.isActive);
  }
  if ('parentId' in record) {
    update.parentId = parseOptionalUuid(record.parentId, 'parent category');
  }

  return update;
}

export const CATALOG_TYPES = ['categories', 'exams', 'subjects', 'topics'] as const;

export type CatalogType = (typeof CATALOG_TYPES)[number];

export function parseCatalogType(value: unknown): CatalogType {
  if (typeof value !== 'string' || !(CATALOG_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException('Choose what to change: categories, exams, subjects or topics');
  }
  return value as CatalogType;
}
