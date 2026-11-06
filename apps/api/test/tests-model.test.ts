import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Phase 6, P1: the test-builder tables and enrollment are constrained by the database, not
 * only by the API that will use them in P2 and P4.
 *
 * Proven here: the CHECKs on a paper's pattern and on an enrollment, the published-paper
 * freeze, one OPEN enrollment per student per test under two simultaneous inserts, the
 * enrollment's link to its own ENROLLMENT ledger row, and the retirement of the
 * `publish_tests` editor flag (`tests.publish` is an Administrator's alone now; publishing a
 * question is `content.publish`, which the EDITOR role carries).
 *
 * Raw statements cast every parameter that lands in a uuid column (`$1::uuid`): Prisma's
 * raw protocol sends parameters untyped, and Postgres will not infer a uuid from text.
 */

interface Fixture {
  readonly examId: string;
  readonly adminId: string;
  readonly admin2Id: string;
  readonly editorId: string;
  readonly studentId: string;
}

describe('phase 6 test model and enrollment', () => {
  let db!: TestDatabase;
  let fixture!: Fixture;
  const extraClients: PrismaClient[] = [];

  beforeAll(async () => {
    db = await createMigratedTestDatabase('tests_model');
    const marker = randomUUID().slice(0, 8);

    const roleId = async (code: string): Promise<string> =>
      (await db.client.role.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;

    const person = async (roleCode: string, label: string): Promise<string> => {
      const user = await db.client.user.create({
        data: {
          email: `${label}-${marker}-${randomUUID().slice(0, 8)}@example.com`,
          passwordHash: 'not-a-real-hash',
          fullName: `Phase Six ${label}`,
          roleId: await roleId(roleCode),
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
      return user.id;
    };

    const adminId = await person('ADMIN', 'admin');
    // A second administrator, because the database refuses a self-granted permission.
    const admin2Id = await person('ADMIN', 'admin2');
    const editorId = await person('EDITOR', 'editor');
    const studentId = await person('USER', 'student');

    const category = await db.client.examCategory.create({
      data: { name: 'Phase 6 Category', slug: `phase-6-cat-${marker}`, createdBy: adminId },
      select: { id: true },
    });

    const exam = await db.client.exam.create({
      data: {
        categoryId: category.id,
        name: 'Phase 6 Exam',
        slug: `phase-6-exam-${marker}`,
        createdBy: adminId,
      },
      select: { id: true },
    });

    fixture = { examId: exam.id, adminId, admin2Id, editorId, studentId };
  }, 120_000);

  afterAll(async () => {
    for (const client of extraClients) {
      await client.$disconnect();
    }
    await db?.dispose();
  }, 60_000);

  /** A second connection, so the concurrency test really races two sessions. */
  function secondClient(): PrismaClient {
    const client = new PrismaClient({ datasources: { db: { url: db.url } } });
    extraClients.push(client);
    return client;
  }

  async function newTest(status = 'DRAFT'): Promise<string> {
    const test = await db.client.test.create({
      data: {
        examId: fixture.examId,
        createdBy: fixture.editorId,
        title: `Paper ${randomUUID().slice(0, 8)}`,
        status,
      },
      select: { id: true },
    });
    return test.id;
  }

  async function newVersion(
    testId: string,
    overrides: { durationMinutes?: number; marks?: number; negative?: number; published?: boolean; version?: number } = {},
  ): Promise<string> {
    const version = await db.client.testVersion.create({
      data: {
        testId,
        version: overrides.version ?? 1,
        durationMinutes: overrides.durationMinutes ?? 120,
        marksPerQuestion: overrides.marks ?? 2,
        negativeMarksPerQuestion: overrides.negative ?? 0.5,
        publishedAt: overrides.published === true ? new Date() : null,
        createdBy: fixture.editorId,
      },
      select: { id: true },
    });
    return version.id;
  }

  async function newQuestion(): Promise<string> {
    const subject = await db.client.subject.create({
      data: {
        examId: fixture.examId,
        name: 'Phase 6 Subject',
        slug: `phase-6-sub-${randomUUID().slice(0, 8)}`,
        createdBy: fixture.editorId,
      },
      select: { id: true },
    });
    const question = await db.client.question.create({
      data: { examId: fixture.examId, subjectId: subject.id, createdBy: fixture.editorId },
      select: { id: true },
    });
    return question.id;
  }

  /**
   * A wallet funded to 200 and one ENROLLMENT charge of 100, written the way `CoinService.spend`
   * will write them in P4: the ledger's own trigger moves the wallet.
   */
  async function enrollmentCharge(userId: string): Promise<string> {
    const wallet = await db.client.coinWallet.upsert({
      where: { userId },
      create: { userId, balance: 200 },
      update: {},
      select: { balance: true },
    });

    const entry = await db.client.coinTransaction.create({
      data: {
        userId,
        type: 'ENROLLMENT',
        amount: -100,
        previousBalance: wallet.balance,
        newBalance: wallet.balance - 100,
        referenceType: 'enrollment',
        referenceId: randomUUID(),
        idempotencyKey: `enroll:${randomUUID()}`,
        requestFingerprint: randomUUID().replace(/-/g, '').repeat(2),
      },
      select: { id: true },
    });
    return entry.id;
  }

  /** A ledger row of another type, for the "not an ENROLLMENT" case. */
  async function adminCredit(userId: string): Promise<string> {
    const wallet = await db.client.coinWallet.upsert({
      where: { userId },
      create: { userId, balance: 200 },
      update: {},
      select: { balance: true },
    });

    const entry = await db.client.coinTransaction.create({
      data: {
        userId,
        type: 'ADMIN_CREDIT',
        amount: 10,
        previousBalance: wallet.balance,
        newBalance: wallet.balance + 10,
        idempotencyKey: `admin:${randomUUID()}`,
        requestFingerprint: randomUUID().replace(/-/g, '').repeat(2),
      },
      select: { id: true },
    });
    return entry.id;
  }

  async function enroll(
    client: PrismaClient,
    values: { testId: string; versionId: string; userId: string; chargeId: string; attempt?: number },
  ): Promise<void> {
    await client.enrollment.create({
      data: {
        testId: values.testId,
        testVersionId: values.versionId,
        userId: values.userId,
        attemptNumber: values.attempt ?? 1,
        coinTransactionId: values.chargeId,
        idempotencyKey: `enroll:${randomUUID()}`,
      },
    });
  }

  async function enrollmentCount(testId: string, userId: string): Promise<number> {
    return db.client.enrollment.count({ where: { testId, userId } });
  }

  describe('CHECK constraints', () => {
    it('refuses a paper with no time, no marks or a negative marking above the marks', async () => {
      const testId = await newTest();

      await expect(newVersion(testId, { durationMinutes: 0 })).rejects.toThrow(/test_versions_duration_range/);
      await expect(newVersion(testId, { marks: 0 })).rejects.toThrow(/test_versions_marks_positive/);
      await expect(newVersion(testId, { marks: 1, negative: 2 })).rejects.toThrow(
        /test_versions_negative_marks_range/,
      );
    });

    it('refuses a non-positive attempt cap and an attempt number below one', async () => {
      await expect(
        db.client.test.create({
          data: {
            examId: fixture.examId,
            createdBy: fixture.editorId,
            title: 'Capped paper',
            maxAttempts: 0,
          },
        }),
      ).rejects.toThrow(/tests_max_attempts_positive/);

      const testId = await newTest();
      const versionId = await newVersion(testId);
      const chargeId = await enrollmentCharge(fixture.studentId);

      await expect(
        enroll(db.client, { testId, versionId, userId: fixture.studentId, chargeId, attempt: 0 }),
      ).rejects.toThrow(/enrollments_attempt_number_positive/);
    });
  });

  describe('the published paper is frozen', () => {
    it('refuses to change or delete a published version and to change its questions', async () => {
      const testId = await newTest('PUBLISHED');
      const versionId = await newVersion(testId, { published: true });
      const questionId = await newQuestion();

      await expect(
        db.client.$executeRawUnsafe(`UPDATE "test_versions" SET "duration_minutes" = 90 WHERE "id" = $1::uuid`, versionId),
      ).rejects.toThrow(/published version cannot be updated/);

      await expect(
        db.client.$executeRawUnsafe(`DELETE FROM "test_versions" WHERE "id" = $1::uuid`, versionId),
      ).rejects.toThrow(/published version cannot be deleted/);

      await expect(
        db.client.testQuestion.create({
          data: { testVersionId: versionId, questionId, position: 1 },
        }),
      ).rejects.toThrow(/published paper cannot be changed/);
    });

    it('lets a draft paper be edited, and refuses to send a published test back to draft', async () => {
      const draftTest = await newTest();
      const draftVersion = await newVersion(draftTest);
      const questionId = await newQuestion();

      const placed = await db.client.testQuestion.create({
        data: { testVersionId: draftVersion, questionId, position: 1 },
        select: { id: true },
      });
      await db.client.testQuestion.delete({ where: { id: placed.id } });

      const publishedTest = await newTest('PUBLISHED');
      await db.client.$executeRawUnsafe(`UPDATE "tests" SET "published_at" = now() WHERE "id" = $1::uuid`, publishedTest);

      await expect(
        db.client.$executeRawUnsafe(`UPDATE "tests" SET "status" = 'DRAFT' WHERE "id" = $1::uuid`, publishedTest),
      ).rejects.toThrow(/cannot go back to DRAFT/);

      await expect(
        db.client.$executeRawUnsafe(`DELETE FROM "tests" WHERE "id" = $1::uuid`, publishedTest),
      ).rejects.toThrow(/published test cannot be deleted/);
    });
  });

  describe('one open enrollment per student per test', () => {
    it('lets one of two simultaneous inserts win and refuses the other', async () => {
      const testId = await newTest();
      const versionId = await newVersion(testId);
      const firstCharge = await enrollmentCharge(fixture.studentId);
      const secondCharge = await enrollmentCharge(fixture.studentId);

      const other = secondClient();
      const results = await Promise.allSettled([
        enroll(db.client, { testId, versionId, userId: fixture.studentId, chargeId: firstCharge }),
        enroll(other, { testId, versionId, userId: fixture.studentId, chargeId: secondCharge }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/enrollments_one_open_per_test/);

      expect(await enrollmentCount(testId, fixture.studentId)).toBe(1);
    });

    it('allows a retake once the first enrollment is no longer open, as a new attempt', async () => {
      const testId = await newTest();
      const versionId = await newVersion(testId);

      await enroll(db.client, {
        testId,
        versionId,
        userId: fixture.editorId,
        chargeId: await enrollmentCharge(fixture.editorId),
      });
      await db.client.$executeRawUnsafe(
        `UPDATE "enrollments" SET "status" = 'COMPLETED', "completed_at" = now() WHERE "test_id" = $1::uuid`,
        testId,
      );

      await enroll(db.client, {
        testId,
        versionId,
        userId: fixture.editorId,
        chargeId: await enrollmentCharge(fixture.editorId),
        attempt: 2,
      });

      expect(await enrollmentCount(testId, fixture.editorId)).toBe(2);
    });
  });

  describe('the enrollment is tied to its own ENROLLMENT ledger row', () => {
    it('refuses a second enrollment on the same debit', async () => {
      const firstTest = await newTest();
      const secondTest = await newTest();
      const chargeId = await enrollmentCharge(fixture.studentId);

      await enroll(db.client, {
        testId: firstTest,
        versionId: await newVersion(firstTest),
        userId: fixture.studentId,
        chargeId,
      });

      await expect(
        enroll(db.client, {
          testId: secondTest,
          versionId: await newVersion(secondTest),
          userId: fixture.studentId,
          chargeId,
        }),
      ).rejects.toThrow(/enrollments_coin_transaction_key/);
    });

    it("refuses another student's debit", async () => {
      const testId = await newTest();
      const versionId = await newVersion(testId);
      const someoneElses = await enrollmentCharge(fixture.adminId);

      await expect(
        enroll(db.client, { testId, versionId, userId: fixture.studentId, chargeId: someoneElses }),
      ).rejects.toThrow(/does not belong to this student/);
    });

    it('refuses a debit that is not an ENROLLMENT row', async () => {
      const testId = await newTest();
      const versionId = await newVersion(testId);
      const credit = await adminCredit(fixture.studentId);

      await expect(
        enroll(db.client, { testId, versionId, userId: fixture.studentId, chargeId: credit }),
      ).rejects.toThrow(/not an ENROLLMENT/);
    });

    it('refuses a version that belongs to another test', async () => {
      const firstTest = await newTest();
      const secondTest = await newTest();
      const secondVersion = await newVersion(secondTest);
      const chargeId = await enrollmentCharge(fixture.studentId);

      await expect(
        enroll(db.client, { testId: firstTest, versionId: secondVersion, userId: fixture.studentId, chargeId }),
      ).rejects.toThrow(/does not belong to test/);
    });
  });

  describe('tests.publish belongs to the administrator alone', () => {
    it('grants content.publish to editors and admin, and tests.publish only to admin', async () => {
      const pairs = await db.client.$queryRawUnsafe<Array<{ role: string; code: string }>>(
        `SELECT r."code" AS role, p."code" AS code
           FROM "role_permissions" rp
           JOIN "roles" r ON r."id" = rp."role_id"
           JOIN "permissions" p ON p."id" = rp."permission_id"
          WHERE p."code" IN ('content.publish', 'tests.publish')`,
      );

      const has = (role: string, code: string): boolean =>
        pairs.some((pair) => pair.role === role && pair.code === code);

      expect(has('ADMIN', 'content.publish')).toBe(true);
      expect(has('EDITOR', 'content.publish')).toBe(true);
      expect(has('ADMIN', 'tests.publish')).toBe(true);
      expect(has('EDITOR', 'tests.publish')).toBe(false);
    });

    it('refuses a tests.publish grant to an editor, and content.write to a student', async () => {
      const permissionId = async (code: string): Promise<string> =>
        (await db.client.permission.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;

      await expect(
        db.client.userPermission.create({
          data: {
            userId: fixture.editorId,
            permissionId: await permissionId('tests.publish'),
            grantedBy: fixture.adminId,
          },
        }),
      ).rejects.toThrow(/tests.publish may only be held by an ADMIN account/);

      await expect(
        db.client.userPermission.create({
          data: {
            userId: fixture.studentId,
            permissionId: await permissionId('content.write'),
            grantedBy: fixture.adminId,
          },
        }),
      ).rejects.toThrow(/Editor capability may only be granted to an EDITOR account/);

      // An administrator may hold it: the rule is about the role, not the code. The grant is
      // made by the other administrator, because a self-grant is refused outright.
      await expect(
        db.client.userPermission.create({
          data: {
            userId: fixture.admin2Id,
            permissionId: await permissionId('tests.publish'),
            grantedBy: fixture.adminId,
          },
        }),
      ).resolves.toBeTruthy();
    });
  });
});
