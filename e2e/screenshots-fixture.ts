import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

/**
 * Fixtures for the screenshot gallery only.
 *
 * The gallery is an observation tool, not a test of behaviour, so it creates everything it
 * photographs: its own accounts (with clearly fake `@example.com` addresses), its own exam and
 * question bank, and its own papers. It never reads or prints a real row.
 *
 * Like `./tests-fixture` and `./attempts-fixture`, rows are written with one `psql` call against
 * the e2e stack's own database — the same route the other specs use — so nothing test-only is
 * added to the application. Accounts and passwords go through the real register form and the real
 * verification link, because a session cookie cannot be faked from SQL.
 */

export function galleryMarker(): string {
  return randomUUID().slice(0, 8);
}

export function runSql(sql: string): void {
  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

export function querySql(sql: string): string {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-tAc', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  ).trim();
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The API's own log, which is where the console outbox puts verification and reset mails. */
export function apiLogs(): string {
  return execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Waits for a link that appeared after `before`, so an older mail cannot match. */
export async function waitForLink(before: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000;
  const searchable = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);

  while (Date.now() < deadline) {
    const logs = apiLogs();
    const start = logs.indexOf(before);
    const fresh = start >= 0 ? logs.slice(start + before.length) : logs;
    const match = [...fresh.matchAll(searchable)].at(-1);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`No mail link matching ${String(pattern)} appeared in the API log`);
}

/**
 * Registers an account through the real form and follows the real verification link.
 *
 * The gallery needs three roles signed in at once, and the API has no seed in the e2e stack, so
 * this is the same path a person takes. Nothing is stubbed.
 */
export async function registerAccount(
  page: Page,
  input: { readonly fullName: string; readonly email: string; readonly password: string },
): Promise<void> {
  await page.goto('/register');
  await page.fill('input[name="fullName"]', input.fullName);
  await page.fill('input[name="email"]', input.email);
  await page.fill('input[name="password"]', input.password);

  const before = apiLogs();
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/verify-email\?sent=1/);

  const token = await waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/);
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
  await page.getByRole('heading', { name: 'Email verified' }).waitFor({ state: 'visible' });
}

/**
 * A fixture, not behaviour under test: the e2e stack has no admin seed, and the gallery needs an
 * Administrator, an Editor and a Student. One statement against the stack's own database.
 */
export function setRole(email: string, roleCode: 'USER' | 'EDITOR' | 'ADMIN'): void {
  runSql(
    `UPDATE users SET role_id = (SELECT id FROM roles WHERE code = ${sqlLiteral(roleCode)}) WHERE email = ${sqlLiteral(email)};`,
  );
}

export function userIdByEmail(email: string): string {
  return querySql(`SELECT id::text FROM users WHERE email = ${sqlLiteral(email)};`);
}

export interface GalleryPaper {
  readonly testId: string;
  readonly versionId: string;
}

/**
 * A DRAFT paper with the given questions placed, written the way the editor's own builder leaves
 * one: the version is unpublished and the placements are pinned to each question's current version
 * (A5b), which is what the builder screen shows before Submit.
 */
export function seedDraftPaper(input: {
  readonly authorId: string;
  readonly examId: string;
  readonly questionIds: readonly string[];
  readonly title: string;
  readonly durationMinutes?: number;
}): GalleryPaper {
  if (input.questionIds.length === 0) {
    throw new Error('A seeded draft needs at least one question');
  }

  const test = randomUUID();
  const version = randomUUID();
  const positions = input.questionIds
    .map((questionId, index) => `    (${sqlLiteral(version)}::uuid, ${sqlLiteral(questionId)}::uuid, ${String(index + 1)})`)
    .join(',\n');

  runSql(
    [
      'DO $$',
      'BEGIN',
      `  INSERT INTO tests (id, exam_id, created_by, title, status, current_version, max_attempts)`,
      `  VALUES (${sqlLiteral(test)}::uuid, ${sqlLiteral(input.examId)}::uuid, ${sqlLiteral(input.authorId)}::uuid, ${sqlLiteral(input.title)}, 'DRAFT', 1, NULL);`,
      `  INSERT INTO test_versions (id, test_id, version, duration_minutes, marks_per_question, negative_marks_per_question, created_by)`,
      `  VALUES (${sqlLiteral(version)}::uuid, ${sqlLiteral(test)}::uuid, 1, ${String(input.durationMinutes ?? 45)}, 2, 0.5, ${sqlLiteral(input.authorId)}::uuid);`,
      '  INSERT INTO test_questions (test_version_id, question_id, position) VALUES',
      `${positions};`,
      `  UPDATE test_questions tq SET question_version_id = qv.id FROM questions q, question_versions qv`,
      `  WHERE qv.question_id = q.id AND qv.version = q.current_version`,
      `    AND tq.question_id = q.id AND tq.test_version_id = ${sqlLiteral(version)}::uuid;`,
      'END $$;',
    ].join('\n'),
  );

  return { testId: test, versionId: version };
}

/** Moves a draft to SUBMITTED the way the builder's Submit does, so the list shows both states. */
export function submitPaper(testId: string): void {
  runSql(`UPDATE tests SET status = 'SUBMITTED' WHERE id = ${sqlLiteral(testId)}::uuid;`);
}

/**
 * The ids the gallery needs from a finished attempt: the attempt behind a result page, and the
 * enrollment that produced it.
 *
 * It reads the database, never a student-facing route: the point is to navigate the pages, and a
 * page read would finalise a live attempt as a side effect.
 */
export function latestAttemptForUser(userId: string): { readonly attemptId: string; readonly enrollmentId: string } {
  const row = querySql(
    `SELECT a.id::text || '|' || a.enrollment_id::text FROM attempts a WHERE a.user_id = ${sqlLiteral(userId)}::uuid ORDER BY a.started_at DESC LIMIT 1;`,
  );
  const [attemptId = '', enrollmentId = ''] = row.split('|');

  return { attemptId, enrollmentId };
}

/** Closes an enrollment that never had an attempt, for the not-available screen. */
export function closeEnrollment(enrollmentId: string): void {
  runSql(
    [
      'BEGIN;',
      '  SET LOCAL session_replication_role = replica;',
      `  UPDATE enrollments SET status = 'COMPLETED', completed_at = now() WHERE id = ${sqlLiteral(enrollmentId)}::uuid;`,
      'COMMIT;',
    ].join('\n'),
  );
}
