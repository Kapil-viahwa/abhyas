import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';

import { createMigratedTestDatabase, publishTestVersion, type TestDatabase } from './support/database';

/**
 * Phase 7, A5b: a published paper pins the question version it froze.
 *
 * Proven here, over real HTTP and a real database: publish writes the pin for every placement and
 * refuses a paper whose current version is not scorable; the start response, the scoring and the
 * review all read the pinned version, so editing the question in the bank after publishing changes
 * neither a running attempt (its submit is accepted and scored on the original key) nor a finished
 * one's review; a paper published after the edit pins the new version; a draft keeps its rows
 * unpinned; and the pin is frozen on a published paper.
 *
 * The migration's backfill cannot be seen here — every test schema is migrated from empty, so no
 * pre-A5b row can exist — so its rule is asserted where it still can be: a question version with
 * placements is refused a `published_at` while any placement is unpinned.
 */

const PASSWORD = 'correct-horse-9battery';
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

interface SeedQuestion {
  readonly id: string;
  readonly optionIds: readonly string[];
  readonly correctOptionId: string;
}

interface SeedEditedQuestion {
  readonly versionId: string;
  readonly optionIds: readonly string[];
  readonly correctOptionId: string;
}

interface SeedPaper {
  readonly testId: string;
  readonly versionId: string;
}

interface AttemptStart {
  readonly attemptId: string;
  readonly questions: Array<{
    readonly questionId: string;
    readonly contentHtml: string;
    readonly options: Array<{ readonly id: string; readonly optionHtml: string }>;
  }>;
}

interface AttemptSubmit {
  readonly status: string;
  readonly score: string;
  readonly correctCount: number;
  readonly wrongCount: number;
  readonly attemptedCount: number;
}

interface AttemptResult {
  readonly score: string;
  readonly review: Array<{
    readonly questionId: string;
    readonly contentHtml: string;
    readonly explanationHtml: string | null;
    readonly correctOptionId: string | null;
    readonly options: Array<{ readonly id: string; readonly isCorrect: boolean }>;
  }>;
}

const KEY_NAMES = new Set(['iscorrect', 'is_correct', 'correct', 'numericalanswer', 'explanation', 'solution']);

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
  expect([...keyNames(body)].filter((name) => KEY_NAMES.has(name))).toEqual([]);
}

