import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Phase 7, A1: the attempt model is constrained by the database, not only by the API that will
 * use it in A3.
 *
 * Proven here: one attempt per enrollment under two simultaneous inserts; the deadline after
 * the start; the submitted pair present exactly when the attempt is not running; `started_at`
 * set by the database even when a caller sends one; the status one-way and once, under two
 * simultaneous updates; answers unique per question, tied to the attempt's version and to that
 * question's options, and frozen once the attempt has ended; a result only after the attempt
 * has ended, immutable, one per attempt under two simultaneous inserts; the count and accuracy
 * CHECKs; and an attempt's student and version being its enrollment's.
 *
 * Every raw statement casts a parameter that lands in a uuid column (`$1::uuid`): Prisma's raw
 * protocol sends parameters untyped, and Postgres will not infer a uuid from text.
 */

interface Fixture {
  readonly editorId: string;
  readonly studentId: string;
  readonly otherStudentId: string;
  readonly examId: string;
  readonly otherExamId: string;
}

interface Paper {
  readonly testId: string;
  readonly versionId: string;
  /** Two questions placed in the version, each with two options. */
  readonly questionIds: readonly string[];
  readonly optionIds: readonly (readonly string[])[];
  /** A published question that is NOT in this paper. */
  readonly outsideQuestionId: string;
  readonly outsideOptionId: string;
}

