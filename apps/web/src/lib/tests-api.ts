/**
 * The test builder, called from server code only.
 *
 * The pages and their route handlers hold the access token in an httpOnly cookie and never
 * expose it. Every call here therefore runs on the server, and the API checks `tests.read`,
 * `tests.write` or `tests.publish` on each route whatever this tier believes about the person.
 * An editor's list and paper are their own because the API filters by the session's account.
 */

import { apiCall } from './upstream';

export interface TestOptionView {
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
  readonly isCorrect: boolean;
  readonly imageId: string | null;
}

export interface TestQuestionView {
  readonly questionId: string;
  readonly position: number;
  readonly questionStatus: string;
  readonly questionType: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly numericalAnswer: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly options: readonly TestOptionView[];
}

export interface TestVersionView {
  readonly version: number;
  readonly durationMinutes: number;
  readonly marksPerQuestion: string;
  readonly negativeMarksPerQuestion: string;
  readonly questionCount: number;
  readonly totalMarks: string;
  readonly publishedAt: string | null;
}

export interface TestView {
  readonly id: string;
  readonly examId: string;
  readonly createdBy: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly currentVersion: number;
  readonly maxAttempts: number | null;
  readonly submittedAt: string | null;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  readonly version: TestVersionView;
  readonly publishedVersion: TestVersionView | null;
  readonly questions: readonly TestQuestionView[];
}

export interface TestListResult {
  readonly items: readonly TestView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export interface TestListFilters {
  readonly status?: string;
  readonly examId?: string;
  readonly page?: number;
}

export interface TestPatternInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly durationMinutes?: number;
  readonly marksPerQuestion?: string;
  readonly negativeMarksPerQuestion?: string;
  readonly maxAttempts?: number | null;
}

export const TEST_STATUSES = ['DRAFT', 'SUBMITTED', 'PUBLISHED', 'ARCHIVED'] as const;

function queryString(filters: TestListFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && String(value) !== '') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return suffix === '' ? '' : `?${suffix}`;
}

export async function listTests(accessToken: string, filters: TestListFilters = {}): Promise<TestListResult | null> {
  const result = await apiCall<TestListResult>(`/v1/editor/tests${queryString(filters)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

export async function getTest(accessToken: string, id: string): Promise<TestView | null> {
  const result = await apiCall<TestView>(`/v1/editor/tests/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 ? result.body : null;
}

export function createTest(
  accessToken: string,
  input: { readonly examId: string; readonly title: string; readonly description?: string | null; readonly durationMinutes?: number },
) {
  return apiCall<TestView>('/v1/editor/tests', { method: 'POST', accessToken, body: input });
}

export function updateTest(accessToken: string, id: string, input: TestPatternInput) {
  return apiCall<TestView>(`/v1/editor/tests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    accessToken,
    body: input,
  });
}

export function setTestQuestions(accessToken: string, id: string, questionIds: readonly string[]) {
  return apiCall<TestView>(`/v1/editor/tests/${encodeURIComponent(id)}/questions`, {
    method: 'PUT',
    accessToken,
    body: { questionIds: [...questionIds] },
  });
}

export function submitTest(accessToken: string, id: string) {
  return apiCall<TestView>(`/v1/editor/tests/${encodeURIComponent(id)}/submit`, { method: 'POST', accessToken });
}

export function publishTest(accessToken: string, id: string) {
  return apiCall<TestView>(`/v1/admin/tests/${encodeURIComponent(id)}/publish`, { method: 'POST', accessToken });
}

export function archiveTest(accessToken: string, id: string) {
  return apiCall<TestView>(`/v1/admin/tests/${encodeURIComponent(id)}/archive`, { method: 'POST', accessToken });
}

/** The class names for one lifecycle state, used by the list and the builder header. */
export function statusTone(status: string): string {
  switch (status) {
    case 'PUBLISHED':
      return 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30';
    case 'SUBMITTED':
      return 'bg-sky-500/10 text-sky-300 ring-sky-500/30';
    case 'ARCHIVED':
      return 'bg-slate-500/10 text-slate-300 ring-slate-500/30';
    default:
      return 'bg-amber-500/10 text-amber-300 ring-amber-500/30';
  }
}

/** The answer key as one sentence, for the builder's question list. */
export function answerKeySentence(question: TestQuestionView): string {
  if (question.questionType === 'NUMERICAL') {
    return `Answer: ${question.numericalAnswer ?? 'not set'}`;
  }

  const correct = question.options.filter((option) => option.isCorrect).map((option) => option.position);
  return correct.length === 0 ? 'Answer key not set' : `Correct option: ${correct.join(', ')}`;
}
