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
 */

interface Fixture {
  readonly examId: string;
  readonly adminId: string;
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
      const rows = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "users" ("email", "password_hash", "full_name", "role_id", "email_verified_at")
         VALUES ($1, $2, $3, $4, now()) RETURNING "id"`,
        `${label}-${marker}-${randomUUID().slice(0, 8)}@example.com`,
        'not-a-real-hash',
        `Phase Six ${label}`,
        await roleId(roleCode),
      );
      return rows[0]?.id ?? '';
    };

    const adminId = await person('ADMIN', 'admin');
    const editorId = await person('EDITOR', 'editor');
    const studentId = await person('USER', 'student');

    const categoryId = (
      await db.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "exam_categories" ("name", "slug", "created_by")
         VALUES ($1, $2, $3) RETURNING "id"`,
        'Phase 6 Category',
        `phase-6-cat-${marker}`,
        adminId,
      )
    )[0]?.id;

    const examId = (
      await db.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "exams" ("category_id", "name", "slug", "created_by")
         VALUES ($1, $2, $3, $4) RETURNING "id"`,
        categoryId,
        'Phase 6 Exam',
        `phase-6-exam-${marker}`,
        adminId,
      )
    )[0]?.id;

    fixture = { examId: examId ?? '', adminId, editorId, studentId };
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
    const rows = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "tests" ("exam_id", "created_by", "title", "status")
       VALUES ($1, $2, $3, $4) RETURNING "id"`,
      fixture.examId,
      fixture.editorId,
      `Paper ${randomUUID().slice(0, 8)}`,
      status,
    );
    return rows[0]?.id ?? '';
  }

  async function newVersion(
    testId: string,
    overrides: { durationMinutes?: number; marks?: number; negative?: number; published?: boolean; version?: number } = {},
  ): Promise<string> {
    const rows = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "test_versions"
         ("test_id", "version", "duration_minutes", "marks_per_question", "negative_marks_per_question", "published_at", "created_by")
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "id"`,
      testId,
      overrides.version ?? 1,
      overrides.durationMinutes ?? 120,
      overrides.marks ?? 2,
      overrides.negative ?? 0.5,
      overrides.published === true ? new Date() : null,
      fixture.editorId,
    );
    return rows[0]?.id ?? '';
  }

  async function newQuestion(): Promise<string> {
    const subjectId = (
      await db.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "subjects" ("exam_id", "name", "slug", "created_by")
         VALUES ($1, $2, $3, $4) RETURNING "id"`,
        fixture.examId,
        'Phase 6 Subject',
        `phase-6-sub-${randomUUID().slice(0, 8)}`,
        fixture.editorId,
      )
    )[0]?.id;

    return (
      await db.client.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO "questions" ("exam_id", "subject_id", "created_by")
         VALUES ($1, $2, $3) RETURNING "id"`,
        fixture.examId,
        subjectId,
        fixture.editorId,
      )
    )[0]?.id ?? '';
  }

  async function walletBalance(userId: string): Promise<number> {
    await db.client.$executeRawUnsafe(
      `INSERT INTO "coin_wallets" ("user_id", "balance") VALUES ($1, 200) ON CONFLICT ("user_id") DO NOTHING`,
      userId,
    );
    const rows = await db.client.$queryRawUnsafe<Array<{ balance: number }>>(
      `SELECT "balance" FROM "coin_wallets" WHERE "user_id" = $1`,
      userId,
    );
    return rows[0]?.balance ?? 0;
  }

  /**
   * One ENROLLMENT charge of 100, written the way `CoinService.spend` will write it in P4: the
   * ledger's own trigger checks `previous_balance` and moves the wallet.
   */
  async function enrollmentCharge(userId: string): Promise<string> {
    const previous = await walletBalance(userId);
    const rows = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "coin_transactions"
         ("user_id", "type", "amount", "previous_balance", "new_balance", "reference_type", "reference_id", "idempotency_key", "request_fingerprint")
       VALUES ($1, 'ENROLLMENT', -100, $2, $3, 'enrollment', $4, $5, $6) RETURNING "id"`,
      userId,
      previous,
      previous - 100,
      randomUUID(),
      `enroll:${randomUUID()}`,
      randomUUID(),
    );
    return rows[0]?.id ?? '';
  }

  /** A ledger row of another type, for the "not an ENROLLMENT" case. */
  async function adminCredit(userId: string): Promise<string> {
    const previous = await walletBalance(userId);
    const rows = await db.client.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "coin_transactions"
         ("user_id", "type", "amount", "previous_balance", "new_balance", "idempotency_key", "request_fingerprint")
       VALUES ($1, 'ADMIN_CREDIT', 10, $2, $3, $4, $5) RETURNING "id"`,
      userId,
      previous,
      previous + 10,
      `admin:${randomUUID()}`,
      randomUUID(),
    );
    return rows[0]?.id ?? '';
  }

  async function enroll(
    client: PrismaClient,
    values: { testId: string; versionId: string; userId: string; chargeId: string; attempt?: number },
  ): Promise<void> {
    await client.$executeRawUnsafe(
      `INSERT INTO "enrollments"
         ("test_id", "test_version_id", "user_id", "attempt_number", "coin_transaction_id", "idempotency_key")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      values.testId,
      values.versionId,
      values.userId,
      values.attempt ?? 1,
      values.chargeId,
      `enroll:${randomUUID()}`,
    );
  }

  async function enrollmentCount(testId: string, userId: string): Promise<number> {
    const rows = await db.client.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count FROM "enrollments" WHERE "test_id" = $1 AND "user_id" = $2`,
      testId,
      userId,
    );
    return rows[0]?.count ?? 0;
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
        db.client.$executeRawUnsafe(
          `INSERT INTO "tests" ("exam_id", "created_by", "title", "max_attempts") VALUES ($1, $2, $3, $4)`,
          fixture.examId,
          fixture.editorId,
          'Capped paper',
          0,
        ),
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
        db.client.$executeRawUnsafe(`UPDATE "test_versions" SET "duration_minutes" = 90 WHERE "id" = $1`, versionId),
      ).rejects.toThrow(/published version cannot be updated/);

      await expect(
        db.client.$executeRawUnsafe(`DELETE FROM "test_versions" WHERE "id" = $1`, versionId),
      ).rejects.toThrow(/published version cannot be deleted/);

      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "test_questions" ("test_version_id", "question_id", "position") VALUES ($1, $2, 1)`,
          versionId,
          questionId,
        ),
      ).rejects.toThrow(/published paper cannot be changed/);
    });

    it('lets a draft paper be edited, and refuses to send a published test back to draft', async () => {
      const draftTest = await newTest();
      const draftVersion = await newVersion(draftTest);
      const questionId = await newQuestion();

      await db.client.$executeRawUnsafe(
        `INSERT INTO "test_questions" ("test_version_id", "question_id", "position") VALUES ($1, $2, 1)`,
        draftVersion,
        questionId,
      );
      await db.client.$executeRawUnsafe(`DELETE FROM "test_questions" WHERE "test_version_id" = $1`, draftVersion);

      const publishedTest = await newTest('PUBLISHED');
      await db.client.$executeRawUnsafe(`UPDATE "tests" SET "published_at" = now() WHERE "id" = $1`, publishedTest);

      await expect(
        db.client.$executeRawUnsafe(`UPDATE "tests" SET "status" = 'DRAFT' WHERE "id" = $1`, publishedTest),
      ).rejects.toThrow(/cannot go back to DRAFT/);

      await expect(
        db.client.$executeRawUnsafe(`DELETE FROM "tests" WHERE "id" = $1`, publishedTest),
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
        `UPDATE "enrollments" SET "status" = 'COMPLETED', "completed_at" = now() WHERE "test_id" = $1`,
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
        db.client.$executeRawUnsafe(
          `INSERT INTO "user_permissions" ("user_id", "permission_id", "granted_by") VALUES ($1, $2, $3)`,
          fixture.editorId,
          await permissionId('tests.publish'),
          fixture.adminId,
        ),
      ).rejects.toThrow(/tests.publish may only be held by an ADMIN account/);

      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "user_permissions" ("user_id", "permission_id", "granted_by") VALUES ($1, $2, $3)`,
          fixture.studentId,
          await permissionId('content.write'),
          fixture.adminId,
        ),
      ).rejects.toThrow(/Editor capability may only be granted to an EDITOR account/);

      // An administrator may hold it: the rule is about the role, not the code.
      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "user_permissions" ("user_id", "permission_id", "granted_by") VALUES ($1, $2, $3)`,
          fixture.adminId,
          await permissionId('tests.publish'),
          fixture.adminId,
        ),
      ).resolves.toBeGreaterThan(0);
    });
  });
});
