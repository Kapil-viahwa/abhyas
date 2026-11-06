import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { sanitizeStoredContent } from '../questions/sanitize';
import type { CreateTestInput, TestListQuery, UpdateTestInput } from './validation';

const PAGE_SIZE = 20;

export interface TestOptionView {
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
  readonly isCorrect: boolean;
  readonly imageId: string | null;
}

export interface TestQuestionView {
  readonly questionId: string;
  readonly position: number;
  readonly questionStatus: string;
  readonly questionType: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly numericalAnswer: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly options: readonly TestOptionView[];
}

export interface TestVersionView {
  readonly version: number;
  readonly durationMinutes: number;
  readonly marksPerQuestion: string;
  readonly negativeMarksPerQuestion: string;
  readonly questionCount: number;
  readonly totalMarks: string;
  readonly publishedAt: string | null;
}

export interface TestView {
  readonly id: string;
  readonly examId: string;
  readonly createdBy: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly currentVersion: number;
  readonly maxAttempts: number | null;
  readonly submittedAt: string | null;
  readonly publishedAt: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
  /** The version being edited: a draft, or the live pattern when nothing is being revised. */
  readonly version: TestVersionView;
  /** What a student would be sold today; a revision does not change it until it is published. */
  readonly publishedVersion: TestVersionView | null;
  /** The current version's paper, with the answer key (Editor and Administrator responses only). */
  readonly questions: readonly TestQuestionView[];
}

