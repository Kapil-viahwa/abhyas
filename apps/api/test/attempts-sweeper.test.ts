import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { AttemptsService } from '../src/attempts/attempts.service';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Phase 7, A3b: the internal expiry sweeper over real HTTP and Postgres.
 *
 * Proven here: an expired attempt is ended once by the sweeper through the same
 * `finalizeExpiredAttempt` the lazy reads use — `AUTO_SUBMITTED`, source `SWEEPER`, an empty
 * result, an `EXPIRED` enrollment and no answers; an attempt not yet due, one inside the grace
 * window and one already submitted are untouched; two simultaneous sweeps finalise each attempt
 * once between them; a sweep racing a student's submit produces one result; a batch larger than
 * the cap is worked in capped batches; one failing attempt does not block the others; and the
 * internal route answers 404 to every wrong caller.
 *
 * A database test owns its own schema, so the sweeper's global query can only see this file's
 * attempts; each test ends with its own attempts finalised so a later test's counts are exact.
 */

const PASSWORD = 'correct-horse-9battery';
const INTERNAL_SECRET = 'attempts-sweeper-secret-0123456789';
const GRACE_SETTING = 'attempt_submit_grace_seconds';
const DURATION_MINUTES = 60;
const MARKS = '2';
const NEGATIVE = '0.5';

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

async function waitUntilHealthy(target: NestFastifyApplication, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';

  while (Date.now() < deadline) {
    const response = await target.inject({ method: 'GET', url: '/health' });
    if (response.statusCode === 200) {
      return;
    }
    last = `${response.statusCode} ${response.body}`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`The API never became healthy: ${last}`);
}

interface Person {
  readonly id: string;
  readonly token: string;
}

interface PaperQuestion {
  readonly id: string;
  readonly correctOptionId: string;
}

interface Paper {
  readonly testId: string;
  readonly versionId: string;
  readonly questions: readonly PaperQuestion[];
}

interface SweepBody {
  readonly finalized: number;
  readonly skipped: number;
  readonly failed: number;
}

