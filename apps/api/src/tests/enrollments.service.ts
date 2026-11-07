import { randomUUID } from 'node:crypto';

import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { CoinService } from '../coins/coin.service';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { ENROLLMENT_COST_SETTING, type StudentCatalogQuery, type StudentPageQuery } from './validation';

/**
 * The student side of phase 6: the published catalog, and buying one attempt of one paper.
 *
 * Two rules shape everything here. The account is the session's — there is no `userId`
 * parameter on any route, and the two that could carry one refuse it by name. And a sale is
 * one fact: the `ENROLLMENT` debit and the `enrollments` row commit together inside one
 * transaction that locks the wallet row first, the test row second and the student's
 * enrollment rows third, so a double click, a retry or two tabs cannot charge twice and two
 * students cannot deadlock on each other's wallets.
 *
 * The debit itself is not written here. `CoinService` owns the ledger; this service opens the
 * transaction and calls `spendWithin`, which is the same code path `spend` uses for every
 * other movement.
 */

/** What a student may see about a paper. Never a question, an option or an answer key. */
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

/** The caller's own state for one paper. */
export interface StudentEnrollmentState {
  readonly status: 'NONE' | 'OPEN' | 'COMPLETED' | 'EXPIRED';
  readonly attemptNumber: number | null;
  readonly enrollmentId: string | null;
  readonly attemptsUsed: number;
}

export interface StudentTestView extends StudentTestSummary {
  readonly enrollment: StudentEnrollmentState;
}

export interface StudentTestPage {
  readonly items: StudentTestView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

/** One enrollment as its owner sees it: the paper it bought, the version, and the price paid. */
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
  readonly items: EnrollmentView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

const TEST_SUMMARY_SELECT = {
  id: true,
  title: true,
  maxAttempts: true,
  exam: { select: { id: true, name: true } },
} satisfies Prisma.TestSelect;

const TEST_VERSION_SELECT = {
  id: true,
  version: true,
  durationMinutes: true,
  marksPerQuestion: true,
  negativeMarksPerQuestion: true,
  _count: { select: { questions: true } },
} satisfies Prisma.TestVersionSelect;

const ENROLLMENT_VIEW_SELECT = {
  id: true,
  testId: true,
  testVersionId: true,
  attemptNumber: true,
  status: true,
  enrolledAt: true,
  completedAt: true,
  coinTransaction: { select: { amount: true, newBalance: true } },
  test: { select: TEST_SUMMARY_SELECT },
  testVersion: { select: TEST_VERSION_SELECT },
} satisfies Prisma.EnrollmentSelect;

const CATALOG_ROW_SELECT = {
  ...TEST_SUMMARY_SELECT,
  versions: {
    where: { publishedAt: { not: null } },
    orderBy: { version: 'desc' },
    take: 1,
    select: TEST_VERSION_SELECT,
  },
} satisfies Prisma.TestSelect;

type SummaryRow = Prisma.TestGetPayload<{ select: typeof TEST_SUMMARY_SELECT }>;
type VersionRow = Prisma.TestVersionGetPayload<{ select: typeof TEST_VERSION_SELECT }>;
type EnrollmentRow = Prisma.EnrollmentGetPayload<{ select: typeof ENROLLMENT_VIEW_SELECT }>;

interface EnrollmentStateRow {
  readonly id: string;
  readonly status: string;
  readonly attemptNumber: number;
}

interface LockedTestRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly max_attempts: number | null;
}

function totalMarks(marks: string, count: number): string {
  return (Number(marks) * count).toFixed(2);
}

function summaryOf(test: SummaryRow, version: VersionRow, cost: number): StudentTestSummary {
  const marks = version.marksPerQuestion.toString();

  return {
    id: test.id,
    title: test.title,
    exam: { id: test.exam.id, name: test.exam.name },
    durationMinutes: version.durationMinutes,
    questionCount: version._count.questions,
    totalMarks: totalMarks(marks, version._count.questions),
    marksPerQuestion: marks,
    negativeMarksPerQuestion: version.negativeMarksPerQuestion.toString(),
    cost,
    maxAttempts: test.maxAttempts,
  };
}

function enrollmentState(rows: readonly EnrollmentStateRow[]): StudentEnrollmentState {
  const open = rows.find((row) => row.status === 'OPEN');
  if (open !== undefined) {
    return { status: 'OPEN', attemptNumber: open.attemptNumber, enrollmentId: open.id, attemptsUsed: rows.length };
  }

  const newest = rows[0];
  if (newest === undefined) {
    return { status: 'NONE', attemptNumber: null, enrollmentId: null, attemptsUsed: 0 };
  }

  const status = newest.status === 'COMPLETED' || newest.status === 'EXPIRED' ? newest.status : 'NONE';
  return { status, attemptNumber: newest.attemptNumber, enrollmentId: newest.id, attemptsUsed: rows.length };
}