describe('a published paper pins the question version it froze', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;

  let admin!: Person;
  let editor!: Person;
  let student!: Person;
  let otherStudent!: Person;
  let exam = '';
  let subject = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('attempts_pinning');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.S3_ENDPOINT = 'memory:';
    process.env.S3_BUCKET = 'abhyas-media';
    process.env.S3_ACCESS_KEY_ID = 'abhyas-dev';
    process.env.S3_SECRET_ACCESS_KEY = 'abhyas-dev-secret';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitUntilHealthy(app);

    admin = await makePerson('ADMIN', [], null);
    editor = await makePerson('EDITOR', ['content.write'], admin.id);
    student = await makePerson('USER', [], null);
    otherStudent = await makePerson('USER', [], null);

    const category = await db.client.examCategory.create({
      data: { name: 'Pinning Category', slug: `pin-cat-${randomUUID().slice(0, 8)}`, createdBy: admin.id },
      select: { id: true },
    });

    exam = (
      await db.client.exam.create({
        data: {
          categoryId: category.id,
          name: 'Pinning Exam',
          slug: `pin-exam-${randomUUID().slice(0, 8)}`,
          createdBy: editor.id,
        },
        select: { id: true },
      })
    ).id;

    subject = (
      await db.client.subject.create({
        data: { examId: exam, name: 'Reasoning', slug: `pin-sub-${randomUUID().slice(0, 8)}`, createdBy: editor.id },
        select: { id: true },
      })
    ).id;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
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
    method: 'GET' | 'POST' | 'PATCH',
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
        email: `p7-pin-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Pinning Person',
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

  /** A published single-correct question, with its option ids in position order. */
  async function newQuestion(input: {
    readonly contentHtml: string;
    readonly explanationHtml: string;
    readonly options: readonly [string, string, string];
    readonly correctPosition: 1 | 2 | 3;
  }): Promise<SeedQuestion> {
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
        contentHtml: `<p>${input.contentHtml}</p>`,
        explanationHtml: `<p>${input.explanationHtml}</p>`,
        marks: MARKS,
        negativeMarks: NEGATIVE,
        createdBy: editor.id,
        options: {
          create: input.options.map((text, index) => ({
            position: index + 1,
            optionHtml: `<p>${text}</p>`,
            isCorrect: index + 1 === input.correctPosition,
          })),
        },
      },
      select: { id: true },
    });

    await db.client.questionVersion.update({ where: { id: version.id }, data: { publishedAt: new Date() } });

    const options = await db.client.questionOption.findMany({
      where: { versionId: version.id },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    return {
      id: question.id,
      optionIds: options.map((option) => option.id),
      correctOptionId: options[input.correctPosition - 1]?.id ?? '',
    };
  }

  /** A paper awaiting an Administrator's publish: version 1, its question list already placed. */
  async function newPaper(questionIds: readonly string[]): Promise<SeedPaper> {
    const test = await db.client.test.create({
      data: {
        examId: exam,
        createdBy: editor.id,
        title: `Pinning paper ${randomUUID().slice(0, 8)}`,
        status: 'SUBMITTED',
        submittedAt: new Date(),
      },
      select: { id: true },
    });

    const version = await db.client.testVersion.create({
      data: {
        testId: test.id,
        version: 1,
        durationMinutes: 60,
        marksPerQuestion: MARKS,
        negativeMarksPerQuestion: NEGATIVE,
        createdBy: editor.id,
      },
      select: { id: true },
    });

    await db.client.testQuestion.createMany({
      data: questionIds.map((questionId, index) => ({
        testVersionId: version.id,
        questionId,
        position: index + 1,
      })),
    });

    return { testId: test.id, versionId: version.id };
  }

  async function publishPaper(testId: string) {
    return call('POST', `/v1/admin/tests/${testId}/publish`, admin.token);
  }

  /** The placements of a version, with the pin each one carries. */
  async function pinsFor(versionId: string) {
    return db.client.testQuestion.findMany({
      where: { testVersionId: versionId },
      orderBy: { position: 'asc' },
      select: { id: true, questionId: true, questionVersionId: true },
    });
  }

  async function versionIdOf(questionId: string, version: number): Promise<string> {
    const row = await db.client.questionVersion.findUniqueOrThrow({
      where: { questionId_version: { questionId, version } },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Edits a question in the bank the way an editor does: `PATCH /v1/questions/:id` saves a new
   * version and moves the question's pointer, then `POST /v1/questions/:id/publish` freezes it.
   */
  async function editQuestion(
    questionId: string,
    input: {
      readonly contentHtml: string;
      readonly explanationHtml: string;
      readonly options: readonly [string, string, string];
      readonly correctPosition: 1 | 2 | 3;
    },
  ): Promise<SeedEditedQuestion> {
    const saved = await call('PATCH', `/v1/questions/${questionId}`, editor.token, {
      examId: exam,
      subjectId: subject,
      questionType: 'MCQ',
      language: 'EN',
      difficulty: 'MEDIUM',
      contentHtml: `<p>${input.contentHtml}</p>`,
      explanationHtml: `<p>${input.explanationHtml}</p>`,
      marks: MARKS,
      negativeMarks: NEGATIVE,
      options: input.options.map((text, index) => ({
        optionHtml: `<p>${text}</p>`,
        isCorrect: index + 1 === input.correctPosition,
      })),
    });
    expect(saved.statusCode).toBe(200);

    const published = await call('POST', `/v1/questions/${questionId}/publish`, editor.token);
    expect(published.statusCode).toBe(200);

    const question = await db.client.question.findUniqueOrThrow({
      where: { id: questionId },
      select: { currentVersion: true },
    });
    const version = await db.client.questionVersion.findUniqueOrThrow({
      where: { questionId_version: { questionId, version: question.currentVersion } },
      select: { id: true },
    });
    const options = await db.client.questionOption.findMany({
      where: { versionId: version.id },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    return {
      versionId: version.id,
      optionIds: options.map((option) => option.id),
      correctOptionId: options[input.correctPosition - 1]?.id ?? '',
    };
  }

  /** An OPEN enrollment written the way the enrollment service writes one. */
  async function newEnrollment(paper: SeedPaper, owner: Person): Promise<string> {
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

  async function submit(
    attemptId: string,
    answers: readonly { questionId: string; chosenOptionId: string }[],
    owner: Person = student,
  ) {
    return call('POST', `/v1/attempts/${attemptId}/submit`, owner.token, { answers: [...answers] });
  }

  async function result(attemptId: string, owner: Person = student) {
    return call('GET', `/v1/attempts/${attemptId}/result`, owner.token);
  }

  // -------------------------------------------------------------------------
  // Publishing writes the pin
  // -------------------------------------------------------------------------

  it('pins every placement to the question’s current version when the paper is published', async () => {
    const first = await newQuestion({
      contentHtml: 'Pin one',
      explanationHtml: 'Pin one explanation',
      options: ['One A', 'One B', 'One C'],
      correctPosition: 1,
    });
    const second = await newQuestion({
      contentHtml: 'Pin two',
      explanationHtml: 'Pin two explanation',
      options: ['Two A', 'Two B', 'Two C'],
      correctPosition: 3,
    });

    const paper = await newPaper([first.id, second.id]);

    const before = await pinsFor(paper.versionId);
    expect(before.map((row) => row.questionVersionId)).toEqual([null, null]);

    const published = await publishPaper(paper.testId);
    expect(published.statusCode).toBe(200);

    const after = await pinsFor(paper.versionId);
    expect(after).toHaveLength(2);
    expect(after[0]?.questionVersionId).toBe(await versionIdOf(first.id, 1));
    expect(after[1]?.questionVersionId).toBe(await versionIdOf(second.id, 1));
  }, 60_000);

  it('refuses to publish a paper whose current question version is not scorable', async () => {
    const broken = await db.client.question.create({
      data: { examId: exam, subjectId: subject, createdBy: editor.id, status: 'PUBLISHED', currentVersion: 2 },
      select: { id: true },
    });
    // A numerical current version: valid in the bank, never scorable in a paper (decision 0077).
    await db.client.questionVersion.create({
      data: {
        questionId: broken.id,
        version: 2,
        questionType: 'NUMERICAL',
        language: 'EN',
        difficulty: 'MEDIUM',
        contentHtml: '<p>Type a number</p>',
        numericalAnswer: '7',
        marks: MARKS,
        negativeMarks: '0',
        createdBy: editor.id,
      },
    });

    const paper = await newPaper([broken.id]);

    const published = await publishPaper(paper.testId);
    expect(published.statusCode).toBe(400);
    expect((JSON.parse(published.body) as { code?: string }).code).toBe('question_not_single_correct');

    // Nothing changed: the version is still unpublished and the paper is still with the administrator.
    const version = await db.client.testVersion.findUniqueOrThrow({
      where: { id: paper.versionId },
      select: { publishedAt: true },
    });
    expect(version.publishedAt).toBeNull();

    const test = await db.client.test.findUniqueOrThrow({ where: { id: paper.testId }, select: { status: true } });
    expect(test.status).toBe('SUBMITTED');

    expect((await pinsFor(paper.versionId)).map((row) => row.questionVersionId)).toEqual([null]);
  }, 60_000);

  // -------------------------------------------------------------------------
  // After the edit, the paper keeps what it pinned
  // -------------------------------------------------------------------------

  it('delivers, scores and reviews the pinned content after the question is edited', async () => {
    const alpha = await newQuestion({
      contentHtml: 'Original alpha stem',
      explanationHtml: 'Original alpha explanation',
      options: ['Original alpha one', 'Original alpha two', 'Original alpha three'],
      correctPosition: 2,
    });
    const beta = await newQuestion({
      contentHtml: 'Original beta stem',
      explanationHtml: 'Original beta explanation',
      options: ['Original beta one', 'Original beta two', 'Original beta three'],
      correctPosition: 1,
    });

    const paper = await newPaper([alpha.id, beta.id]);
    expect((await publishPaper(paper.testId)).statusCode).toBe(200);

    const enrollment = await newEnrollment(paper, student);
    const started = await start(enrollment);
    expect(started.statusCode).toBe(201);

    const startBody = JSON.parse(started.body) as AttemptStart;
    expectNoAnswerKey(startBody);

    const alphaAsGiven = startBody.questions.find((question) => question.questionId === alpha.id);
    expect(alphaAsGiven?.contentHtml).toContain('Original alpha stem');
    expect(alphaAsGiven?.options.map((option) => option.id)).toEqual([...alpha.optionIds]);

    // The editor changes the stem, every option, the correct option and the explanation.
    const edited = await editQuestion(alpha.id, {
      contentHtml: 'Edited alpha stem',
      explanationHtml: 'Edited alpha explanation',
      options: ['Edited alpha one', 'Edited alpha two', 'Edited alpha three'],
      correctPosition: 1,
    });
    expect(edited.versionId).not.toBe(await versionIdOf(alpha.id, 1));

    // A new attempt on the same paper is given the frozen paper, not the edited bank.
    const secondEnrollment = await newEnrollment(paper, otherStudent);
    const secondStarted = await start(secondEnrollment, otherStudent);
    expect(secondStarted.statusCode).toBe(201);

    const secondBody = JSON.parse(secondStarted.body) as AttemptStart;
    const alphaOnSecond = secondBody.questions.find((question) => question.questionId === alpha.id);
    expect(alphaOnSecond?.contentHtml).toContain('Original alpha stem');
    expect(alphaOnSecond?.contentHtml).not.toContain('Edited alpha stem');
    expect(alphaOnSecond?.options.map((option) => option.id)).toEqual([...alpha.optionIds]);
    expect(alphaOnSecond?.options.map((option) => option.id)).not.toContain(edited.optionIds[0]);

    // The first attempt submits the answers it was given, and is scored on the original key.
    const submitted = await submit(startBody.attemptId, [
      { questionId: alpha.id, chosenOptionId: alpha.correctOptionId },
      { questionId: beta.id, chosenOptionId: beta.correctOptionId },
    ]);
    expect(submitted.statusCode).toBe(200);

    const submitBody = JSON.parse(submitted.body) as AttemptSubmit;
    expect(submitBody.score).toBe('4.00');
    expect(submitBody.correctCount).toBe(2);
    expect(submitBody.wrongCount).toBe(0);
    expectNoAnswerKey(submitBody);

    const reviewed = await result(startBody.attemptId);
    expect(reviewed.statusCode).toBe(200);

    const view = JSON.parse(reviewed.body) as AttemptResult;
    expect(view.score).toBe('4.00');
    const alphaReview = view.review.find((question) => question.questionId === alpha.id);
    expect(alphaReview?.contentHtml).toContain('Original alpha stem');
    expect(alphaReview?.explanationHtml).toContain('Original alpha explanation');
    expect(alphaReview?.contentHtml).not.toContain('Edited alpha stem');
    expect(alphaReview?.explanationHtml).not.toContain('Edited alpha explanation');
    expect(alphaReview?.correctOptionId).toBe(alpha.correctOptionId);
    expect(alphaReview?.options.map((option) => option.id)).toEqual([...alpha.optionIds]);
    expect(alphaReview?.options.filter((option) => option.isCorrect).map((option) => option.id)).toEqual([
      alpha.correctOptionId,
    ]);
  }, 120_000);

  it('accepts an in-flight submit after the edit and scores it on the paper it was given', async () => {
    const alpha = await newQuestion({
      contentHtml: 'Flight alpha stem',
      explanationHtml: 'Flight alpha explanation',
      options: ['Flight alpha one', 'Flight alpha two', 'Flight alpha three'],
      correctPosition: 2,
    });

    const paper = await newPaper([alpha.id]);
    expect((await publishPaper(paper.testId)).statusCode).toBe(200);

    const enrollment = await newEnrollment(paper, student);
    const started = await start(enrollment);
    expect(started.statusCode).toBe(201);
    const startBody = JSON.parse(started.body) as AttemptStart;

    await editQuestion(alpha.id, {
      contentHtml: 'Flight edited stem',
      explanationHtml: 'Flight edited explanation',
      options: ['Flight edited one', 'Flight edited two', 'Flight edited three'],
      correctPosition: 1,
    });

    // The option the student saw no longer exists in the question's current version; the pin is
    // what keeps this a scored submit instead of an `unknown_option` refusal.
    const seenWrongOption = alpha.optionIds[0] ?? '';
    const submitted = await submit(startBody.attemptId, [
      { questionId: alpha.id, chosenOptionId: seenWrongOption },
    ]);
    expect(submitted.statusCode).toBe(200);

    const submitBody = JSON.parse(submitted.body) as AttemptSubmit;
    expect(submitBody.score).toBe('-0.50');
    expect(submitBody.correctCount).toBe(0);
    expect(submitBody.wrongCount).toBe(1);

    const reviewed = await result(startBody.attemptId);
    expect(reviewed.statusCode).toBe(200);

    const view = JSON.parse(reviewed.body) as AttemptResult;
    const review = view.review[0];
    expect(review?.contentHtml).toContain('Flight alpha stem');
    expect(review?.explanationHtml).toContain('Flight alpha explanation');
    expect(review?.correctOptionId).toBe(alpha.correctOptionId);
    expect(review?.options.map((option) => option.id)).toEqual([...alpha.optionIds]);
  }, 120_000);

  it('pins a paper published after the edit to the new version, and leaves a draft unpinned', async () => {
    const alpha = await newQuestion({
      contentHtml: 'Before the edit',
      explanationHtml: 'Before the edit explanation',
      options: ['Before one', 'Before two', 'Before three'],
      correctPosition: 2,
    });

    const edited = await editQuestion(alpha.id, {
      contentHtml: 'After the edit',
      explanationHtml: 'After the edit explanation',
      options: ['After one', 'After two', 'After three'],
      correctPosition: 3,
    });

    const paper = await newPaper([alpha.id]);
    expect((await publishPaper(paper.testId)).statusCode).toBe(200);

    const pins = await pinsFor(paper.versionId);
    expect(pins[0]?.questionVersionId).toBe(edited.versionId);

    const enrollment = await newEnrollment(paper, otherStudent);
    const started = await start(enrollment, otherStudent);
    expect(started.statusCode).toBe(201);

    const body = JSON.parse(started.body) as AttemptStart;
    expect(body.questions[0]?.contentHtml).toContain('After the edit');
    expect(body.questions[0]?.options.map((option) => option.id)).toEqual([...edited.optionIds]);

    // A draft keeps its placements unpinned, so the builder still follows the current version.
    const draft = await db.client.test.create({
      data: { examId: exam, createdBy: editor.id, title: `Draft ${randomUUID().slice(0, 8)}`, status: 'DRAFT' },
      select: { id: true },
    });
    const draftVersion = await db.client.testVersion.create({
      data: {
        testId: draft.id,
        version: 1,
        durationMinutes: 30,
        marksPerQuestion: MARKS,
        negativeMarksPerQuestion: NEGATIVE,
        createdBy: editor.id,
      },
      select: { id: true },
    });
    await db.client.testQuestion.create({
      data: { testVersionId: draftVersion.id, questionId: alpha.id, position: 1 },
    });

    const draftPins = await pinsFor(draftVersion.id);
    expect(draftPins.map((row) => row.questionVersionId)).toEqual([null]);

    // And a version with an unpinned placement cannot be stamped published.
    await expect(
      db.client.$executeRawUnsafe(`UPDATE "test_versions" SET "published_at" = now() WHERE "id" = $1::uuid`, draftVersion.id),
    ).rejects.toThrow(/not pinned to a question version/);

    // A paper published earlier still reads its own pin, not the draft's.
    expect((await pinsFor(paper.versionId))[0]?.questionVersionId).toBe(edited.versionId);
  }, 120_000);

  // -------------------------------------------------------------------------
  // The pin is frozen
  // -------------------------------------------------------------------------

  it('refuses to change, remove or move a pin on a published paper, and a pin of another question', async () => {
    const alpha = await newQuestion({
      contentHtml: 'Frozen alpha',
      explanationHtml: 'Frozen alpha explanation',
      options: ['Frozen A', 'Frozen B', 'Frozen C'],
      correctPosition: 1,
    });
    const beta = await newQuestion({
      contentHtml: 'Frozen beta',
      explanationHtml: 'Frozen beta explanation',
      options: ['Frozen D', 'Frozen E', 'Frozen F'],
      correctPosition: 2,
    });

    const paper = await newPaper([alpha.id]);
    expect((await publishPaper(paper.testId)).statusCode).toBe(200);

    const placed = (await pinsFor(paper.versionId))[0];
    expect(placed?.questionVersionId).toBe(await versionIdOf(alpha.id, 1));
    if (placed === undefined || placed.questionVersionId === null) {
      throw new Error('the published paper has no pinned placement');
    }

    const otherVersion = await versionIdOf(beta.id, 1);

    await expect(
      db.client.$executeRawUnsafe(
        `UPDATE "test_questions" SET "question_version_id" = $2::uuid WHERE "id" = $1::uuid`,
        placed.id,
        otherVersion,
      ),
    ).rejects.toThrow(/a published paper cannot be changed/);

    await expect(db.client.testQuestion.delete({ where: { id: placed.id } })).rejects.toThrow(
      /a published paper cannot be changed/,
    );

    // Nor can a row leave a published paper for a draft one.
    const draft = await db.client.test.create({
      data: { examId: exam, createdBy: editor.id, title: `Move target ${randomUUID().slice(0, 8)}` },
      select: { id: true },
    });
    const draftVersion = await db.client.testVersion.create({
      data: {
        testId: draft.id,
        version: 1,
        durationMinutes: 30,
        marksPerQuestion: MARKS,
        negativeMarksPerQuestion: NEGATIVE,
        createdBy: editor.id,
      },
      select: { id: true },
    });

    await expect(
      db.client.$executeRawUnsafe(
        `UPDATE "test_questions" SET "test_version_id" = $2::uuid WHERE "id" = $1::uuid`,
        placed.id,
        draftVersion.id,
      ),
    ).rejects.toThrow(/a published paper cannot be changed/);

    // A pin has to name a version of the same question: refused even on a draft paper.
    const draftRow = await db.client.testQuestion.create({
      data: { testVersionId: draftVersion.id, questionId: alpha.id, position: 1 },
      select: { id: true },
    });

    await expect(
      db.client.$executeRawUnsafe(
        `UPDATE "test_questions" SET "question_version_id" = $2::uuid WHERE "id" = $1::uuid`,
        draftRow.id,
        otherVersion,
      ),
    ).rejects.toThrow(/belongs to question/);

    // The published paper's pin is untouched after every refusal.
    const after = await db.client.testQuestion.findUniqueOrThrow({
      where: { id: placed.id },
      select: { questionVersionId: true },
    });
    expect(after.questionVersionId).toBe(placed.questionVersionId);
  }, 120_000);

  it('keeps an archived paper pinned, and cannot be published unpinned by direct SQL', async () => {
    // A paper seeded as a draft and published through the shared helper: the shape every fixture
    // uses, proving publishTestVersion and the database agree on the order.
    const question = await newQuestion({
      contentHtml: 'Archive stem',
      explanationHtml: 'Archive explanation',
      options: ['Archive A', 'Archive B', 'Archive C'],
      correctPosition: 2,
    });

    const seeded = await newPaper([question.id]);
    await publishTestVersion(db.client, seeded.versionId);
    expect((await pinsFor(seeded.versionId))[0]?.questionVersionId).toBe(await versionIdOf(question.id, 1));

    const archived = await call('POST', `/v1/admin/tests/${seeded.testId}/archive`, admin.token);
    expect(archived.statusCode).toBe(200);

    const pins = await pinsFor(seeded.versionId);
    expect(pins[0]?.questionVersionId).toBe(await versionIdOf(question.id, 1));

    const version = await db.client.testVersion.findUniqueOrThrow({
      where: { id: seeded.versionId },
      select: { publishedAt: true },
    });
    expect(version.publishedAt).not.toBeNull();
  }, 60_000);
});