describe('phase 7 attempt model', () => {
  let db!: TestDatabase;
  let fixture!: Fixture;
  const extraClients: PrismaClient[] = [];

  beforeAll(async () => {
    db = await createMigratedTestDatabase('attempts_model');
    const marker = randomUUID().slice(0, 8);

    const roleId = async (code: string): Promise<string> =>
      (await db.client.role.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;

    const person = async (roleCode: string, label: string): Promise<string> => {
      const user = await db.client.user.create({
        data: {
          email: `attempts-model-${label}-${marker}-${randomUUID().slice(0, 8)}@example.com`,
          passwordHash: 'not-a-real-hash',
          fullName: `Attempt Model ${label}`,
          roleId: await roleId(roleCode),
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
      return user.id;
    };

    const adminId = await person('ADMIN', 'admin');
    const editorId = await person('EDITOR', 'editor');
    const studentId = await person('USER', 'student');
    const otherStudentId = await person('USER', 'student-two');

    const category = await db.client.examCategory.create({
      data: { name: 'Attempt Category', slug: `attempt-cat-${marker}`, createdBy: adminId },
      select: { id: true },
    });

    const examOf = async (label: string): Promise<string> =>
      (
        await db.client.exam.create({
          data: {
            categoryId: category.id,
            name: `Attempt ${label}`,
            slug: `attempt-${label}-${marker}-${randomUUID().slice(0, 8)}`,
            createdBy: adminId,
          },
          select: { id: true },
        })
      ).id;

    fixture = {
      editorId,
      studentId,
      otherStudentId,
      examId: await examOf('exam'),
      otherExamId: await examOf('other-exam'),
    };
  }, 120_000);

  afterAll(async () => {
    for (const client of extraClients) {
      await client.$disconnect();
    }
    await db?.dispose();
  }, 60_000);

  /** A second connection, so a concurrency test really races two sessions. */
  function secondClient(): PrismaClient {
    const client = new PrismaClient({ datasources: { db: { url: db.url } } });
    extraClients.push(client);
    return client;
  }

  /** A 64-hex fingerprint, the shape `coin_transactions_fingerprint_format` requires. */
  function fingerprint(): string {
    return randomUUID().replace(/-/g, '').repeat(2);
  }

  /**
   * A published question with two options. Written in the order the freeze allows: options
   * first, then the version's `published_at` — a published version refuses an option insert
   * (`question_options_frozen`).
   */
  async function newQuestion(examId: string, correctAt = 1): Promise<{ questionId: string; optionIds: string[] }> {
    const subject = await db.client.subject.create({
      data: {
        examId,
        name: `Attempt Subject ${randomUUID().slice(0, 6)}`,
        slug: `attempt-sub-${randomUUID().slice(0, 10)}`,
        createdBy: fixture.editorId,
      },
      select: { id: true },
    });

    const question = await db.client.question.create({
      data: { examId, subjectId: subject.id, createdBy: fixture.editorId, status: 'PUBLISHED', currentVersion: 1 },
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
        marks: 2,
        negativeMarks: '0.5',
        createdBy: fixture.editorId,
        publishedAt: null,
        options: {
          create: [
            { position: 1, optionHtml: '<p>4</p>', isCorrect: correctAt === 1 },
            { position: 2, optionHtml: '<p>7</p>', isCorrect: correctAt === 2 },
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

    return { questionId: question.id, optionIds: options.map((option) => option.id) };
  }

  /**
   * A paper with two placed questions, then published. The placements go in while the version
   * is still a draft: `test_questions_frozen` refuses a placement into a published version.
   */
  async function newPaper(): Promise<Paper> {
    const test = await db.client.test.create({
      data: { examId: fixture.examId, createdBy: fixture.editorId, title: `Paper ${randomUUID().slice(0, 8)}` },
      select: { id: true },
    });

    const version = await db.client.testVersion.create({
      data: {
        testId: test.id,
        version: 1,
        durationMinutes: 60,
        marksPerQuestion: 2,
        negativeMarksPerQuestion: '0.5',
        createdBy: fixture.editorId,
      },
      select: { id: true },
    });

    const first = await newQuestion(fixture.examId);
    const second = await newQuestion(fixture.examId, 2);
    const outside = await newQuestion(fixture.otherExamId);

    await db.client.testQuestion.createMany({
      data: [
        { testVersionId: version.id, questionId: first.questionId, position: 1 },
        { testVersionId: version.id, questionId: second.questionId, position: 2 },
      ],
    });

    // First publication is the one update `test_versions_frozen` allows.
    await db.client.$executeRawUnsafe(
      `UPDATE "test_versions" SET "published_at" = now() WHERE "id" = $1::uuid`,
      version.id,
    );

    return {
      testId: test.id,
      versionId: version.id,
      questionIds: [first.questionId, second.questionId],
      optionIds: [first.optionIds, second.optionIds],
      outsideQuestionId: outside.questionId,
      outsideOptionId: outside.optionIds[0] ?? '',
    };
  }

  /**
   * An enrollment, written the way phase 6's service writes it: a funded wallet, an ENROLLMENT
   * charge through the ledger's own trigger, then the row that points at it. The balance is
   * topped up through the ledger, never posted directly.
   */
  async function newEnrollment(paper: Paper, userId = fixture.studentId): Promise<string> {
    const wallet = await db.client.coinWallet.upsert({
      where: { userId },
      create: { userId, balance: 0 },
      update: {},
      select: { balance: true },
    });

    const topUp = Math.max(0, 1000 - wallet.balance);
    if (topUp > 0) {
      await db.client.coinTransaction.create({
        data: {
          userId,
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
        userId,
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
        userId,
        coinTransactionId: charge.id,
        idempotencyKey: `enroll:${randomUUID()}`,
      },
      select: { id: true },
    });

    return enrollment.id;
  }

  interface AttemptInput {
    readonly userId?: string;
    readonly testVersionId?: string;
    readonly deadlineAt?: Date;
    readonly startedAt?: Date;
    readonly status?: string;
    readonly submittedAt?: Date | null;
    readonly submitSource?: string | null;
  }

  /** A running attempt with its deadline an hour out, unless the test overrides it. */
  async function newAttempt(
    client: PrismaClient,
    enrollmentId: string,
    paper: Paper,
    input: AttemptInput = {},
  ): Promise<string> {
    const attempt = await client.attempt.create({
      data: {
        enrollmentId,
        userId: input.userId ?? fixture.studentId,
        testVersionId: input.testVersionId ?? paper.versionId,
        deadlineAt: input.deadlineAt ?? new Date(Date.now() + 60 * 60_000),
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.status === undefined
          ? {}
          : {
              status: input.status,
              submittedAt: input.submittedAt ?? null,
              submitSource: input.submitSource ?? null,
            }),
      },
      select: { id: true },
    });

    return attempt.id;
  }

  /** Ends a running attempt through the same one-way transition the API will use in A3. */
  async function end(attemptId: string, status = 'SUBMITTED', source = 'STUDENT'): Promise<void> {
    await db.client.attempt.update({
      where: { id: attemptId },
      data: { status, submittedAt: new Date(), submitSource: source },
    });
  }

  /** A well-formed result for an ended two-question paper: one right, one unattempted. */
  function newResult(attemptId: string) {
    return {
      attemptId,
      score: 2,
      correctCount: 1,
      wrongCount: 0,
      unattemptedCount: 1,
      attemptedCount: 1,
      totalQuestions: 2,
      totalMarks: 4,
      accuracy: 1,
    };
  }

  describe('one attempt per enrollment', () => {
    it('lets one of two simultaneous inserts win and refuses the other', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const other = secondClient();
      const deadlineAt = new Date(Date.now() + 60 * 60_000);

      // Both rows are otherwise valid, so the unique index on `enrollment_id` is the only rule
      // that can refuse the second one.
      const outcomes = await Promise.allSettled([
        newAttempt(db.client, enrollmentId, paper, { deadlineAt }),
        newAttempt(other, enrollmentId, paper, { deadlineAt }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toMatch(/Unique constraint failed on the fields: \(`enrollment_id`\)/);
      expect(await db.client.attempt.count({ where: { enrollmentId } })).toBe(1);
    });
  });

  describe('the start and the deadline', () => {
    it('refuses a deadline that is not after the start', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);

      // `started_at` is the database's now() either way, so a past deadline can only meet the
      // deadline CHECK.
      await expect(
        newAttempt(db.client, enrollmentId, paper, { deadlineAt: new Date(Date.now() - 60_000) }),
      ).rejects.toThrow(/attempts_deadline_after_start/);

      expect(await db.client.attempt.count({ where: { enrollmentId } })).toBe(0);
    });

    it('sets started_at from the database, even when the caller sends one', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);

      const attemptId = await newAttempt(db.client, enrollmentId, paper, {
        startedAt: new Date('2001-01-01T00:00:00Z'),
      });

      const row = await db.client.attempt.findUniqueOrThrow({
        where: { id: attemptId },
        select: { startedAt: true },
      });

      // The trigger overwrites whatever was sent: a client cannot back-date an attempt.
      expect(row.startedAt.getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
      expect(row.startedAt.getUTCFullYear()).toBeGreaterThan(2020);
    });

    it('requires submitted_at and submit_source exactly when the attempt is not running', async () => {
      const paper = await newPaper();
      const firstEnrollment = await newEnrollment(paper);

      await expect(newAttempt(db.client, firstEnrollment, paper, { status: 'SUBMITTED' })).rejects.toThrow(
        /attempts_submitted_fields/,
      );
      expect(await db.client.attempt.count({ where: { enrollmentId: firstEnrollment } })).toBe(0);

      // The same pair, on an enrollment of its own, is accepted — so the refusal above was the
      // missing pair and nothing else.
      const secondEnrollment = await newEnrollment(paper, fixture.otherStudentId);
      const accepted = await newAttempt(db.client, secondEnrollment, paper, {
        userId: fixture.otherStudentId,
        status: 'AUTO_SUBMITTED',
        submittedAt: new Date(),
        submitSource: 'SWEEPER',
      });

      const row = await db.client.attempt.findUniqueOrThrow({ where: { id: accepted } });
      expect(row.status).toBe('AUTO_SUBMITTED');
      expect(row.submitSource).toBe('SWEEPER');
    });

    it('refuses an unknown submit source', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);

      await expect(
        newAttempt(db.client, enrollmentId, paper, {
          status: 'AUTO_SUBMITTED',
          submittedAt: new Date(),
          submitSource: 'BECAUSE_I_SAID_SO',
        }),
      ).rejects.toThrow(/attempts_submit_source_valid/);
    });
  });

  describe('the status is one-way and once', () => {
    it('moves IN_PROGRESS to SUBMITTED once and refuses everything after it', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      await end(attemptId);

      await expect(
        db.client.attempt.update({
          where: { id: attemptId },
          data: { status: 'AUTO_SUBMITTED', submittedAt: new Date(), submitSource: 'SWEEPER' },
        }),
      ).rejects.toThrow(/an ended attempt cannot be changed/);

      await expect(
        db.client.$executeRawUnsafe(
          `UPDATE "attempts" SET "status" = 'IN_PROGRESS', "submitted_at" = NULL, "submit_source" = NULL WHERE "id" = $1::uuid`,
          attemptId,
        ),
      ).rejects.toThrow(/an ended attempt cannot be changed/);

      const row = await db.client.attempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(row.status).toBe('SUBMITTED');
      expect(row.submittedAt).not.toBeNull();
    });

    it('lets exactly one of two simultaneous endings win', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);
      const other = secondClient();

      const finish = (client: PrismaClient, status: string, source: string): Promise<{ count: number }> =>
        client.attempt.updateMany({
          where: { id: attemptId, status: 'IN_PROGRESS' },
          data: { status, submittedAt: new Date(), submitSource: source },
        });

      const results = await Promise.all([
        finish(db.client, 'SUBMITTED', 'STUDENT'),
        finish(other, 'AUTO_SUBMITTED', 'SWEEPER'),
      ]);

      expect(results.map((result) => result.count).sort()).toEqual([0, 1]);

      const row = await db.client.attempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(['SUBMITTED', 'AUTO_SUBMITTED']).toContain(row.status);
      expect(row.submittedAt).not.toBeNull();
    });

    it('refuses to change the enrollment, student, version, start or deadline', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      await expect(
        db.client.$executeRawUnsafe(
          `UPDATE "attempts" SET "user_id" = $1::uuid WHERE "id" = $2::uuid`,
          fixture.otherStudentId,
          attemptId,
        ),
      ).rejects.toThrow(/are fixed at start/);

      await expect(
        db.client.$executeRawUnsafe(
          `UPDATE "attempts" SET "deadline_at" = now() + interval '5 hours' WHERE "id" = $1::uuid`,
          attemptId,
        ),
      ).rejects.toThrow(/are fixed at start/);
    });
  });

  describe("the attempt's student and version are its enrollment's", () => {
    it("refuses a student who is not the enrollment's", async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);

      await expect(
        newAttempt(db.client, enrollmentId, paper, { userId: fixture.otherStudentId }),
      ).rejects.toThrow(/belongs to the enrollment's student/);

      expect(await db.client.attempt.count({ where: { enrollmentId } })).toBe(0);
    });

    it("refuses a version that is not the enrollment's", async () => {
      const paper = await newPaper();
      const otherPaper = await newPaper();
      const enrollmentId = await newEnrollment(paper);

      await expect(
        newAttempt(db.client, enrollmentId, paper, { testVersionId: otherPaper.versionId }),
      ).rejects.toThrow(/is of the enrollment's version/);

      expect(await db.client.attempt.count({ where: { enrollmentId } })).toBe(0);
    });
  });

  describe('attempt answers', () => {
    it('takes one row per question and refuses a second answer to it', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      const questionId = paper.questionIds[0] ?? '';
      const optionId = paper.optionIds[0]?.[0] ?? '';

      await db.client.attemptAnswer.create({ data: { attemptId, questionId, chosenOptionId: optionId } });

      await expect(
        db.client.attemptAnswer.create({ data: { attemptId, questionId, chosenOptionId: optionId } }),
      ).rejects.toThrow(/Unique constraint failed on the fields: \(`attempt_id`,\s*`question_id`\)/);

      expect(await db.client.attemptAnswer.count({ where: { attemptId } })).toBe(1);
    });

    it("refuses a question that is not in the attempt's paper", async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      await expect(
        db.client.attemptAnswer.create({
          data: { attemptId, questionId: paper.outsideQuestionId, chosenOptionId: paper.outsideOptionId },
        }),
      ).rejects.toThrow(/is not in this attempt's paper/);

      expect(await db.client.attemptAnswer.count({ where: { attemptId } })).toBe(0);
    });

    it('refuses an option that belongs to another question', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      await expect(
        db.client.attemptAnswer.create({
          data: {
            attemptId,
            questionId: paper.questionIds[0] ?? '',
            chosenOptionId: paper.optionIds[1]?.[0] ?? '',
          },
        }),
      ).rejects.toThrow(/is not an option of question/);

      expect(await db.client.attemptAnswer.count({ where: { attemptId } })).toBe(0);
    });

    it('refuses to write or change an answer once the attempt has ended', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      const questionId = paper.questionIds[0] ?? '';
      const optionId = paper.optionIds[0]?.[0] ?? '';
      await db.client.attemptAnswer.create({ data: { attemptId, questionId, chosenOptionId: optionId } });

      await end(attemptId);

      await expect(
        db.client.attemptAnswer.create({
          data: {
            attemptId,
            questionId: paper.questionIds[1] ?? '',
            chosenOptionId: paper.optionIds[1]?.[0] ?? '',
          },
        }),
      ).rejects.toThrow(/cannot be written or changed once the attempt has ended/);

      await expect(
        db.client.$executeRawUnsafe(
          `UPDATE "attempt_answers" SET "chosen_option_id" = $1::uuid WHERE "attempt_id" = $2::uuid`,
          paper.optionIds[0]?.[1] ?? '',
          attemptId,
        ),
      ).rejects.toThrow(/cannot be written or changed once the attempt has ended/);

      const row = await db.client.attemptAnswer.findFirstOrThrow({ where: { attemptId } });
      expect(row.chosenOptionId).toBe(optionId);
    });
  });

  describe('results', () => {
    it('refuses a result for an attempt that is still running', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);

      await expect(db.client.result.create({ data: newResult(attemptId) })).rejects.toThrow(
        /an attempt that is still running has no result/,
      );

      expect(await db.client.result.count({ where: { attemptId } })).toBe(0);
    });

    it('is written once an attempt has ended, and cannot be updated or deleted', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);
      await end(attemptId);

      await db.client.result.create({ data: newResult(attemptId) });

      await expect(
        db.client.$executeRawUnsafe(`UPDATE "results" SET "score" = 99 WHERE "attempt_id" = $1::uuid`, attemptId),
      ).rejects.toThrow(/a written result cannot be updated or deleted/);

      await expect(
        db.client.$executeRawUnsafe(`DELETE FROM "results" WHERE "attempt_id" = $1::uuid`, attemptId),
      ).rejects.toThrow(/a written result cannot be updated or deleted/);

      const row = await db.client.result.findUniqueOrThrow({ where: { attemptId } });
      expect(row.score.toString()).toBe('2');
    });

    it('lets exactly one of two simultaneous inserts win', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);
      await end(attemptId);

      const other = secondClient();
      const outcomes = await Promise.allSettled([
        db.client.result.create({ data: newResult(attemptId) }),
        other.result.create({ data: newResult(attemptId) }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(await db.client.result.count({ where: { attemptId } })).toBe(1);
    });

    it('enforces the count and accuracy CHECKs', async () => {
      const paper = await newPaper();
      const enrollmentId = await newEnrollment(paper);
      const attemptId = await newAttempt(db.client, enrollmentId, paper);
      await end(attemptId);

      await expect(
        db.client.result.create({
          data: { ...newResult(attemptId), correctCount: 1, wrongCount: 1, attemptedCount: 1 },
        }),
      ).rejects.toThrow(/results_attempted_sum/);

      await expect(
        db.client.result.create({ data: { ...newResult(attemptId), unattemptedCount: 5 } }),
      ).rejects.toThrow(/results_total_sum/);

      await expect(
        db.client.result.create({ data: { ...newResult(attemptId), accuracy: '1.5' } }),
      ).rejects.toThrow(/results_accuracy_range/);

      await expect(
        db.client.result.create({
          data: { ...newResult(attemptId), correctCount: 0, wrongCount: 0, attemptedCount: 0, accuracy: '0.5' },
        }),
      ).rejects.toThrow(/results_accuracy_zero_when_unattempted/);

      expect(await db.client.result.count({ where: { attemptId } })).toBe(0);
    });
  });

  describe('the grace setting', () => {
    it('exists with its bounds', async () => {
      const setting = await db.client.setting.findUniqueOrThrow({
        where: { key: 'attempt_submit_grace_seconds' },
        select: { valueInt: true, minInt: true, maxInt: true },
      });

      expect(setting.valueInt).toBe(5);
      expect(setting.minInt).toBe(0);
      expect(setting.maxInt).toBe(60);
    });
  });
});
