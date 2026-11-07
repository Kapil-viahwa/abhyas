import { BadRequestException } from '@nestjs/common';

import { parseUuid } from '../auth/validation';

export const TEST_STATUSES = ['DRAFT', 'SUBMITTED', 'PUBLISHED', 'ARCHIVED'] as const;

export type TestStatus = (typeof TEST_STATUSES)[number];

export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 600;
export const MAX_MARKS_PER_QUESTION = 100;
export const MAX_ATTEMPT_CAP = 100;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_QUESTIONS_PER_PAPER = 100;
export const DEFAULT_DURATION_MINUTES = 60;

export interface CreateTestInput {
  readonly examId: string;
  readonly title: string;
  readonly description: string | null;
  readonly durationMinutes: number;
}

export interface UpdateTestInput {
  readonly title: string | undefined;
  readonly description: string | null | undefined;
  readonly durationMinutes: number | undefined;
  readonly marksPerQuestion: string | undefined;
  readonly negativeMarksPerQuestion: string | undefined;
  /** `null` clears the cap; `undefined` leaves it as it is. */
  readonly maxAttempts: number | null | undefined;
}

export interface TestListQuery {
  readonly status: TestStatus | undefined;
  readonly examId: string | undefined;
  readonly page: number;
}

const CREATE_FIELDS = ['examId', 'title', 'description', 'durationMinutes'] as const;
const UPDATE_FIELDS = [
  'title',
  'description',
  'durationMinutes',
  'marksPerQuestion',
  'negativeMarksPerQuestion',
  'maxAttempts',
] as const;
const QUESTION_ORDER_FIELDS = ['questionIds'] as const;
const QUERY_FIELDS = ['status', 'examId', 'page'] as const;

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('A JSON object body is required');
  }
  return body as Record<string, unknown>;
}

/** A field the endpoint does not read is refused rather than silently ignored. */
function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new BadRequestException(`${key} is not a field this endpoint accepts`);
    }
  }
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function title(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException('title is required');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new BadRequestException(`title must be ${String(MAX_TITLE_LENGTH)} characters or fewer`);
  }
  return trimmed;
}

function description(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('description must be text');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new BadRequestException(`description must be ${String(MAX_DESCRIPTION_LENGTH)} characters or fewer`);
  }
  return trimmed === '' ? null : trimmed;
}

