import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Phase 7, A3a: the attempt API over real HTTP, against Postgres, the real guard and the real
 * row locks.
 *
 * Proven here: one start per enrollment, the deadline computed by the database from the same
 * clock as `started_at`, the paper delivered once and in order with no answer key; the state
 * read without the paper; one submit, idempotent, whose score is the scoring function's; the
 * grace window; a late submit discarded and the attempt ended with an empty result; lazy expiry
 * finalising exactly once under parallel reads and a submit race; the result, refused until the
 * attempt ends and the only response that carries the key; and every refusal leaving the database
 * unchanged.
 */

const PASSWORD = 'correct-horse-9battery';
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
  readonly optionIds: readonly string[];
  readonly correctOptionId: string;
  readonly wrongOptionId: string;
}

interface Paper {
  readonly testId: string;
  readonly versionId: string;
  readonly questions: readonly PaperQuestion[];
}

interface AttemptStart {
  readonly attemptId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly serverNow: string;
  readonly remainingSeconds: number;
  readonly questions: Array<{
    readonly questionId: string;
    readonly position: number;
    readonly questionType: string;
    readonly contentHtml: string;
    readonly marks: string;
    readonly negativeMarks: string;
    readonly options: Array<{ readonly id: string; readonly position: number; readonly optionHtml: string }>;
  }>;
}

interface AttemptState {
  readonly attemptId: string;
  readonly status: string;
  readonly remainingSeconds: number;
  readonly serverNow: string;
  readonly submitSource: string | null;
  readonly submittedAt: string | null;
}

interface AttemptResult {
  readonly attemptId: string;
  readonly status: string;
  readonly submitSource: string | null;
  readonly score: string;
  readonly correctCount: number;
  readonly wrongCount: number;
  readonly unattemptedCount: number;
  readonly attemptedCount: number;
  readonly totalQuestions: number;
  readonly totalMarks: string;
  readonly accuracy: string;
  readonly review: Array<{
    readonly questionId: string;
    readonly chosenOptionId: string | null;
    readonly correctOptionId: string | null;
    readonly explanationHtml: string | null;
    readonly options: Array<{ readonly id: string; readonly isCorrect: boolean; readonly isChosen: boolean }>;
  }>;
}

const KEY_NAMES = new Set(['iscorrect', 'is_correct', 'correct', 'numericalanswer', 'explanation', 'solution']);

/** Every key name anywhere in a response, lower-cased, so a nested key cannot hide. */
function keyNames(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      keyNames(item, found);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      found.add(key.toLowerCase());
      keyNames(nested, found);
    }
  }
  return found;
}

function expectNoAnswerKey(body: unknown): void {
  const leaked = [...keyNames(body)].filter((name) => KEY_NAMES.has(name));
  expect(leaked).toEqual([]);
}