describe('the attempt expiry sweeper', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  let admin!: Person;
  let editor!: Person;
  let student!: Person;
  let exam = '';
  let subject = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('attempts_sweeper');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
    process.env.S3_ENDPOINT = 'memory:';
    process.env.S3_BUCKET = 'abhyas-media';
    process.env.S3_ACCESS_KEY_ID = 'abhyas-dev';
    process.env.S3_SECRET_ACCESS_KEY = 'abhyas-dev-secret';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitUntilHealthy(app);

    admin = await makePerson('ADMIN', [], null);
    editor = await makePerson('EDITOR', ['content.write', 'tests.write'], admin.id);
    student = await makePerson('USER', [], null);

    const category = await db.client.examCategory.create({
      data: { name: 'Sweeper Category', slug: `sweep-cat-${randomUUID().slice(0, 8)}`, createdBy: admin.id },
      select: { id: true },
    });

    exam = (
      await db.client.exam.create({
        data: {
          categoryId: category.id,
          name: 'Sweeper Exam',
          slug: `sweep-exam-${randomUUID().slice(0, 8)}`,
          createdBy: editor.id,
        },
        select: { id: true },
      })
    ).id;

    subject = (
      await db.client.subject.create({
        data: { examId: exam, name: 'Reasoning', slug: `sweep-sub-${randomUUID().slice(0, 8)}`, createdBy: editor.id },
        select: { id: true },
      })
    ).id;

    await pinGrace(5);
  }, 240_000);

  afterAll(async () => {
    await pinGrace(5).catch(() => undefined);
    await app?.close();
    await redis?.quit();
    await db?.dispose();

    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

  async function makePerson(
    roleCode: 'USER' | 'EDITOR' | 'ADMIN',
    permissions: readonly string[],
    grantedBy: string | null,
  ): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `p7-sweep-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Sweeper Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    for (const code of permissions) {
      const permission = await db.client.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      await db.client.userPermission.create({ data: { userId: user.id, permissionId: permission.id, grantedBy } });
    }

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  function fingerprint(): string {
    return randomUUID().replace(/-/g, '').repeat(2);
  }

  async function newQuestion(): Promise<PaperQuestion> {
    const question = await db.client.question.create({
      data: { examId: exam, subjectId: subject, createdBy: editor.id, status: 'PUBLISHED', currentVersion: 1 },
      select: { id: true },
    });

    const version = await db.client.questionVersion.create({
      data: {
        questionId: question.id,
        version: 1,
        questionType: 'MCQ',
        language: 'EN',
        difficulty: 'MEDIUM',
        contentHtml: '<p>Which of these is prime?</p>',
        explanationHtml: '<p>Seven has no divisors.</p>',
        marks: MARKS,
        negativeMarks: NEGATIVE,
        createdBy: editor.id,
        publishedAt: null,
        options: {
          create: [
            { position: 1, optionHtml: '<p>4</p>', isCorrect: false },
            { position: 2, optionHtml: '<p>7</p>', isCorrect: true },
            { position: 3, optionHtml: '<p>9</p>', isCorrect: false },
          ],
        },
      },
      select: { id: true },
    });

    await db.client.questionVersion.update({
      where: { questionId_version: { questionId: question.id, version: 1 } },
      data: { publishedAt: new Date() },
    });

    const options = await db.client.questionOption.findMany({
      where: { versionId: version.id },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    return { id: question.id, correctOptionId: options[1]?.id ?? '' };
  }

  async function newPaper(): Promise<Paper> {
    const test = await db.client.test.create({
      data: { examId: exam, createdBy: editor.id, title: `Sweeper Paper ${randomUUID().slice(0, 8)}` },
      select: { id: true },
    });

    const version = await db.client.testVersion.create({
      data: {
        testId: test.id,
        version: 1,
        durationMinutes: DURATION_MINUTES,
        marksPerQuestion: MARKS,
        negativeMarksPerQuestion: NEGATIVE,
        createdBy: editor.id,
      },
      select: { id: true },
    });

    const questions = [await newQuestion(), await newQuestion(), await newQuestion()];

    await db.client.testQuestion.createMany({
      data: questions.map((question, index) => ({
        testVersionId: version.id,
        questionId: question.id,
        position: index + 1,
      })),
    });

    await db.client.$executeRawUnsafe(
      `UPDATE "test_versions" SET "published_at" = now() WHERE "id" = $1::uuid`,
      version.id,
    );

    return { testId: test.id, versionId: version.id, questions };
  }

  async function newEnrollment(paper: Paper, owner: Person): Promise<string> {
    const wallet = await db.client.coinWallet.upsert({
      where: { userId: owner.id },
      create: { userId: owner.id, balance: 0 },
      update: {},
      select: { balance: true },
    });

    const topUp = Math.max(0, 1_000 - wallet.balance);
    if (topUp > 0) {
      await db.client.coinTransaction.create({
        data: {
          userId: owner.id,
          type: 'ADMIN_CREDIT',
          amount: topUp,
          previousBalance: wallet.balance,
          newBalance: wallet.balance + topUp,
          idempotencyKey: `topup:${randomUUID()}`,
          requestFingerprint: fingerprint(),
        },
      });
    }

    const balance = wallet.balance + topUp;
    const charge = await db.client.coinTransaction.create({
      data: {
        userId: owner.id,
        type: 'ENROLLMENT',
        amount: -100,
        previousBalance: balance,
        newBalance: balance - 100,
        referenceType: 'enrollment',
        referenceId: randomUUID(),
        idempotencyKey: `enroll:${randomUUID()}`,
        requestFingerprint: fingerprint(),
      },
      select: { id: true },
    });

    const enrollment = await db.client.enrollment.create({
      data: {
        testId: paper.testId,
        testVersionId: paper.versionId,
        userId: owner.id,
        coinTransactionId: charge.id,
        idempotencyKey: `enroll:${randomUUID()}`,
      },
      select: { id: true },
    });

    return enrollment.id;
  }

  /** A fresh paper, a fresh enrollment and a started attempt, ready to be expired. */
  async function newStartedAttempt(): Promise<{ attemptId: string; enrollmentId: string; paper: Paper }> {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await app.inject({
      method: 'POST',
      url: `/v1/enrollments/${enrollmentId}/attempt`,
      headers: { authorization: `Bearer ${student.token}` },
    });
    expect(started.statusCode, started.body).toBe(201);

    return { attemptId: (started.json() as { attemptId: string }).attemptId, enrollmentId, paper };
  }

  /**
   * Moves an attempt's start and deadline into the past. One interactive transaction with
   * `session_replication_role = replica` disables the A1 triggers for that transaction only; the
   * connection is the migration owner, which is a superuser in the compose and CI database.
   */
  async function backdate(attemptId: string, minutesPastDeadline: number): Promise<void> {
    await db.client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRawUnsafe(
        `UPDATE "attempts"
         SET "deadline_at" = now() - ($2::int * interval '1 minute'),
             "started_at" = now() - (($2::int + $1::int) * interval '1 minute')
         WHERE "id" = $3::uuid`,
        DURATION_MINUTES,
        minutesPastDeadline,
        attemptId,
      );
    });
  }

  async function pinGrace(seconds: number): Promise<void> {
    await db.client.setting.update({ where: { key: GRACE_SETTING }, data: { valueInt: seconds } });
    const row = await db.client.setting.findUniqueOrThrow({ where: { key: GRACE_SETTING }, select: { valueInt: true } });
    expect(row.valueInt).toBe(seconds);
  }

  function sweep(
    batchSize?: number,
    options: { readonly secret?: string | null; readonly headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    const secret = options.secret === undefined ? INTERNAL_SECRET : options.secret;
    if (secret !== null) {
      headers['x-internal-secret'] = secret;
    }

    return app.inject({
      method: 'POST',
      url: '/v1/internal/attempts/expire-expired',
      headers,
      payload: batchSize === undefined ? {} : { batchSize },
    });
  }

  async function attemptRow(attemptId: string) {
    return db.client.attempt.findUniqueOrThrow({
      where: { id: attemptId },
      select: { status: true, submitSource: true, enrollmentId: true },
    });
  }

  // -------------------------------------------------------------------------
  // The sweeper's work
  // -------------------------------------------------------------------------

  it('finalises an expired attempt once: SWEEPER, an empty result, an EXPIRED enrollment, no answers', async () => {
    const { attemptId, enrollmentId } = await newStartedAttempt();
    await backdate(attemptId, 10);

    const response = await sweep();
    expect(response.statusCode, response.body).toBe(200);

    const body = response.json() as SweepBody;
    expect(body).toEqual({ finalized: 1, skipped: 0, failed: 0 });
    // Counts only: no attempt id, question, option or answer in the response.
    expect(Object.keys(body).sort()).toEqual(['failed', 'finalized', 'skipped']);

    const attempt = await attemptRow(attemptId);
    expect(attempt.status).toBe('AUTO_SUBMITTED');
    expect(attempt.submitSource).toBe('SWEEPER');

    const result = await db.client.result.findUniqueOrThrow({ where: { attemptId } });
    expect(result.score.toString()).toBe('0');
    expect(result.attemptedCount).toBe(0);
    expect(result.unattemptedCount).toBe(3);
    expect(result.accuracy.toString()).toBe('0');

    const enrollment = await db.client.enrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
      select: { status: true },
    });
    expect(enrollment.status).toBe('EXPIRED');
    expect(await db.client.attemptAnswer.count({ where: { attemptId } })).toBe(0);
    expect(await db.client.result.count({ where: { attemptId } })).toBe(1);
  });

  it('leaves an attempt that is not due, one inside the grace window and one already submitted alone', async () => {
    const notDue = await newStartedAttempt();

    await pinGrace(60);
    const insideGrace = await newStartedAttempt();
    await backdate(insideGrace.attemptId, 0);

    const submitted = await newStartedAttempt();
    const submittedResponse = await app.inject({
      method: 'POST',
      url: `/v1/attempts/${submitted.attemptId}/submit`,
      headers: { authorization: `Bearer ${student.token}` },
      payload: {
        answers: [
          {
            questionId: submitted.paper.questions[0]?.id ?? '',
            chosenOptionId: submitted.paper.questions[0]?.correctOptionId ?? '',
          },
        ],
      },
    });
    expect(submittedResponse.statusCode, submittedResponse.body).toBe(200);

    const response = await sweep();
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as SweepBody;
    expect(body.finalized).toBe(0);

    expect((await attemptRow(notDue.attemptId)).status).toBe('IN_PROGRESS');
    expect((await attemptRow(insideGrace.attemptId)).status).toBe('IN_PROGRESS');
    expect(await db.client.result.count({ where: { attemptId: insideGrace.attemptId } })).toBe(0);
    expect((await attemptRow(submitted.attemptId)).status).toBe('SUBMITTED');
    expect(await db.client.result.count({ where: { attemptId: submitted.attemptId } })).toBe(1);

    // Clean up: end this test's expired-able attempts so a later test's counts stay exact.
    await pinGrace(5);
    await backdate(insideGrace.attemptId, 10);
    const cleanup = await sweep();
    expect(cleanup.statusCode, cleanup.body).toBe(200);
    expect(((await attemptRow(insideGrace.attemptId)).status)).toBe('AUTO_SUBMITTED');
  });

  it('finalises each attempt exactly once when two sweeps run at the same time', async () => {
    const { attemptId } = await newStartedAttempt();
    await backdate(attemptId, 10);

    const [first, second] = await Promise.all([sweep(), sweep()]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);

    const totals = [first.json() as SweepBody, second.json() as SweepBody].reduce(
      (sum, body) => sum + body.finalized,
      0,
    );
    expect(totals).toBe(1);
    expect(await db.client.result.count({ where: { attemptId } })).toBe(1);
    expect(await db.client.attempt.count({ where: { id: attemptId, status: 'AUTO_SUBMITTED' } })).toBe(1);
  });

  it('gives one result when the sweeper races a student’s submit', async () => {
    const { attemptId, enrollmentId } = await newStartedAttempt();
    await backdate(attemptId, 10);

    const [swept, submitted] = await Promise.all([
      sweep(),
      app.inject({
        method: 'POST',
        url: `/v1/attempts/${attemptId}/submit`,
        headers: { authorization: `Bearer ${student.token}` },
        payload: { answers: [] },
      }),
    ]);

    expect(swept.statusCode, swept.body).toBe(200);
    // The submit either reached the attempt first — and ended it through the same finalisation,
    // with source LAZY — or arrived after the sweep had ended it, and is answered from the result.
    expect([200, 409]).toContain(submitted.statusCode);

    const attempt = await attemptRow(attemptId);
    // Both orders end an expired attempt with an empty auto-submission. Only the source differs,
    // and both are the documented ones: any caller may finalise (decision 0078), so the submit's
    // own expiry path writes LAZY and the sweeper writes SWEEPER. The late answers are scored in
    // neither case, which is what this test is about.
    expect(attempt.status).toBe('AUTO_SUBMITTED');
    expect(['SWEEPER', 'LAZY']).toContain(attempt.submitSource);

    // Whatever the order, exactly one result exists, it is the empty one, and the enrollment ended.
    expect(await db.client.result.count({ where: { attemptId } })).toBe(1);
    const result = await db.client.result.findUniqueOrThrow({ where: { attemptId } });
    expect(result.score.toString()).toBe('0');
    expect(result.attemptedCount).toBe(0);
    expect(result.unattemptedCount).toBe(3);
    expect(await db.client.attemptAnswer.count({ where: { attemptId } })).toBe(0);

    const enrollment = await db.client.enrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
      select: { status: true },
    });
    expect(enrollment.status).toBe('EXPIRED');
  });

  it('works a batch larger than the cap in capped batches', async () => {
    const first = await newStartedAttempt();
    const second = await newStartedAttempt();
    const third = await newStartedAttempt();
    for (const attempt of [first, second, third]) {
      await backdate(attempt.attemptId, 10 + Math.floor(Math.random() * 5));
    }

    const capped = await sweep(2);
    expect(capped.statusCode, capped.body).toBe(200);
    expect((capped.json() as SweepBody).finalized).toBe(2);

    const rest = await sweep(2);
    expect(rest.statusCode, rest.body).toBe(200);
    expect((rest.json() as SweepBody).finalized).toBe(1);

    for (const attempt of [first, second, third]) {
      expect((await attemptRow(attempt.attemptId)).status).toBe('AUTO_SUBMITTED');
      expect(await db.client.result.count({ where: { attemptId: attempt.attemptId } })).toBe(1);
    }
  });

  it('does not let one failing attempt stop the others', async () => {
    const first = await newStartedAttempt();
    const second = await newStartedAttempt();
    await backdate(first.attemptId, 10);
    await backdate(second.attemptId, 11);

    const service = app.get(AttemptsService);
    const real = service.finalizeExpiredAttempt.bind(service);
    let calls = 0;
    const spy = vi.spyOn(service, 'finalizeExpiredAttempt').mockImplementation(async (attemptId, source) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('simulated finalisation failure');
      }
      return real(attemptId, source);
    });

    try {
      const response = await sweep();
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ finalized: 1, skipped: 0, failed: 1 });
    } finally {
      spy.mockRestore();
    }

    // One of the two ended; the other is still running and the next sweep finalises it.
    const statuses = [(await attemptRow(first.attemptId)).status, (await attemptRow(second.attemptId)).status].sort();
    expect(statuses).toEqual(['AUTO_SUBMITTED', 'IN_PROGRESS']);

    const retry = await sweep();
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await attemptRow(first.attemptId)).status).toBe('AUTO_SUBMITTED');
    expect((await attemptRow(second.attemptId)).status).toBe('AUTO_SUBMITTED');
  });

  it('refuses an anonymous caller, a student session, a wrong secret and a non-allowlisted address', async () => {
    const { attemptId } = await newStartedAttempt();
    await backdate(attemptId, 10);

    const anonymous = await sweep(undefined, { secret: null });
    expect(anonymous.statusCode).toBe(404);

    const asStudent = await sweep(undefined, {
      secret: null,
      headers: { authorization: `Bearer ${student.token}` },
    });
    expect(asStudent.statusCode).toBe(404);

    const wrong = await sweep(undefined, { secret: 'wrong-secret' });
    expect(wrong.statusCode).toBe(404);

    const elsewhere = await sweep(undefined, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(elsewhere.statusCode).toBe(404);

    // None of those refusals ended the attempt.
    expect((await attemptRow(attemptId)).status).toBe('IN_PROGRESS');
    expect(await db.client.result.count({ where: { attemptId } })).toBe(0);

    const accepted = await sweep();
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await attemptRow(attemptId)).status).toBe('AUTO_SUBMITTED');
  });
});