function wholeNumber(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${field} must be a whole number between ${String(min)} and ${String(max)}`);
  }
  return parsed;
}

/** A decimal with at most two places, in the string form Prisma's Decimal column takes. */
function decimal(value: unknown, field: string, allowedZero: boolean): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text)) {
    throw new BadRequestException(`${field} must be a number with up to two decimals`);
  }
  const amount = Number(text);
  if (!allowedZero && amount <= 0) {
    throw new BadRequestException(`${field} must be greater than 0`);
  }
  if (amount > MAX_MARKS_PER_QUESTION) {
    throw new BadRequestException(`${field} must be ${String(MAX_MARKS_PER_QUESTION)} or less`);
  }
  return text;
}

export function parseCreateTestBody(body: unknown): CreateTestInput {
  const record = asRecord(body);
  rejectUnknown(record, CREATE_FIELDS);

  return {
    examId: parseUuid(record.examId, 'exam id'),
    title: title(record.title),
    description: description(record.description),
    durationMinutes: has(record, 'durationMinutes')
      ? wholeNumber(record.durationMinutes, 'durationMinutes', MIN_DURATION_MINUTES, MAX_DURATION_MINUTES)
      : DEFAULT_DURATION_MINUTES,
  };
}

export function parseUpdateTestBody(body: unknown): UpdateTestInput {
  const record = asRecord(body);
  rejectUnknown(record, UPDATE_FIELDS);

  if (Object.keys(record).length === 0) {
    throw new BadRequestException('Send at least one field to change');
  }

  return {
    title: has(record, 'title') ? title(record.title) : undefined,
    description: has(record, 'description') ? description(record.description) : undefined,
    durationMinutes: has(record, 'durationMinutes')
      ? wholeNumber(record.durationMinutes, 'durationMinutes', MIN_DURATION_MINUTES, MAX_DURATION_MINUTES)
      : undefined,
    marksPerQuestion: has(record, 'marksPerQuestion')
      ? decimal(record.marksPerQuestion, 'marksPerQuestion', false)
      : undefined,
    negativeMarksPerQuestion: has(record, 'negativeMarksPerQuestion')
      ? decimal(record.negativeMarksPerQuestion, 'negativeMarksPerQuestion', true)
      : undefined,
    maxAttempts: has(record, 'maxAttempts')
      ? record.maxAttempts === null
        ? null
        : wholeNumber(record.maxAttempts, 'maxAttempts', 1, MAX_ATTEMPT_CAP)
      : undefined,
  };
}

/** The paper's whole question list, in order: replacing it is how adding, removing and reordering happen. */
export function parseQuestionOrderBody(body: unknown): string[] {
  const record = asRecord(body);
  rejectUnknown(record, QUESTION_ORDER_FIELDS);

  const value = record.questionIds;
  if (!Array.isArray(value)) {
    throw new BadRequestException('questionIds must be a list');
  }
  if (value.length === 0) {
    throw new BadRequestException('A test needs at least one question');
  }
  if (value.length > MAX_QUESTIONS_PER_PAPER) {
    throw new BadRequestException(`A test takes at most ${String(MAX_QUESTIONS_PER_PAPER)} questions`);
  }

  const ids = value.map((entry) => parseUuid(entry, 'question id'));
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException('A question can appear only once in a test');
  }

  return ids;
}

function optionalString(query: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) {
    throw new BadRequestException(`${key} may be sent only once`);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  return value.trim();
}

export function parseTestQuery(query: Record<string, string | string[] | undefined>): TestListQuery {
  for (const key of Object.keys(query)) {
    if (!QUERY_FIELDS.includes(key as (typeof QUERY_FIELDS)[number])) {
      throw new BadRequestException(`${key} is not a filter this endpoint accepts`);
    }
  }

  const status = optionalString(query, 'status');
  const examId = optionalString(query, 'examId');
  const pageRaw = optionalString(query, 'page');
  const page = pageRaw === undefined ? 1 : Number.parseInt(pageRaw, 10);

  let parsedStatus: TestStatus | undefined;
  if (status !== undefined) {
    const match = TEST_STATUSES.find((value) => value === status.toUpperCase());
    if (match === undefined) {
      throw new BadRequestException(`status must be one of ${TEST_STATUSES.join(', ')}`);
    }
    parsedStatus = match;
  }

  return {
    status: parsedStatus,
    examId: examId === undefined ? undefined : parseUuid(examId, 'exam id'),
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}



// ---------------------------------------------------------------------------
// The student side: the catalog, and the enroll request
// ---------------------------------------------------------------------------

/** One page of the student catalog is small on purpose: a list a person scrolls, not exports. */
export const MAX_STUDENT_PAGE_SIZE = 50;
export const MAX_ENROLLMENT_PAGE_SIZE = 100;
export const DEFAULT_STUDENT_PAGE_SIZE = 20;

/** The setting that prices one attempt. Read inside the enrollment transaction. */
export const ENROLLMENT_COST_SETTING = 'default_enrollment_cost';

/**
 * An `Idempotency-Key` a person's client may send.
 *
 * Bounded at both ends: the ledger stores `enroll:<key>` and refuses a key outside 8..200, so
 * the longest key that can survive the prefix is 100 characters. Anything else is a 400 rather
 * than a silent truncation.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

export interface StudentPageQuery {
  readonly page: number;
  readonly pageSize: number;
}

export interface StudentCatalogQuery extends StudentPageQuery {
  readonly examId: string | undefined;
}

const STUDENT_CATALOG_FIELDS = ['page', 'pageSize', 'examId'] as const;
const STUDENT_PAGE_FIELDS = ['page', 'pageSize'] as const;

/** A query parameter the student routes do not read is refused, not ignored. */
function rejectUnknownQuery(query: Record<string, string | string[] | undefined>, allowed: readonly string[]): void {
  for (const key of Object.keys(query)) {
    if (key === 'userId') {
      throw new BadRequestException('userId is never accepted: the account comes from your session');
    }
    if (!allowed.includes(key)) {
      throw new BadRequestException(`${key} is not a query parameter this endpoint accepts`);
    }
    if (Array.isArray(query[key])) {
      throw new BadRequestException(`${key} may be sent only once`);
    }
  }
}

function pageNumber(
  query: Record<string, string | string[] | undefined>,
  key: 'page' | 'pageSize',
  fallback: number,
  max: number,
): number {
  const value = query[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) {
    throw new BadRequestException(`${key} must be a whole number`);
  }
  const parsed = Number(value);

  if (parsed < 1 || parsed > max) {
    throw new BadRequestException(`${key} must be between 1 and ${String(max)}`);
  }

  return parsed;
}

export function parseStudentCatalogQuery(
  query: Record<string, string | string[] | undefined>,
): StudentCatalogQuery {
  rejectUnknownQuery(query, STUDENT_CATALOG_FIELDS);
  const examId = optionalString(query, 'examId');

  return {
    page: pageNumber(query, 'page', 1, 10_000),
    pageSize: pageNumber(query, 'pageSize', DEFAULT_STUDENT_PAGE_SIZE, MAX_STUDENT_PAGE_SIZE),
    examId: examId === undefined ? undefined : parseUuid(examId, 'exam id'),
  };
}

export function parseEnrollmentPageQuery(
  query: Record<string, string | string[] | undefined>,
): StudentPageQuery {
  rejectUnknownQuery(query, STUDENT_PAGE_FIELDS);

  return {
    page: pageNumber(query, 'page', 1, 10_000),
    pageSize: pageNumber(query, 'pageSize', DEFAULT_STUDENT_PAGE_SIZE, MAX_ENROLLMENT_PAGE_SIZE),
  };
}

/** The enroll route takes no query parameters at all, and names `userId` when it sees one. */
export function parseEnrollQuery(query: Record<string, string | string[] | undefined>): void {
  rejectUnknownQuery(query, []);
}

/**
 * Enrollment takes no body. The account is the session's, so a `userId` is refused by name
 * rather than ignored — the same rule the wallet follows, made explicit where money moves.
 */
export function parseEnrollBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Send no body to enroll: the account comes from your session');
  }

  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (key === 'userId') {
      throw new BadRequestException('userId is never accepted: the account comes from your session');
    }
    throw new BadRequestException(`${key} is not a field this endpoint accepts`);
  }
}

/** The `Idempotency-Key` header an enroll request must carry. */
export function parseIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';

  if (key === '') {
    throw new BadRequestException('An Idempotency-Key header is required');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new BadRequestException(
      'An Idempotency-Key must be 8 to 100 characters of letters, digits, dot, colon, dash or underscore',
    );
  }

  return key;
}