function toEnrollmentView(row: EnrollmentRow): EnrollmentView {
  const marks = row.testVersion.marksPerQuestion.toString();
  const count = row.testVersion._count.questions;
  const cost = Math.abs(row.coinTransaction.amount);

  return {
    id: row.id,
    testId: row.testId,
    testVersionId: row.testVersionId,
    attemptNumber: row.attemptNumber,
    status: row.status,
    enrolledAt: row.enrolledAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    cost,
    balanceAfter: row.coinTransaction.newBalance,
    test: {
      id: row.test.id,
      title: row.test.title,
      exam: { id: row.test.exam.id, name: row.test.exam.name },
      durationMinutes: row.testVersion.durationMinutes,
      questionCount: count,
      totalMarks: totalMarks(marks, count),
      marksPerQuestion: marks,
      negativeMarksPerQuestion: row.testVersion.negativeMarksPerQuestion.toString(),
      cost,
      maxAttempts: row.test.maxAttempts,
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(CoinService) private readonly coins: CoinService,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  /** The published catalog, priced, with the caller's own state for each paper. */
  async list(actor: AuthenticatedUser, query: StudentCatalogQuery): Promise<StudentTestPage> {
    await this.assertActive(actor.id);
    const cost = await this.displayCost();

    const where: Prisma.TestWhereInput = {
      status: 'PUBLISHED',
      ...(query.examId === undefined ? {} : { examId: query.examId }),
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.test.count({ where }),
      this.prisma.test.findMany({
        where,
        select: CATALOG_ROW_SELECT,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const items: StudentTestView[] = [];
    const states = await this.statesFor(
      actor.id,
      rows.map((row) => row.id),
    );

    for (const row of rows) {
      const version = row.versions[0];
      // A published test always has a published version; a row without one is not sellable and
      // is left out rather than shown with a broken pattern.
      if (version === undefined) {
        continue;
      }
      items.push({
        ...summaryOf(row, version, cost),
        enrollment: enrollmentState(states.get(row.id) ?? []),
      });
    }

    return {
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /** One published paper, with the caller's own state. */
  async get(actor: AuthenticatedUser, id: string): Promise<StudentTestView> {
    await this.assertActive(actor.id);
    const cost = await this.displayCost();

    const row = await this.prisma.test.findFirst({
      where: { id, status: 'PUBLISHED' },
      select: CATALOG_ROW_SELECT,
    });
    const version = row?.versions[0];

    if (row === null || version === undefined) {
      throw new NotFoundException('Unknown test');
    }

    const states = await this.statesFor(actor.id, [row.id]);

    return { ...summaryOf(row, version, cost), enrollment: enrollmentState(states.get(row.id) ?? []) };
  }

  /**
   * This student's enrollments for the papers on one page, grouped by test.
   *
   * Read separately from the tests rather than nested inside the catalog query, so the
   * per-request filter is plain SQL the type checker can see through.
   */
  private async statesFor(userId: string, testIds: readonly string[]): Promise<Map<string, EnrollmentStateRow[]>> {
    const grouped = new Map<string, EnrollmentStateRow[]>();
    if (testIds.length === 0) {
      return grouped;
    }

    const rows = await this.prisma.enrollment.findMany({
      where: { userId, testId: { in: [...testIds] } },
      select: { id: true, testId: true, status: true, attemptNumber: true },
      orderBy: [{ attemptNumber: 'desc' }, { id: 'desc' }],
    });

    for (const row of rows) {
      const list = grouped.get(row.testId) ?? [];
      list.push({ id: row.id, status: row.status, attemptNumber: row.attemptNumber });
      grouped.set(row.testId, list);
    }

    return grouped;
  }

  /**
   * One attempt of one paper, paid for once.
   *
   * `idempotencyKey` was validated by the controller. A key this account already spent on this
   * test settles the request with the enrollment the first call wrote, at no cost; the same
   * key on another test is a conflict rather than a silent substitution.
   */
  async enroll(
    actor: AuthenticatedUser,
    testId: string,
    idempotencyKey: string,
    meta: RequestMetadata = {},
  ): Promise<EnrollmentView> {
    await this.assertActive(actor.id);

    // Step 1: a key already spent answers before anything is locked or written.
    const existing = await this.prisma.enrollment.findUnique({
      where: { userId_idempotencyKey: { userId: actor.id, idempotencyKey } },
      select: { id: true, testId: true },
    });

    if (existing !== null) {
      if (existing.testId !== testId) {
        throw new ConflictException('That Idempotency-Key was already used for another test');
      }
      return this.view(actor.id, existing.id);
    }

    const enrollmentId = randomUUID();

    const settledId = await this.prisma
      .$transaction(
        async (tx) => {
          // Step 2: the wallet row, first. Every enrollment by this student serialises here, and
          // the key is re-checked under the lock, because two requests carrying it can both have
          // passed step 1.
          await this.coins.lockWallet(tx, actor.id);

          const raced = await tx.enrollment.findUnique({
            where: { userId_idempotencyKey: { userId: actor.id, idempotencyKey } },
            select: { id: true, testId: true },
          });
          if (raced !== null) {
            if (raced.testId !== testId) {
              throw new ConflictException('That Idempotency-Key was already used for another test');
            }
            return raced.id;
          }

          // Step 3: the test row, in SHARE mode (readers never block each other), and only a
          // published paper is for sale.
          const tests = await tx.$queryRaw<LockedTestRow[]>`
            SELECT "id", "title", "status", "max_attempts"
            FROM "tests"
            WHERE "id" = ${testId}::uuid
            FOR SHARE
          `;
          const test = tests[0];

          if (test === undefined) {
            throw new NotFoundException('Unknown test');
          }
          if (test.status === 'ARCHIVED') {
            throw new ConflictException('This test has been archived and is no longer sold');
          }
          if (test.status !== 'PUBLISHED') {
            throw new ConflictException('This test is not published yet');
          }

          // The live version, not a draft revision a builder may be editing beside it.
          const version = await tx.testVersion.findFirst({
            where: { testId, publishedAt: { not: null } },
            orderBy: { version: 'desc' },
            select: { id: true, version: true },
          });
          if (version === null) {
            throw new ConflictException('This test has no published version to enroll in');
          }

          // Step 4: one open enrollment per test, and the paper's own attempt cap.
          const open = await tx.enrollment.findFirst({
            where: { userId: actor.id, testId, status: 'OPEN' },
            select: { id: true },
          });
          if (open !== null) {
            throw new ConflictException('You already have an open enrollment for this test');
          }

          const used = await tx.enrollment.count({ where: { userId: actor.id, testId } });
          if (test.max_attempts !== null && used >= test.max_attempts) {
            throw new ConflictException(`This test allows ${String(test.max_attempts)} attempt(s)`);
          }

          // Step 5: the price, read here so it is the one this enrollment pays.
          const setting = await tx.setting.findUnique({
            where: { key: ENROLLMENT_COST_SETTING },
            select: { valueInt: true },
          });
          const cost = this.requireCost(setting?.valueInt ?? null);

          // Step 6: the debit and the row, in one transaction. The enrollment id comes first so
          // the ledger's `reference_id` names the row that will exist.
          const entry = await this.coins.spendWithin(tx, {
            userId: actor.id,
            amount: cost,
            type: 'ENROLLMENT',
            idempotencyKey: `enroll:${idempotencyKey}`,
            reference: { type: 'enrollment', id: enrollmentId },
            description: `Enrollment in ${test.title}`,
          });

          await tx.enrollment.create({
            data: {
              id: enrollmentId,
              testId,
              testVersionId: version.id,
              userId: actor.id,
              attemptNumber: used + 1,
              status: 'OPEN',
              coinTransactionId: entry.id,
              idempotencyKey,
            },
          });

          await writeIdentityAudit(tx, {
            action: 'ENROLLMENT_CREATED',
            actorUserId: actor.id,
            actorRole: actor.roleCode,
            entityType: 'enrollment',
            entityId: enrollmentId,
            metadata: {
              testId,
              testVersionId: version.id,
              version: version.version,
              attemptNumber: used + 1,
              cost,
              coinTransactionId: entry.id,
            },
            ip: meta.ip ?? null,
          });

          return enrollmentId;
        },
        { timeout: 10_000, maxWait: 10_000 },
      )
      .catch((error: unknown) => {
        // Step 7: two different keys for one test can pass the checks together. The database's
        // own indexes decide; either violation rolls the debit back and is a 409, never a 500.
        if (isUniqueViolation(error)) {
          throw new ConflictException('Another enrollment for this test was written at the same moment; try again');
        }
        throw error;
      });

    return this.view(actor.id, settledId);
  }

  /** The caller's own enrollments, newest first. */
  async mine(actor: AuthenticatedUser, query: StudentPageQuery): Promise<EnrollmentPage> {
    await this.assertActive(actor.id);

    const where: Prisma.EnrollmentWhereInput = { userId: actor.id };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.enrollment.count({ where }),
      this.prisma.enrollment.findMany({
        where,
        select: ENROLLMENT_VIEW_SELECT,
        orderBy: [{ enrolledAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map(toEnrollmentView),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  private async view(userId: string, id: string): Promise<EnrollmentView> {
    const row = await this.prisma.enrollment.findFirst({ where: { id, userId }, select: ENROLLMENT_VIEW_SELECT });

    if (row === null) {
      throw new NotFoundException('Unknown enrollment');
    }

    return toEnrollmentView(row);
  }

  /** The price of one attempt. Zero closes enrollment rather than selling a free paper. */
  private requireCost(value: number | null): number {
    if (value === null || value <= 0) {
      throw new ConflictException('Enrollment is closed: the platform has set no enrollment cost');
    }

    return value;
  }

  /**
   * The price of one attempt for a read. A zero is shown as zero: reading the catalog is not
   * the moment to refuse, and `enroll` is.
   */
  private async displayCost(): Promise<number> {
    const row = await this.prisma.setting.findUnique({
      where: { key: ENROLLMENT_COST_SETTING },
      select: { valueInt: true },
    });

    return row?.valueInt ?? 0;
  }

  private async assertActive(userId: string): Promise<void> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });

    if (row === null) {
      throw new NotFoundException('Account not found');
    }
    if (row.status !== 'ACTIVE') {
      throw new ForbiddenException('This account is not active');
    }
  }
}