describe('the attempt API over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  let admin!: Person;
  let editor!: Person;
  let student!: Person;
  let otherStudent!: Person;
  let exam = '';
  let subject = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('attempts_api');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
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
    otherStudent = await makePerson('USER', [], null);

    const category = await db.client.examCategory.create({
      data: { name: 'Attempts API Category', slug: `att-cat-${randomUUID().slice(0, 8)}`, createdBy: admin.id },
      select: { id: true },
    });

    exam = (
      await db.client.exam.create({
        data: {
          categoryId: category.id,
          name: 'Attempts API Exam',
          slug: `att-exam-${randomUUID().slice(0, 8)}`,
          createdBy: editor.id,
        },
        select: { id: true },
      })
    ).id;

    subject = (
      await db.client.subject.create({
        data: { examId: exam, name: 'Reasoning', slug: `att-sub-${randomUUID().slice(0, 8)}`, createdBy: editor.id },
        select: { id: true },
      })
    ).id;
  }, 240_000);

  afterAll(async () => {
    await redis?.del(GRACE_SETTING);
    await db?.client.setting.update({ where: { key: GRACE_SETTING }, data: { valueInt: 5 } }).catch(() => undefined);
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
  // Harness and fixtures
  // -------------------------------------------------------------------------

  function call(
    method: 'GET' | 'POST',
    url: string,
    token: string | null,
    payload?: Record<string, unknown>,
  ) {
    const headers: Record<string, string> = {};
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  async function makePerson(
    roleCode: 'USER' | 'EDITOR' | 'ADMIN',
    permissions: readonly string[],
    grantedBy: string | null,
  ): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `p7-attempt-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Attempt Person',
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

  /** A 64-hex fingerprint, the shape `coin_transactions_fingerprint_format` requires. */
  function fingerprint(): string {
    return randomUUID().replace(/-/g, '').repeat(2);
  }

  /** A published question with three options, written in the order the freeze allows. */
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

    const [first, second, third] = options.map((option) => option.id);
    return {
      id: question.id,
      optionIds: options.map((option) => option.id),
      correctOptionId: second ?? '',
      wrongOptionId: first ?? third ?? '',
    };
  }

  /** A frozen paper of three questions with a 60-minute duration. */
  async function newPaper(): Promise<Paper> {
    const test = await db.client.test.create({
      data: { examId: exam, createdBy: editor.id, title: `Attempt Paper ${randomUUID().slice(0, 8)}` },
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

  /** An OPEN enrollment written the way the enrollment service writes one: a funded wallet, a ledger row, the row. */
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

  async function start(enrollmentId: string, owner: Person = student) {
    return call('POST', `/v1/enrollments/${enrollmentId}/attempt`, owner.token);
  }

  function submit(attemptId: string, answers: readonly { questionId: string; chosenOptionId: string }[], owner = student) {
    return call('POST', `/v1/attempts/${attemptId}/submit`, owner.token, { answers: [...answers] });
  }

  function state(attemptId: string, owner = student) {
    return call('GET', `/v1/attempts/${attemptId}`, owner.token);
  }

  function result(attemptId: string, owner = student) {
    return call('GET', `/v1/attempts/${attemptId}/result`, owner.token);
  }

  /**
   * Moves an attempt's start and deadline into the past without touching production code: one
   * interactive transaction with `session_replication_role = replica` disables the A1 triggers
   * (which overwrite `started_at` and refuse a deadline change) for that transaction only. The
   * CI database's owner is a superuser, which is what this setting requires.
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

  async function countsOf(attemptId: string) {
    const [attempts, answers, results, attempt] = await Promise.all([
      db.client.attempt.count({ where: { id: attemptId } }),
      db.client.attemptAnswer.count({ where: { attemptId } }),
      db.client.result.count({ where: { attemptId } }),
      db.client.attempt.findUniqueOrThrow({ where: { id: attemptId }, select: { enrollmentId: true, status: true } }),
    ]);
    const enrollment = await db.client.enrollment.findUniqueOrThrow({
      where: { id: attempt.enrollmentId },
      select: { status: true },
    });
    return { attempts, answers, results, status: attempt.status, enrollmentStatus: enrollment.status };
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  it('starts an attempt: the deadline is the database clock plus the duration, and the paper is delivered once', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);

    const started = await start(enrollmentId);
    expect(started.statusCode, started.body).toBe(201);
    const body = started.json() as AttemptStart;

    // Exactly the duration, to the millisecond, from the same transaction timestamp.
    expect(new Date(body.deadlineAt).getTime() - new Date(body.startedAt).getTime()).toBe(
      DURATION_MINUTES * 60_000,
    );
    expect(body.status).toBe('IN_PROGRESS');
    expect(body.remainingSeconds).toBeGreaterThan(0);
    expect(body.remainingSeconds).toBeLessThanOrEqual(DURATION_MINUTES * 60);

    // The paper, in the version's order, as an allowlist.
    expect(body.questions.map((question) => question.questionId)).toEqual(paper.questions.map((question) => question.id));
    expect(body.questions.map((question) => question.position)).toEqual([1, 2, 3]);
    for (const question of body.questions) {
      expect(Object.keys(question).sort()).toEqual(
        ['contentHtml', 'latex', 'marks', 'negativeMarks', 'options', 'position', 'questionId', 'questionType'].sort(),
      );
      for (const option of question.options) {
        expect(Object.keys(option).sort()).toEqual(['id', 'latex', 'optionHtml', 'position'].sort());
      }
      expect(question.marks).toBe(MARKS);
      expect(question.negativeMarks).toBe(NEGATIVE);
    }
    expectNoAnswerKey(body);
    expect(started.body).not.toContain('Seven has no divisors');

    // A second start is refused and delivers nothing, and the clock has not moved.
    const again = await start(enrollmentId);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'attempt_already_started' });
    expect(again.body).not.toContain('questions');
    expectNoAnswerKey(again.json());

    const row = await db.client.attempt.findUniqueOrThrow({
      where: { enrollmentId },
      select: { startedAt: true, deadlineAt: true },
    });
    expect(row.startedAt.toISOString()).toBe(body.startedAt);
    expect(row.deadlineAt.toISOString()).toBe(body.deadlineAt);
  });

  it('lets exactly one of two simultaneous starts create the attempt', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);

    const [first, second] = await Promise.all([start(enrollmentId), start(enrollmentId)]);
    const codes = [first.statusCode, second.statusCode].sort();

    expect(codes).toEqual([201, 409]);
    const refused = first.statusCode === 409 ? first : second;
    expect(refused.json()).toMatchObject({ code: 'attempt_already_started' });
    expect(await db.client.attempt.count({ where: { enrollmentId } })).toBe(1);
  });

  it('refuses a closed enrollment, another student’s enrollment, a suspended account and anonymous callers', async () => {
    const paper = await newPaper();
    const closed = await newEnrollment(paper, student);
    await db.client.enrollment.update({ where: { id: closed }, data: { status: 'COMPLETED' } });

    const onClosed = await start(closed);
    expect(onClosed.statusCode).toBe(409);
    expect(onClosed.json()).toMatchObject({ code: 'enrollment_not_open' });

    const theirs = await newEnrollment(paper, otherStudent);
    const onTheirs = await start(theirs);
    expect(onTheirs.statusCode).toBe(404);
    expect(onTheirs.json().message).toMatch(/Unknown enrollment/);

    const suspended = await makePerson('USER', [], null);
    const suspendedEnrollment = await newEnrollment(paper, suspended);
    await db.client.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });
    const onSuspended = await start(suspendedEnrollment, suspended);
    expect(onSuspended.statusCode).toBe(401);

    const anonymous = await call('POST', `/v1/enrollments/${theirs}/attempt`, null);
    expect(anonymous.statusCode).toBe(401);

    // No attempt was created for any of them.
    expect(await db.client.attempt.count({ where: { enrollmentId: { in: [closed, theirs, suspendedEnrollment] } } })).toBe(
      0,
    );
  });

  it('refuses a userId in a body, a query or the path, and an unknown field', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);

    const inBody = await call('POST', `/v1/enrollments/${enrollmentId}/attempt`, student.token, { userId: student.id });
    expect(inBody.statusCode).toBe(400);
    expect(inBody.json().message).toMatch(/userId is never accepted/);

    const inQuery = await call('GET', `/v1/attempts/${randomUUID()}?userId=${student.id}`, student.token);
    expect(inQuery.statusCode).toBe(400);
    expect(inQuery.json().message).toMatch(/userId is never accepted/);

    const unknown = await call('POST', `/v1/enrollments/${enrollmentId}/attempt`, student.token, { when: 'now' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toMatch(/when is not a field/);

    expect(await db.client.attempt.count({ where: { enrollmentId } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  it('reads the state without the paper or any answer data', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;

    const read = await state(attemptId);
    expect(read.statusCode, read.body).toBe(200);
    const body = read.json() as AttemptState;

    expect(Object.keys(body).sort()).toEqual(
      ['attemptId', 'deadlineAt', 'remainingSeconds', 'serverNow', 'startedAt', 'status', 'submitSource', 'submittedAt'].sort(),
    );
    expect(body.remainingSeconds).toBeGreaterThan(0);
    expect(body.remainingSeconds).toBeLessThanOrEqual(DURATION_MINUTES * 60);
    expect(Date.parse(body.serverNow)).toBeGreaterThan(Date.now() - 60_000);
    expectNoAnswerKey(body);
    expect(read.body).not.toContain('questions');

    const theirs = await state(attemptId, otherStudent);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().message).toMatch(/Unknown attempt/);
  });

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  it('scores one right, one wrong and one unattempted answer exactly, and completes the enrollment', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;

    const [first, second] = paper.questions;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const submitted = await submit(attemptId, [
      { questionId: first?.id ?? '', chosenOptionId: first?.correctOptionId ?? '' },
      { questionId: second?.id ?? '', chosenOptionId: second?.wrongOptionId ?? '' },
    ]);

    expect(submitted.statusCode, submitted.body).toBe(200);
    const body = submitted.json() as AttemptResult;
    // 2 - 0.5 = 1.50; one of three attempted; accuracy 1 / 2.
    expect(body.score).toBe('1.50');
    expect(body.correctCount).toBe(1);
    expect(body.wrongCount).toBe(1);
    expect(body.unattemptedCount).toBe(1);
    expect(body.attemptedCount).toBe(2);
    expect(body.totalQuestions).toBe(3);
    expect(body.totalMarks).toBe('6.00');
    expect(body.accuracy).toBe('0.5000');
    expect(body.status).toBe('SUBMITTED');
    expect(body.submitSource).toBe('STUDENT');

    const counts = await countsOf(attemptId);
    expect(counts).toEqual({ attempts: 1, answers: 2, results: 1, status: 'SUBMITTED', enrollmentStatus: 'COMPLETED' });

    // The result is the one response that carries the review, the key and the explanation.
    expect(body.review).toHaveLength(3);
    const right = body.review.find((question) => question.questionId === first?.id);
    expect(right?.chosenOptionId).toBe(first?.correctOptionId);
    expect(right?.correctOptionId).toBe(first?.correctOptionId);
    expect(right?.explanationHtml).toContain('Seven');
    expect(right?.options.find((option) => option.id === right?.correctOptionId)).toMatchObject({ isCorrect: true });
  });

  it('returns the same result on a retry and writes nothing new', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;
    const first = paper.questions[0];
    const answers = [{ questionId: first?.id ?? '', chosenOptionId: first?.correctOptionId ?? '' }];

    const once = await submit(attemptId, answers);
    expect(once.statusCode, once.body).toBe(200);

    const twice = await submit(attemptId, answers);
    expect(twice.statusCode, twice.body).toBe(200);
    expect(twice.json()).toEqual(once.json());

    const counts = await countsOf(attemptId);
    expect(counts.answers).toBe(1);
    expect(counts.results).toBe(1);
  });

  it('gives exactly one result when two submits arrive at once', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;
    const answers = paper.questions.map((question) => ({
      questionId: question.id,
      chosenOptionId: question.correctOptionId,
    }));

    const [first, second] = await Promise.all([submit(attemptId, answers), submit(attemptId, answers)]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect((first.json() as AttemptResult).score).toBe('6.00');
    expect((second.json() as AttemptResult).score).toBe('6.00');

    const counts = await countsOf(attemptId);
    expect(counts.answers).toBe(3);
    expect(counts.results).toBe(1);
  });

  it('refuses invalid answers and writes nothing', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;
    const first = paper.questions[0];
    const foreign = await newQuestion();

    const duplicate = await submit(attemptId, [
      { questionId: first?.id ?? '', chosenOptionId: first?.correctOptionId ?? '' },
      { questionId: first?.id ?? '', chosenOptionId: first?.wrongOptionId ?? '' },
    ]);
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ code: 'duplicate_answer' });

    const unknownQuestion = await submit(attemptId, [
      { questionId: foreign.id, chosenOptionId: foreign.correctOptionId },
    ]);
    expect(unknownQuestion.statusCode).toBe(400);
    expect(unknownQuestion.json()).toMatchObject({ code: 'unknown_question' });

    const unknownOption = await submit(attemptId, [
      { questionId: first?.id ?? '', chosenOptionId: foreign.correctOptionId },
    ]);
    expect(unknownOption.statusCode).toBe(400);
    expect(unknownOption.json()).toMatchObject({ code: 'unknown_option' });

    const unknownField = await call('POST', `/v1/attempts/${attemptId}/submit`, student.token, {
      answers: [],
      when: 'now',
    });
    expect(unknownField.statusCode).toBe(400);

    const oversized = await submit(
      attemptId,
      Array.from({ length: 101 }, (_unused, index) => ({
        questionId: paper.questions[index % 3]?.id ?? '',
        chosenOptionId: paper.questions[index % 3]?.correctOptionId ?? '',
      })),
    );
    expect(oversized.statusCode).toBe(400);

    const counts = await countsOf(attemptId);
    expect(counts).toEqual({ attempts: 1, answers: 0, results: 0, status: 'IN_PROGRESS', enrollmentStatus: 'OPEN' });
    expect(unknownOption.body).not.toContain('Seven has no divisors');
  });

  // -------------------------------------------------------------------------
  // Late submit and lazy expiry
  // -------------------------------------------------------------------------

  it('refuses a submit past the deadline, ends the attempt with an empty result and discards the answers', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;
    const first = paper.questions[0];

    await backdate(attemptId, 10);

    const late = await submit(attemptId, [{ questionId: first?.id ?? '', chosenOptionId: first?.correctOptionId ?? '' }]);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'attempt_expired' });

    const counts = await countsOf(attemptId);
    expect(counts).toEqual({ attempts: 1, answers: 0, results: 1, status: 'AUTO_SUBMITTED', enrollmentStatus: 'EXPIRED' });

    const row = await db.client.result.findUniqueOrThrow({ where: { attemptId } });
    expect(row.score.toString()).toBe('0');
    expect(row.attemptedCount).toBe(0);
    expect(row.unattemptedCount).toBe(3);
    expect(row.accuracy.toString()).toBe('0');
  });

  it('accepts a submit inside the grace window', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;
    const first = paper.questions[0];

    // A generous pin, so the check is the window and not how fast the test machine is.
    await pinGrace(30);
    await backdate(attemptId, 0);

    try {
      const accepted = await submit(attemptId, [
        { questionId: first?.id ?? '', chosenOptionId: first?.correctOptionId ?? '' },
      ]);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect((accepted.json() as AttemptResult).score).toBe('2.00');
    } finally {
      await pinGrace(5);
    }
  });

  it('finalises an expired attempt exactly once through parallel state reads', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;

    await backdate(attemptId, 10);

    const [first, second] = await Promise.all([state(attemptId), state(attemptId)]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect((first.json() as AttemptState).status).toBe('AUTO_SUBMITTED');

    const counts = await countsOf(attemptId);
    expect(counts.results).toBe(1);
    expect(counts.status).toBe('AUTO_SUBMITTED');
    expect(counts.enrollmentStatus).toBe('EXPIRED');

    const row = await db.client.attempt.findUniqueOrThrow({ where: { id: attemptId }, select: { submitSource: true } });
    expect(row.submitSource).toBe('LAZY');
  });

  it('gives exactly one result when a submit races a lazy read', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;
    const first = paper.questions[0];

    await backdate(attemptId, 10);

    const [submitted, read] = await Promise.all([
      submit(attemptId, [{ questionId: first?.id ?? '', chosenOptionId: first?.correctOptionId ?? '' }]),
      result(attemptId),
    ]);

    expect([200, 409]).toContain(submitted.statusCode);
    expect(read.statusCode, read.body).toBe(200);
    expect((read.json() as AttemptResult).score).toBe('0.00');

    const counts = await countsOf(attemptId);
    expect(counts.results).toBe(1);
    expect(counts.answers).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Result
  // -------------------------------------------------------------------------

  it('refuses the result while the attempt runs, and another student’s result is not found', async () => {
    const paper = await newPaper();
    const enrollmentId = await newEnrollment(paper, student);
    const started = await start(enrollmentId);
    const attemptId = (started.json() as AttemptStart).attemptId;

    const running = await result(attemptId);
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ code: 'attempt_in_progress' });
    expectNoAnswerKey(running.json());

    const theirs = await result(attemptId, otherStudent);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json().message).toMatch(/Unknown attempt/);

    const unknown = await result(randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().message).toMatch(/Unknown attempt/);

    const counts = await countsOf(attemptId);
    expect(counts.results).toBe(0);
  });
});
