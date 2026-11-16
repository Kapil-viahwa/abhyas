import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * A verified student with a funded wallet, an `OPEN` enrollment on a published paper and a
 * started attempt whose deadline has already passed — written directly in the e2e stack's
 * database.
 *
 * The real-worker sweeper spec needs an attempt to be *already expired* without any
 * student-facing read (a read would finalise it lazily and the test would pass for the wrong
 * reason), so the fixture starts it in SQL and then backdates `started_at` and `deadline_at`.
 * The backdate runs inside one transaction with `session_replication_role = replica`, which
 * disables the A1 `attempts_one_way` trigger for that transaction only; the e2e database's
 * owner (`abhyas`) is a superuser, which is what the setting requires.
 */

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): void {
  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

function querySql(sql: string): string {
  return execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-tAc', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  ).trim();
}

export interface StartedAttemptFixture {
  readonly attemptId: string;
  readonly enrollmentId: string;
  readonly userId: string;
}

export function seedStartedAttempt(input: {
  readonly testId: string;
  readonly marker: string;
  readonly email: string;
}): StartedAttemptFixture {
  const user = randomUUID();
  const credit = randomUUID();
  const charge = randomUUID();
  const enrollment = randomUUID();
  const attempt = randomUUID();
  const fingerprint = randomUUID().replace(/-/g, '').repeat(2);
  const email = input.email.replace(/'/g, "''");

  const sql = [
    'BEGIN;',
    `  INSERT INTO users (id, email, password_hash, full_name, role_id, status, email_verified_at)`,
    `  SELECT ${sqlLiteral(user)}::uuid, ${sqlLiteral(email)}, 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', 'E2E Sweeper Student', r.id, 'ACTIVE', now()`,
    `  FROM roles r WHERE r.code = 'USER';`,
    `  INSERT INTO coin_wallets (user_id, balance) VALUES (${sqlLiteral(user)}::uuid, 0);`,
    `  INSERT INTO coin_transactions (user_id, type, amount, previous_balance, new_balance, idempotency_key, request_fingerprint)`,
    `  VALUES (${sqlLiteral(user)}::uuid, 'ADMIN_CREDIT', 1000, 0, 1000, ${sqlLiteral(`e2e:credit:${input.marker}:${credit}`)}, ${sqlLiteral(fingerprint)});`,
    `  INSERT INTO coin_transactions (user_id, type, amount, previous_balance, new_balance, reference_type, reference_id, idempotency_key, request_fingerprint)`,
    `  VALUES (${sqlLiteral(user)}::uuid, 'ENROLLMENT', -100, 1000, 900, 'enrollment', ${sqlLiteral(attempt)}::uuid, ${sqlLiteral(`e2e:charge:${input.marker}:${charge}`)}, ${sqlLiteral(fingerprint)});`,
    `  INSERT INTO enrollments (id, test_id, test_version_id, user_id, attempt_number, status, coin_transaction_id, idempotency_key)`,
    `  SELECT ${sqlLiteral(enrollment)}::uuid, t.id, v.id, ${sqlLiteral(user)}::uuid, 1, 'OPEN', (SELECT id FROM coin_transactions WHERE idempotency_key = ${sqlLiteral(`e2e:charge:${input.marker}:${charge}`)}), ${sqlLiteral(`e2e:enroll:${input.marker}:${enrollment}`)}`,
    `  FROM tests t JOIN test_versions v ON v.test_id = t.id AND v.published_at IS NOT NULL WHERE t.id = ${sqlLiteral(input.testId)}::uuid;`,
    `  INSERT INTO attempts (id, enrollment_id, user_id, test_version_id, deadline_at)`,
    `  SELECT ${sqlLiteral(attempt)}::uuid, e.id, e.user_id, e.test_version_id, now() + interval '60 minutes' FROM enrollments e WHERE e.id = ${sqlLiteral(enrollment)}::uuid;`,
    '  SET LOCAL session_replication_role = replica;',
    `  UPDATE attempts SET started_at = now() - interval '61 minutes', deadline_at = now() - interval '1 minute' WHERE id = ${sqlLiteral(attempt)}::uuid;`,
    'COMMIT;',
  ].join('\n');

  runSql(sql);

  return { attemptId: attempt, enrollmentId: enrollment, userId: user };
}

/** The one reader the spec uses: the database itself, never a student-facing route. */
export function readAttemptState(attemptId: string): string {
  return querySql(
    `SELECT status || '|' || coalesce(submit_source, '') FROM attempts WHERE id = ${sqlLiteral(attemptId)}::uuid`,
  );
}

export function readAttemptCounts(attemptId: string): { readonly enrollmentStatus: string; readonly resultScore: string | null; readonly answers: string } {
  const enrollmentStatus = querySql(
    `SELECT e.status FROM enrollments e JOIN attempts a ON a.enrollment_id = e.id WHERE a.id = ${sqlLiteral(attemptId)}::uuid`,
  );
  const resultScore = querySql(`SELECT score::text FROM results WHERE attempt_id = ${sqlLiteral(attemptId)}::uuid`);
  const answers = querySql(`SELECT count(*)::text FROM attempt_answers WHERE attempt_id = ${sqlLiteral(attemptId)}::uuid`);

  return { enrollmentStatus, resultScore: resultScore === '' ? null : resultScore, answers };
}
