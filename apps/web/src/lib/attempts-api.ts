/**
 * Phase 7, A4: the attempt API, called from the web tier only.
 *
 * The types are copied field for field from `apps/api/src/attempts/attempts.service.ts` and
 * `attempts.projection.ts`. Nothing here reads an answer key: the start projection has no
 * `isCorrect`, no numerical answer and no explanation, and this tier never asks for one.
 */

import { apiCall, type ApiResult } from './upstream';

export interface PaperOption {
  readonly id: string;
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
}

export interface PaperQuestion {
  readonly questionId: string;
  readonly position: number;
  readonly questionType: string;
  readonly contentHtml: string;
  readonly latex: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly options: readonly PaperOption[];
}

export interface AttemptState {
  readonly attemptId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly serverNow: string;
  readonly remainingSeconds: number;
  readonly submittedAt: string | null;
  readonly submitSource: string | null;
}

export interface AttemptStart extends AttemptState {
  readonly questions: readonly PaperQuestion[];
}

export interface AttemptResult {
  readonly attemptId: string;
  readonly status: string;
  readonly submitSource: string | null;
  readonly submittedAt: string | null;
  readonly score: string;
  readonly correctCount: number;
  readonly wrongCount: number;
  readonly unattemptedCount: number;
  readonly attemptedCount: number;
  readonly totalQuestions: number;
  readonly totalMarks: string;
  readonly accuracy: string;
}

export interface SubmittedAnswer {
  readonly questionId: string;
  readonly chosenOptionId: string;
}

/** The attempt this enrollment has, or null before a start, or why it could not be read. */
export type EnrollmentAttempt =
  | { readonly kind: 'attempt'; readonly attempt: AttemptState | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unauthorised' };

/** A state envelope from the API, read defensively: a shape it did not promise is unusable. */
function readAttemptState(value: unknown): AttemptState | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return typeof record.attemptId === 'string' && typeof record.status === 'string'
    ? (record as unknown as AttemptState)
    : null;
}

/**
 * The attempt an enrollment has. `missing` is "not yours, or not there" — the API answers 404
 * for both so a student cannot probe another student's ids.
 */
export async function attemptForEnrollment(
  accessToken: string,
  enrollmentId: string,
): Promise<EnrollmentAttempt> {
  const result = await apiCall<{ attempt: unknown }>(
    `/v1/enrollments/${encodeURIComponent(enrollmentId)}/attempt`,
    { method: 'GET', accessToken },
  );

  if (result.status === 404) {
    return { kind: 'missing' };
  }
  if (result.status === 401) {
    // A stale access token the caller can still refresh: kept apart from a real failure.
    return { kind: 'unauthorised' };
  }
  if (result.status !== 200 || result.body === null || typeof result.body !== 'object') {
    return { kind: 'unavailable' };
  }

  const attempt = result.body.attempt;
  if (attempt === null || attempt === undefined) {
    return { kind: 'attempt', attempt: null };
  }

  const state = readAttemptState(attempt);
  return state === null ? { kind: 'unavailable' } : { kind: 'attempt', attempt: state };
}

export function startAttempt(accessToken: string, enrollmentId: string): Promise<ApiResult<AttemptStart>> {
  return apiCall<AttemptStart>(`/v1/enrollments/${encodeURIComponent(enrollmentId)}/attempt`, {
    method: 'POST',
    accessToken,
  });
}

export function attemptState(accessToken: string, attemptId: string): Promise<ApiResult<AttemptState>> {
  return apiCall<AttemptState>(`/v1/attempts/${encodeURIComponent(attemptId)}`, { method: 'GET', accessToken });
}

export function submitAttempt(
  accessToken: string,
  attemptId: string,
  answers: readonly SubmittedAnswer[],
): Promise<ApiResult<AttemptResult>> {
  return apiCall<AttemptResult>(`/v1/attempts/${encodeURIComponent(attemptId)}/submit`, {
    method: 'POST',
    accessToken,
    body: { answers },
  });
}

export function attemptResult(accessToken: string, attemptId: string): Promise<ApiResult<AttemptResult>> {
  return apiCall<AttemptResult>(`/v1/attempts/${encodeURIComponent(attemptId)}/result`, {
    method: 'GET',
    accessToken,
  });
}

/** The stable codes the attempt routes send; anything else is a generic sentence. */
export const ATTEMPT_REFUSALS = [
  'attempt_already_started',
  'attempt_expired',
  'attempt_in_progress',
  'enrollment_not_open',
  'paper_not_frozen',
] as const;

export type AttemptRefusal = (typeof ATTEMPT_REFUSALS)[number];

export function attemptRefusalCode(body: unknown): AttemptRefusal | null {
  if (typeof body !== 'object' || body === null || !('code' in body)) {
    return null;
  }

  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && (ATTEMPT_REFUSALS as readonly string[]).includes(code)
    ? (code as AttemptRefusal)
    : null;
}

/**
 * A test's decimal accuracy as a percentage, by moving the decimal point — never by
 * multiplying a float. `0.3333` becomes `33.33`, `1.0000` becomes `100.00`. A value that is
 * not a plain decimal is returned unchanged rather than guessed at.
 */
export function accuracyPercent(accuracy: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(accuracy)) {
    return accuracy;
  }

  const [whole = '0', fraction = ''] = accuracy.split('.');
  const padded = `${fraction}0000`.slice(0, 4);
  const percent = Number(whole) * 100 + Number(padded.slice(0, 2));

  return `${String(percent)}.${padded.slice(2)}`;
}

