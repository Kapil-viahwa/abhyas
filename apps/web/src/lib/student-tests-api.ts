/**
 * The student side of the test catalog, called from server code only.
 *
 * The types here are copied field for field from `apps/api/src/tests/enrollments.service.ts`,
 * which is the only thing that decides them: `GET /v1/tests`, `GET /v1/tests/:id`,
 * `POST /v1/tests/:id/enroll` and `GET /v1/enrollments/me`. The access token stays in the
 * httpOnly cookie and never reaches a page.
 */

import { apiCall } from './upstream';

export interface StudentTestSummary {
  readonly id: string;
  readonly title: string;
  readonly exam: { readonly id: string; readonly name: string };
  readonly durationMinutes: number;
  readonly questionCount: number;
  readonly totalMarks: string;
  readonly marksPerQuestion: string;
  readonly negativeMarksPerQuestion: string;
  readonly cost: number;
  readonly maxAttempts: number | null;
}

export interface StudentEnrollmentState {
  readonly status: string;
  readonly attemptNumber: number | null;
  readonly enrollmentId: string | null;
  readonly attemptsUsed: number;
}

export interface StudentTestView extends StudentTestSummary {
  readonly enrollment: StudentEnrollmentState;
}

export interface StudentTestPage {
  readonly items: readonly StudentTestView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export interface EnrollmentView {
  readonly id: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly enrolledAt: string;
  readonly completedAt: string | null;
  readonly cost: number;
  readonly balanceAfter: number;
  readonly test: StudentTestSummary;
}

export interface EnrollmentPage {
  readonly items: readonly EnrollmentView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

export async function listStudentTests(accessToken: string, page = 1): Promise<StudentTestPage | null> {
  const result = await apiCall<StudentTestPage>(`/v1/tests?page=${String(page)}`, { method: 'GET', accessToken });

  return result.status === 200 && result.body !== null ? result.body : null;
}

export async function getStudentTest(accessToken: string, id: string): Promise<StudentTestView | null> {
  const result = await apiCall<StudentTestView>(`/v1/tests/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  });

  return result.status === 200 && result.body !== null ? result.body : null;
}

/** The caller's own enrollments, newest first. */
export async function listMyEnrollments(accessToken: string, page = 1): Promise<EnrollmentPage | null> {
  const result = await apiCall<EnrollmentPage>(`/v1/enrollments/me?page=${String(page)}`, { method: 'GET', accessToken });

  return result.status === 200 && result.body !== null ? result.body : null;
}

/**
 * One attempt of one paper. The key is the caller's own, generated once per render of the page
 * that shows the button, so a retry after a refusal replays the first request instead of
 * charging a second time.
 */
export async function enrollInTest(accessToken: string, id: string, idempotencyKey: string) {
  return apiCall<EnrollmentView>(`/v1/tests/${encodeURIComponent(id)}/enroll`, {
    method: 'POST',
    accessToken,
    body: {},
    headers: { 'idempotency-key': idempotencyKey },
  });
}

/** The student's own balance, so the enroll page can say what this will leave. */
export async function myBalance(accessToken: string): Promise<number | null> {
  const result = await apiCall<{ readonly balance: number }>('/v1/coins/me', { method: 'GET', accessToken });

  return result.status === 200 && result.body !== null ? result.body.balance : null;
}

/** The refusal codes the API sends beside its message (`ENROLLMENT_ERROR_CODES`). */
export const ENROLLMENT_REFUSALS = [
  'insufficient_coins',
  'open_enrollment',
  'attempt_cap_reached',
  'not_for_sale',
  'key_reused',
] as const;

export type EnrollmentRefusal = (typeof ENROLLMENT_REFUSALS)[number];

/** The code in an API error body, when it is one this screen knows how to explain. */
export function refusalCode(body: unknown): EnrollmentRefusal | null {
  if (typeof body !== 'object' || body === null || !('code' in body)) {
    return null;
  }

  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && (ENROLLMENT_REFUSALS as readonly string[]).includes(code)
    ? (code as EnrollmentRefusal)
    : null;
}

/** What a student reads for each refusal, and a safe sentence for everything else. */
export function refusalMessage(code: EnrollmentRefusal | null): string {
  switch (code) {
    case 'insufficient_coins':
      return 'You do not have enough coins for this test yet. Add coins to your wallet, then try again with the same button — the retry cannot charge you twice.';
    case 'open_enrollment':
      return 'You already have an open attempt at this test. Open it from your tests list.';
    case 'attempt_cap_reached':
      return 'You have used every attempt this test allows.';
    case 'not_for_sale':
      return 'This test is no longer available to enroll in.';
    default:
      return 'That enrollment could not be completed. Please try again.';
  }
}

/** A paper's state in a student's own words. */
export function enrollmentLabel(enrollment: StudentEnrollmentState): string {
  switch (enrollment.status) {
    case 'OPEN':
      return `Open attempt ${String(enrollment.attemptNumber ?? 1)}`;
    case 'COMPLETED':
      return `Attempt ${String(enrollment.attemptNumber ?? enrollment.attemptsUsed)} completed`;
    case 'EXPIRED':
      return `Attempt ${String(enrollment.attemptNumber ?? enrollment.attemptsUsed)} expired`;
    default:
      return 'Not enrolled';
  }
}