export interface TestListResult {
  readonly items: readonly TestView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

interface LockedTestRow {
  readonly id: string;
  readonly exam_id: string;
  readonly created_by: string;
  readonly status: string;
  readonly current_version: number;
  readonly published_at: Date | null;
  readonly archived_at: Date | null;
}

interface LockedTest {
  readonly id: string;
  readonly examId: string;
  readonly createdBy: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly publishedAt: Date | null;
  readonly archivedAt: Date | null;
}

interface VersionRow {
  readonly id: string;
  readonly version: number;
  readonly durationMinutes: number;
  readonly marksPerQuestion: Prisma.Decimal;
  readonly negativeMarksPerQuestion: Prisma.Decimal;
  readonly publishedAt: Date | null;
  readonly questionCount: number;
}

const TEST_SELECT = {
  id: true,
  examId: true,
  createdBy: true,
  title: true,
  description: true,
  status: true,
  currentVersion: true,
  maxAttempts: true,
  submittedAt: true,
  publishedAt: true,
  archivedAt: true,
  updatedAt: true,
} satisfies Prisma.TestSelect;

const VERSION_SELECT = {
  id: true,
  version: true,
  durationMinutes: true,
  marksPerQuestion: true,
  negativeMarksPerQuestion: true,
  publishedAt: true,
  _count: { select: { questions: true } },
} satisfies Prisma.TestVersionSelect;

const QUESTION_SELECT = {
  id: true,
  examId: true,
  createdBy: true,
  status: true,
  currentVersion: true,
  versions: {
    select: {
      version: true,
      questionType: true,
      contentHtml: true,
      explanationHtml: true,
      latex: true,
      numericalAnswer: true,
      marks: true,
      negativeMarks: true,
      publishedAt: true,
      options: {
        orderBy: { position: 'asc' },
        select: {
          position: true,
          optionHtml: true,
          latex: true,
          isCorrect: true,
          imageId: true,
        },
      },
    },
  },
} satisfies Prisma.QuestionSelect;

type TestRow = Prisma.TestGetPayload<{ select: typeof TEST_SELECT }>;

type QuestionRow = Prisma.QuestionGetPayload<{ select: typeof QUESTION_SELECT }>;

type VersionRowWithCount = Prisma.TestVersionGetPayload<{ select: typeof VERSION_SELECT }>;

function totalMarks(marks: string, count: number): string {
  return (Number(marks) * count).toFixed(2);
}

function versionView(row: VersionRowWithCount): TestVersionView {
  const marks = row.marksPerQuestion.toString();
  return {
    version: row.version,
    durationMinutes: row.durationMinutes,
    marksPerQuestion: marks,
    negativeMarksPerQuestion: row.negativeMarksPerQuestion.toString(),
    questionCount: row._count.questions,
    totalMarks: totalMarks(marks, row._count.questions),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

function toVersionRow(row: VersionRowWithCount): VersionRow {
  return {
    id: row.id,
    version: row.version,
    durationMinutes: row.durationMinutes,
    marksPerQuestion: row.marksPerQuestion,
    negativeMarksPerQuestion: row.negativeMarksPerQuestion,
    publishedAt: row.publishedAt,
    questionCount: row._count.questions,
  };
}

function toQuestionView(question: QuestionRow, position: number): TestQuestionView {
  const current = question.versions.find((version) => version.version === question.currentVersion);
  if (!current) {
    throw new ConflictException('A question on this paper has no current version');
  }

  return {
    questionId: question.id,
    position,
    questionStatus: question.status,
    questionType: current.questionType,
    contentHtml: sanitizeStoredContent(current.contentHtml),
    explanationHtml: current.explanationHtml === null ? null : sanitizeStoredContent(current.explanationHtml),
    latex: current.latex,
    numericalAnswer: current.numericalAnswer,
    marks: current.marks.toString(),
    negativeMarks: current.negativeMarks.toString(),
    options: current.options.map((option) => ({
      position: option.position,
      optionHtml: sanitizeStoredContent(option.optionHtml),
      latex: option.latex,
      isCorrect: option.isCorrect,
      imageId: option.imageId,
    })),
  };
}

/**
 * The test builder.
 *
 * A test is a paper: a `tests` row for the lifecycle and a `test_versions` row for the pattern
 * and its ordered questions. Only an Administrator publishes or archives one (decision 0069);
 * an editor with `manage_tests` builds, edits and submits.
 *
 * Every state change runs inside one transaction that first takes the test's row lock
 * (`SELECT ... FOR UPDATE`), so two simultaneous submits or publishes cannot both win: the
 * second one reads the state the first committed and is refused. Ownership follows the question
 * bank's rule — an editor works on what they created, an administrator on everything, and a
 * foreign id is reported as missing rather than forbidden so the route cannot be used to
 * discover which papers exist.
 *
 * Editing a published test opens a new version (decision 0070): the live version stays published
 * and sellable, an enrollment keeps the version it bought, and the revision is published only by
 * an Administrator.
 */
@Injectable()
export class TestsService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async list(actor: AuthenticatedUser, query: TestListQuery): Promise<TestListResult> {
    const where: Prisma.TestWhereInput = {};

    // An editor sees their own papers; an administrator sees everything.
    if (actor.roleCode !== 'ADMIN') {
      where.createdBy = actor.id;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.examId !== undefined) {
      where.examId = query.examId;
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.test.count({ where }),
      this.prisma.test.findMany({
        where,
        select: TEST_SELECT,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);

    const items = await Promise.all(rows.map(async (row) => this.toView(row, await this.versionsFor(row.id))));

    return {
      items,
      total,
      page: query.page,
      pageSize: PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  }

  async get(actor: AuthenticatedUser, id: string): Promise<TestView> {
    const test = await this.prisma.test.findUnique({ where: { id }, select: TEST_SELECT });
    if (!test || (actor.roleCode !== 'ADMIN' && test.createdBy !== actor.id)) {
      throw new NotFoundException('Unknown test');
    }

    const versions = await this.versionsFor(test.id);
    const current = versions.find((version) => version.version === test.currentVersion);
    if (!current) {
      throw new ConflictException('This test has no current version');
    }

    const questions = await this.prisma.testQuestion.findMany({
      where: { testVersionId: current.id },
      orderBy: { position: 'asc' },
      select: { position: true, question: { select: QUESTION_SELECT } },
    });

    return {
      ...this.toView(test, versions),
      questions: questions.map((row) => toQuestionView(row.question, row.position)),
    };
  }

  async create(actor: AuthenticatedUser, input: CreateTestInput, meta: RequestMetadata = {}): Promise<TestView> {
    await this.assertExam(actor, input.examId);

    const id = await this.prisma.$transaction(async (tx) => {
      const test = await tx.test.create({
        data: {
          examId: input.examId,
          createdBy: actor.id,
          title: input.title,
          description: input.description,
          status: 'DRAFT',
          currentVersion: 1,
        },
        select: { id: true, currentVersion: true },
      });

      await tx.testVersion.create({
        data: {
          testId: test.id,
          version: test.currentVersion,
          durationMinutes: input.durationMinutes,
          marksPerQuestion: '1',
          negativeMarksPerQuestion: '0',
          createdBy: actor.id,
        },
      });

      await writeIdentityAudit(tx, {
        action: 'TEST_CREATED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'test',
        entityId: test.id,
        metadata: { examId: input.examId, durationMinutes: input.durationMinutes },
        ip: meta.ip ?? null,
      });

      return test.id;
    });

    return this.get(actor, id);
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateTestInput,
    meta: RequestMetadata = {},
  ): Promise<TestView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwned(tx, actor, id);
      this.assertEditable(locked);

      const current = await this.currentVersion(tx, locked);
      const marks = input.marksPerQuestion ?? current.marksPerQuestion.toString();
      const negative = input.negativeMarksPerQuestion ?? current.negativeMarksPerQuestion.toString();
      if (Number(negative) > Number(marks)) {
        throw new BadRequestException('negativeMarksPerQuestion cannot be more than marksPerQuestion');
      }

      const working = await this.workingVersion(tx, locked, current, actor, meta);

      const versionData: Prisma.TestVersionUpdateInput = {};
      if (input.durationMinutes !== undefined) {
        versionData.durationMinutes = input.durationMinutes;
      }
      if (input.marksPerQuestion !== undefined || input.negativeMarksPerQuestion !== undefined) {
        versionData.marksPerQuestion = marks;
        versionData.negativeMarksPerQuestion = negative;
      }
      if (Object.keys(versionData).length > 0) {
        await tx.testVersion.update({ where: { id: working.id }, data: versionData });
      }

      const testData: Prisma.TestUpdateInput = {};
      if (input.title !== undefined) {
        testData.title = input.title;
      }
      if (input.description !== undefined) {
        testData.description = input.description;
      }
      if (input.maxAttempts !== undefined) {
        testData.maxAttempts = input.maxAttempts;
      }
      if (Object.keys(testData).length > 0) {
        await tx.test.update({ where: { id }, data: testData });
      }

      const fields: string[] = [...Object.keys(versionData), ...Object.keys(testData)];

      await writeIdentityAudit(tx, {
        action: 'TEST_UPDATED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'test',
        entityId: id,
        metadata: { version: working.version, fields },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  /** The paper's whole question list in one statement, so adding, removing and reordering are atomic. */
  async setQuestions(
    actor: AuthenticatedUser,
    id: string,
    questionIds: readonly string[],
    meta: RequestMetadata = {},
  ): Promise<TestView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwned(tx, actor, id);
      this.assertEditable(locked);

      const current = await this.currentVersion(tx, locked);
      const working = await this.workingVersion(tx, locked, current, actor, meta);

      const rows = await tx.question.findMany({
        where: { id: { in: [...questionIds] } },
        select: QUESTION_SELECT,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));

      for (const [index, questionId] of questionIds.entries()) {
        const label = `Question ${String(index + 1)}`;
        const question = byId.get(questionId);

        if (!question) {
          throw new BadRequestException(`${label} does not exist`);
        }
        // A foreign question is refused with the same words a made-up id gets, so the route
        // cannot be used to discover which questions exist.
        if (actor.roleCode !== 'ADMIN' && question.createdBy !== actor.id) {
          throw new BadRequestException(`${label} is not available to you`);
        }
        if (question.examId !== locked.examId) {
          throw new BadRequestException(`${label} belongs to a different exam`);
        }

        const version = question.versions.find((entry) => entry.version === question.currentVersion);
        if (!version) {
          throw new BadRequestException(`${label} has no current version`);
        }
        if (question.status !== 'PUBLISHED' || version.publishedAt === null) {
          throw new BadRequestException(`${label} is not published`);
        }
      }

      await tx.testQuestion.deleteMany({ where: { testVersionId: working.id } });
      await tx.testQuestion.createMany({
        data: questionIds.map((questionId, index) => ({
          testVersionId: working.id,
          questionId,
          position: index + 1,
        })),
      });

      await writeIdentityAudit(tx, {
        action: 'TEST_QUESTIONS_SET',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'test',
        entityId: id,
        metadata: { version: working.version, count: questionIds.length },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  async submit(actor: AuthenticatedUser, id: string, meta: RequestMetadata = {}): Promise<TestView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwned(tx, actor, id);
      const current = await this.currentVersion(tx, locked);

      if (locked.status === 'ARCHIVED') {
        throw new ConflictException('An archived test cannot be submitted');
      }
      if (locked.status === 'SUBMITTED') {
        throw new ConflictException('This test is already with an administrator');
      }
      if (current.publishedAt !== null) {
        throw new ConflictException('The current version is already published');
      }

      const count = await tx.testQuestion.count({ where: { testVersionId: current.id } });
      if (count === 0) {
        throw new BadRequestException('A test needs at least one question before it can be submitted');
      }

      if (locked.status === 'DRAFT') {
        const moved = await tx.test.updateMany({
          where: { id, status: 'DRAFT' },
          data: { status: 'SUBMITTED', submittedAt: new Date() },
        });
        if (moved.count !== 1) {
          throw new ConflictException('The test changed while it was being submitted; try again');
        }
      } else {
        // A published test cannot go back to SUBMITTED (the database refuses that transition),
        // so a revision's hand-off is recorded as the review request it is (decision 0070).
        await tx.test.update({ where: { id }, data: { submittedAt: new Date() } });
      }

      await writeIdentityAudit(tx, {
        action: 'TEST_SUBMITTED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'test',
        entityId: id,
        metadata: { version: current.version, revision: locked.status === 'PUBLISHED' },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  /** Administrator only: the route requires `tests.publish`, and the database refuses it to anyone else. */
  async publish(actor: AuthenticatedUser, id: string, meta: RequestMetadata = {}): Promise<TestView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwned(tx, actor, id);
      const current = await this.currentVersion(tx, locked);

      if (locked.status === 'ARCHIVED') {
        throw new ConflictException('An archived test cannot be published');
      }
      if (locked.status === 'DRAFT') {
        throw new ConflictException('A draft must be submitted before it can be published');
      }
      if (current.publishedAt !== null) {
        throw new ConflictException('The current version is already published');
      }

      const count = await tx.testQuestion.count({ where: { testVersionId: current.id } });
      if (count === 0) {
        throw new BadRequestException('A test needs at least one question before it can be published');
      }

      const stamped = await tx.testVersion.updateMany({
        where: { id: current.id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      if (stamped.count !== 1) {
        throw new ConflictException('Somebody else published this version first');
      }

      await tx.test.updateMany({
        where: { id },
        data: { status: 'PUBLISHED', publishedAt: locked.publishedAt ?? new Date() },
      });

      await writeIdentityAudit(tx, {
        action: 'TEST_PUBLISHED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'test',
        entityId: id,
        metadata: { version: current.version },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  /** Administrator only: a published test is retired, never deleted, because enrollments point at it. */
  async archive(actor: AuthenticatedUser, id: string, meta: RequestMetadata = {}): Promise<TestView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockOwned(tx, actor, id);

      if (locked.status !== 'PUBLISHED') {
        throw new ConflictException('Only a published test can be archived');
      }

      const moved = await tx.test.updateMany({
        where: { id, status: 'PUBLISHED' },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      if (moved.count !== 1) {
        throw new ConflictException('The test changed while it was being archived; try again');
      }

      await writeIdentityAudit(tx, {
        action: 'TEST_ARCHIVED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'test',
        entityId: id,
        metadata: { version: locked.currentVersion },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  private toView(test: TestRow, versions: readonly VersionRowWithCount[]): TestView {
    const current = versions.find((version) => version.version === test.currentVersion);
    if (!current) {
      throw new ConflictException('This test has no current version');
    }

    const latestPublished = [...versions]
      .filter((version) => version.publishedAt !== null)
      .sort((left, right) => right.version - left.version)[0];

    return {
      id: test.id,
      examId: test.examId,
      createdBy: test.createdBy,
      title: test.title,
      description: test.description,
      status: test.status,
      currentVersion: test.currentVersion,
      maxAttempts: test.maxAttempts,
      submittedAt: test.submittedAt?.toISOString() ?? null,
      publishedAt: test.publishedAt?.toISOString() ?? null,
      archivedAt: test.archivedAt?.toISOString() ?? null,
      updatedAt: test.updatedAt.toISOString(),
      version: versionView(current),
      publishedVersion: latestPublished === undefined ? null : versionView(latestPublished),
      questions: [],
    };
  }

  private async versionsFor(testId: string): Promise<VersionRowWithCount[]> {
    return this.prisma.testVersion.findMany({
      where: { testId },
      select: VERSION_SELECT,
      orderBy: { version: 'asc' },
    });
  }

  private async assertExam(actor: AuthenticatedUser, examId: string): Promise<void> {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId }, select: { id: true, createdBy: true } });
    if (!exam || (actor.roleCode !== 'ADMIN' && exam.createdBy !== actor.id)) {
      throw new NotFoundException('Unknown exam');
    }
  }

  /** The test row, locked for the rest of the transaction, and only if this caller owns it. */
  private async lockOwned(tx: Prisma.TransactionClient, actor: AuthenticatedUser, id: string): Promise<LockedTest> {
    const rows = await tx.$queryRaw<LockedTestRow[]>`
      SELECT "id", "exam_id", "created_by", "status", "current_version", "published_at", "archived_at"
      FROM "tests"
      WHERE "id" = ${id}::uuid
      FOR UPDATE
    `;

    const row = rows[0];
    if (row === undefined || (actor.roleCode !== 'ADMIN' && row.created_by !== actor.id)) {
      throw new NotFoundException('Unknown test');
    }

    return {
      id: row.id,
      examId: row.exam_id,
      createdBy: row.created_by,
      status: row.status,
      currentVersion: row.current_version,
      publishedAt: row.published_at,
      archivedAt: row.archived_at,
    };
  }

  private assertEditable(test: LockedTest): void {
    if (test.status === 'ARCHIVED') {
      throw new ConflictException('An archived test cannot be changed');
    }
    if (test.status === 'SUBMITTED') {
      throw new ConflictException('A submitted test is with an administrator for review');
    }
  }

  private async currentVersion(tx: Prisma.TransactionClient, test: LockedTest): Promise<VersionRow> {
    const row = await tx.testVersion.findUnique({
      where: { testId_version: { testId: test.id, version: test.currentVersion } },
      select: VERSION_SELECT,
    });

    if (!row) {
      throw new ConflictException('This test has no current version');
    }

    return toVersionRow(row);
  }

  /**
   * The version edits apply to. A published pattern is frozen, so editing a published test opens
   * the next version and leaves the live one — and every enrollment sold against it — untouched.
   */
  private async workingVersion(
    tx: Prisma.TransactionClient,
    test: LockedTest,
    current: VersionRow,
    actor: AuthenticatedUser,
    meta: RequestMetadata,
  ): Promise<{ id: string; version: number }> {
    if (current.publishedAt === null) {
      return { id: current.id, version: current.version };
    }

    const next = await tx.testVersion.create({
      data: {
        testId: test.id,
        version: current.version + 1,
        durationMinutes: current.durationMinutes,
        marksPerQuestion: current.marksPerQuestion,
        negativeMarksPerQuestion: current.negativeMarksPerQuestion,
        createdBy: actor.id,
      },
      select: { id: true, version: true },
    });

    // A revision starts as a copy of the live paper, so the editor changes what they mean to
    // and the Administrator reviews a complete paper rather than an empty one. The copy is
    // allowed because the new version is not published; the live one stays untouched.
    const placements = await tx.testQuestion.findMany({
      where: { testVersionId: current.id },
      orderBy: { position: 'asc' },
      select: { questionId: true, position: true },
    });
    if (placements.length > 0) {
      await tx.testQuestion.createMany({
        data: placements.map((placement) => ({
          testVersionId: next.id,
          questionId: placement.questionId,
          position: placement.position,
        })),
      });
    }

    const moved = await tx.test.updateMany({
      where: { id: test.id, currentVersion: current.version },
      data: { currentVersion: next.version },
    });
    if (moved.count !== 1) {
      throw new ConflictException('The test changed while it was being edited; try again');
    }

    await writeIdentityAudit(tx, {
      action: 'TEST_VERSION_OPENED',
      actorUserId: actor.id,
      actorRole: actor.roleCode,
      entityType: 'test',
      entityId: test.id,
      metadata: { version: next.version, from: current.version },
      ip: meta.ip ?? null,
    });

    return { id: next.id, version: next.version };
  }
}
