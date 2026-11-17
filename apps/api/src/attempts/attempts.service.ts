import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';

import { paperQuestion, reviewQuestion, type PaperQuestionView, type ReviewQuestionView } from './attempts.projection';
import type { SubmitAnswerInput } from './attempts.validation';
import { ScoringError, scoreAttempt, type ScoringQuestion } from './scoring';

const GRACE_SETTING_KEY = 'attempt_submit_grace_seconds';
const DEFAULT_GRACE_SECONDS = 5;

export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'AUTO_SUBMITTED';
export type SubmitSource = 'STUDENT' | 'SWEEPER' | 'LAZY';

export interface AttemptStateView {
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly deadlineAt: string;
  /** The server's clock, so a countdown can be re-synced without trusting the browser. */
  readonly serverNow: string;
  readonly remainingSeconds: number;
  readonly submittedAt: string | null;
  readonly submitSource: string | null;
}

export interface AttemptStartView extends AttemptStateView {
  readonly questions: readonly PaperQuestionView[];
}

export interface AttemptResultView {
  readonly attemptId: string;
  /** The paper the attempt was taken on, so the result page can offer a retake. */
  readonly testId: string | null;
  readonly testTitle: string | null;
  readonly status: AttemptStatus;
  readonly submitSource: string | null;
  readonly submittedAt: string | null;
  readonly score: string;
  readonly correctCount: number;
  readonly wrongCount: number;
  readonly unattemptedCount: number;
  readonly attemptedCount: number;
  readonly totalQuestions: number;
  readonly totalMarks: string;
  readonly accuracy: string;
  readonly review: readonly ReviewQuestionView[];
}

/**
 * The submit response: the result's summary without the review. A submit is not a place the
 * answer key leaves the server — `GET /v1/attempts/:id/result` is the only one (decision 0081).
 */
export interface AttemptSubmitView {
  readonly attemptId: string;
  readonly status: AttemptStatus;
  readonly submitSource: string | null;
  readonly submittedAt: string | null;
  readonly score: string;
  readonly correctCount: number;
  readonly wrongCount: number;
  readonly unattemptedCount: number;
  readonly attemptedCount: number;
  readonly totalQuestions: number;
  readonly totalMarks: string;
  readonly accuracy: string;
}

export interface AttemptSweepResult {
  readonly finalized: number;
  readonly skipped: number;
  readonly failed: number;
}

interface LockedEnrollmentRow {
  readonly id: string;
  readonly user_id: string;
  readonly test_id: string;
  readonly test_version_id: string;
  readonly status: string;
}

interface LockedAttemptRow {
  readonly id: string;
  readonly enrollment_id: string;
  readonly user_id: string;
  readonly test_version_id: string;
  readonly status: string;
  readonly started_at: Date;
  readonly deadline_at: Date;
  readonly submitted_at: Date | null;
  readonly submit_source: string | null;
}

interface CreatedAttemptRow {
  readonly id: string;
  readonly status: string;
  readonly started_at: Date;
  readonly deadline_at: Date;
  readonly server_now: Date;
}

interface PaperOptionRow {
  readonly id: string;
  readonly position: number;
  readonly optionHtml: string;
  readonly latex: string | null;
  readonly isCorrect: boolean;
}

interface PaperRow {
  readonly position: number;
  readonly questionId: string;
  readonly questionType: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly marks: Prisma.Decimal;
  readonly negativeMarks: Prisma.Decimal;
  readonly options: readonly PaperOptionRow[];
}

/** The A1 trigger makes `started_at` the database's now(); that value is never sent. */
function attemptAlreadyStarted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002') {
    return true;
  }
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (meta?.code === '23505') {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return message.includes('23505') || message.includes('attempts_enrollment_key');
}

/** Formats a decimal at the column's scale, so `2` reads as `2.00` and `1.5` as `1.50`. */
function formatDecimal(value: { toString(): string }, decimals: number): string {
  const text = value.toString();
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
  return `${negative ? '-' : ''}${whole}${decimals > 0 ? `.${padded}` : ''}`;
}

function scoringQuestions(paper: readonly PaperRow[]): ScoringQuestion[] {
  return paper.map((question) => ({
    id: question.questionId,
    questionType: question.questionType,
    marks: question.marks.toString(),
    negativeMarks: question.negativeMarks.toString(),
    optionIds: question.options.map((option) => option.id),
    correctOptionId: question.options.find((option) => option.isCorrect)?.id ?? null,
  }));
}

/**
 * The attempt engine's API side: starting a paper, its state, one submit and one result.
 *
 * Every method is self-only and every route resolves "another student's row" to 404, never 403.
 * The database owns the clock: `started_at` comes from the A1 trigger and `deadline_at` is
 * computed from the same transaction timestamp, so `deadline_at - started_at` is exactly the
 * version's duration. The submission window closes at `deadline_at + grace`, where the grace is
 * the `attempt_submit_grace_seconds` setting read inside the transaction.
 *
 * Lock order everywhere: the attempt row, then the enrollment row, then answers, then the status,
 * then the result. Every finalisation — by submit, by a lazy read, and later by the sweeper —
 * goes through `finalizeLocked`, so two callers produce exactly one result.
 */
@Injectable()
export class AttemptsService {
  private readonly logger = new Logger('AttemptsSweeper');

  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async start(
    actor: AuthenticatedUser,
    enrollmentId: string,
    meta: RequestMetadata = {},
  ): Promise<AttemptStartView> {
    return this.prisma.$transaction(async (tx) => {
      const enrollment = await this.lockEnrollmentForActor(tx, actor, enrollmentId);
      if (enrollment.status !== 'OPEN') {
        throw new ConflictException({
          code: 'enrollment_not_open',
          message: 'That enrollment is not open for an attempt',
        });
      }

      const version = await tx.testVersion.findUnique({
        where: { id: enrollment.test_version_id },
        select: { id: true, durationMinutes: true, publishedAt: true },
      });
      if (version === null || version.publishedAt === null) {
        throw new ConflictException({
          code: 'paper_not_frozen',
          message: 'That paper is not published, so it cannot be started',
        });
      }

      // A5b: a paper is started only when every placement is pinned to a question version.
      // Publishing writes those pins; this refuses a row that somehow reached a published
      // version without one, rather than delivering content that could move under the attempt.
      const unpinned = await tx.testQuestion.count({
        where: { testVersionId: enrollment.test_version_id, questionVersionId: null },
      });
      if (unpinned > 0) {
        throw new ConflictException({
          code: 'paper_not_pinned',
          message: 'That paper is not complete, so it cannot be started',
        });
      }

      const created = await this.insertAttempt(tx, enrollment, actor, version.id, version.durationMinutes);

      const paper = await this.loadPaper(tx, enrollment.test_version_id);

      await writeIdentityAudit(tx, {
        action: 'ATTEMPT_STARTED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'attempt',
        entityId: created.id,
        metadata: { enrollmentId: enrollment.id, testVersionId: version.id },
        ip: meta.ip ?? null,
      });

      const now = created.server_now;
      const stateAttempt: LockedAttemptRow = {
        id: created.id,
        enrollment_id: enrollment.id,
        user_id: actor.id,
        test_version_id: version.id,
        status: created.status,
        started_at: created.started_at,
        deadline_at: created.deadline_at,
        submitted_at: null,
        submit_source: null,
      };

      return {
        ...this.stateView(stateAttempt, now),
        questions: paper.map((question) => paperQuestion(question.position, question.questionId, question, question.options)),
      };
    });
  }

  async state(actor: AuthenticatedUser, attemptId: string): Promise<AttemptStateView> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.lockAttempt(tx, actor, attemptId);
      const current = (await this.finalizeLocked(tx, attempt, 'LAZY')) ?? attempt;
      const now = await this.dbNow(tx);
      return this.stateView(current, now);
    });
  }

  /**
   * The attempt an enrollment has, for the entry page: `{ attempt: null }` before a start, the
   * state afterwards. Deliberately server-rendered state and never the paper — a reload has to
   * know an attempt exists to say it cannot be resumed.
   */
  async attemptForEnrollment(
    actor: AuthenticatedUser,
    enrollmentId: string,
  ): Promise<{ readonly attempt: AttemptStateView | null }> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { userId: true },
    });
    if (enrollment === null || enrollment.userId !== actor.id) {
      throw new NotFoundException('Unknown enrollment');
    }

    const attempt = await this.prisma.attempt.findUnique({ where: { enrollmentId }, select: { id: true } });
    if (attempt === null) {
      return { attempt: null };
    }

    return { attempt: await this.state(actor, attempt.id) };
  }

  async submit(
    actor: AuthenticatedUser,
    attemptId: string,
    answers: readonly SubmitAnswerInput[],
    meta: RequestMetadata = {},
  ): Promise<AttemptSubmitView> {
    const outcome = await this.runScoringTransaction(async (tx) => {
      const attempt = await this.lockAttempt(tx, actor, attemptId);

      if (attempt.status !== 'IN_PROGRESS') {
        return { kind: 'replayed' as const, view: await this.submitView(tx, attempt) };
      }

      await this.lockEnrollmentRow(tx, attempt.enrollment_id);

      const now = await this.dbNow(tx);
      const grace = await this.graceSeconds(tx);

      if (now.getTime() > attempt.deadline_at.getTime() + grace * 1000) {
        await this.finalizeLocked(tx, attempt, 'LAZY');
        return { kind: 'expired' as const };
      }

      const paper = await this.loadPaper(tx, attempt.test_version_id);
      const scored = scoreAttempt(scoringQuestions(paper), answers);

      // Answers first, then the end: the A1 guard refuses an answer once the attempt has ended.
      await tx.attemptAnswer.createMany({
        data: answers.map((answer) => ({
          attemptId,
          questionId: answer.questionId,
          chosenOptionId: answer.chosenOptionId,
        })),
      });

      const ended = await tx.$executeRaw`
        UPDATE "attempts"
        SET "status" = 'SUBMITTED', "submitted_at" = now(), "submit_source" = 'STUDENT'
        WHERE "id" = ${attemptId}::uuid AND "status" = 'IN_PROGRESS'
      `;
      if (ended !== 1) {
        throw new ConflictException({
          code: 'attempt_already_ended',
          message: 'That attempt was ended at the same moment; read its result',
        });
      }

      await tx.result.create({ data: { attemptId, ...scored } });

      await tx.enrollment.updateMany({
        where: { id: attempt.enrollment_id, status: 'OPEN' },
        data: { status: 'COMPLETED', completedAt: now },
      });

      await writeIdentityAudit(tx, {
        action: 'ATTEMPT_SUBMITTED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'attempt',
        entityId: attemptId,
        metadata: { answers: answers.length, correct: scored.correctCount, wrong: scored.wrongCount },
        ip: meta.ip ?? null,
      });

      const ended_attempt = await this.reloadAttempt(tx, attemptId);
      return { kind: 'submitted' as const, view: await this.submitView(tx, ended_attempt) };
    });

    if (outcome.kind === 'expired') {
      throw new ConflictException({
        code: 'attempt_expired',
        message: 'The deadline has passed, so this attempt was ended and its answers were not scored',
      });
    }

    return outcome.view;
  }

  async result(actor: AuthenticatedUser, attemptId: string): Promise<AttemptResultView> {
    return this.prisma.$transaction(async (tx) => {
      const attempt = await this.lockAttempt(tx, actor, attemptId);
      const current = (await this.finalizeLocked(tx, attempt, 'LAZY')) ?? attempt;

      if (current.status === 'IN_PROGRESS') {
        throw new ConflictException({
          code: 'attempt_in_progress',
          message: 'This attempt has not ended yet',
        });
      }

      return this.resultView(tx, current);
    });
  }

  /**
   * The sweeper's entry point: claim up to `batchSize` expired attempts and finalise each one
   * through the same `finalizeExpiredAttempt` the lazy reads use, in its own transaction, so one
   * failing attempt never rolls back or blocks the others.
   *
   * The claim is a short transaction: it reads the grace setting inside it, selects ids with
   * `FOR UPDATE SKIP LOCKED` (so two sweepers never wait on each other) and releases the locks
   * by committing before any finalisation. Finalising re-checks the clock, the status and the
   * lock, so a submit or a lazy read that won the race makes this a `skipped`, not a second
   * result. Returns counts only; the log names attempts and counts, never an answer.
   */
  async expireExpiredAttempts(batchSize: number): Promise<AttemptSweepResult> {
    const ids = await this.prisma.$transaction(async (tx) => {
      const grace = await this.graceSeconds(tx);
      return tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "attempts"
        WHERE "status" = 'IN_PROGRESS'
          AND "deadline_at" + (${grace}::int * interval '1 second') < now()
        ORDER BY "deadline_at" ASC
        LIMIT ${batchSize}::int
        FOR UPDATE SKIP LOCKED
      `;
    });

    let finalized = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of ids) {
      try {
        const done = await this.finalizeExpiredAttempt(row.id, 'SWEEPER');
        if (done) {
          finalized += 1;
          this.logger.log(`attempt ${row.id} auto-submitted by the sweeper`);
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `attempt ${row.id} could not be swept (${error instanceof Error ? error.name : 'UnknownError'})`,
        );
      }
    }

    this.logger.log(
      `attempt sweep: ${String(finalized)} finalized, ${String(skipped)} skipped, ${String(failed)} failed`,
    );

    return { finalized, skipped, failed };
  }

  /**
   * Exported for A3b's sweeper: it finalises one expired attempt on its own, under the same row
   * lock and through the same code as the lazy paths. `SWEEPER` asks for `SKIP LOCKED`, so two
   * workers never wait on each other; the status guard makes the loser a no-op either way.
   */
  async finalizeExpiredAttempt(attemptId: string, source: 'LAZY' | 'SWEEPER' = 'LAZY'): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const locked =
        source === 'SWEEPER'
          ? await tx.$queryRaw<LockedAttemptRow[]>`
              SELECT "id", "enrollment_id", "user_id", "test_version_id", "status",
                     "started_at", "deadline_at", "submitted_at", "submit_source"
              FROM "attempts" WHERE "id" = ${attemptId}::uuid FOR UPDATE SKIP LOCKED
            `
          : await tx.$queryRaw<LockedAttemptRow[]>`
              SELECT "id", "enrollment_id", "user_id", "test_version_id", "status",
                     "started_at", "deadline_at", "submitted_at", "submit_source"
              FROM "attempts" WHERE "id" = ${attemptId}::uuid FOR UPDATE
            `;

      const attempt = locked[0];
      if (attempt === undefined) {
        return false;
      }

      const finalized = await this.finalizeLocked(tx, attempt, source);
      return finalized !== null;
    });
  }

  // -------------------------------------------------------------------------
  // Finalisation: one implementation, three callers
  // -------------------------------------------------------------------------

  /**
   * Called with the attempt row already locked. An attempt past its deadline plus the grace is
   * ended once, with an empty answer set — answers are saved only on submit — and the enrollment
   * moves to EXPIRED. Returns the ended row, or null when nothing was due.
   */
  private async finalizeLocked(
    tx: Prisma.TransactionClient,
    attempt: LockedAttemptRow,
    source: SubmitSource,
  ): Promise<LockedAttemptRow | null> {
    if (attempt.status !== 'IN_PROGRESS') {
      return null;
    }

    const now = await this.dbNow(tx);
    const grace = await this.graceSeconds(tx);
    if (now.getTime() <= attempt.deadline_at.getTime() + grace * 1000) {
      return null;
    }

    await this.lockEnrollmentRow(tx, attempt.enrollment_id);

    const updated = await tx.$executeRaw`
      UPDATE "attempts"
      SET "status" = 'AUTO_SUBMITTED', "submitted_at" = now(), "submit_source" = ${source}
      WHERE "id" = ${attempt.id}::uuid AND "status" = 'IN_PROGRESS'
    `;
    if (updated !== 1) {
      return null;
    }

    const paper = await this.loadPaper(tx, attempt.test_version_id);
    const scored = scoreAttempt(scoringQuestions(paper), []);
    await tx.result.create({ data: { attemptId: attempt.id, ...scored } });

    await tx.enrollment.updateMany({
      where: { id: attempt.enrollment_id, status: 'OPEN' },
      data: { status: 'EXPIRED', completedAt: now },
    });

    await writeIdentityAudit(tx, {
      action: 'ATTEMPT_AUTO_SUBMITTED',
      actorUserId: attempt.user_id,
      actorRole: 'USER',
      entityType: 'attempt',
      entityId: attempt.id,
      metadata: { source, reason: 'deadline' },
      ip: null,
    });

    return { ...attempt, status: 'AUTO_SUBMITTED', submitted_at: now, submit_source: source };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The paper an attempt is given, scored on and reviewed from. A5b: each placement names the
   * question version the paper froze at publish, and that is what is read — the question's
   * current version moves when an editor edits the bank and must not follow. A row with no pin
   * (a draft, or a paper written before the pin existed) still reads the current version.
   */
  private async loadPaper(tx: Prisma.TransactionClient, testVersionId: string): Promise<PaperRow[]> {
    const rows = await tx.testQuestion.findMany({
      where: { testVersionId },
      orderBy: { position: 'asc' },
      select: {
        position: true,
        questionVersionId: true,
        question: {
          select: {
            id: true,
            currentVersion: true,
            versions: {
              select: {
                id: true,
                version: true,
                questionType: true,
                contentHtml: true,
                explanationHtml: true,
                latex: true,
                marks: true,
                negativeMarks: true,
                options: {
                  orderBy: { position: 'asc' },
                  select: {
                    id: true,
                    position: true,
                    optionHtml: true,
                    latex: true,
                    isCorrect: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    return rows.map((row) => {
      const version =
        row.questionVersionId === null
          ? row.question.versions.find((entry) => entry.version === row.question.currentVersion)
          : row.question.versions.find((entry) => entry.id === row.questionVersionId);

      if (version === undefined) {
        throw new ConflictException(
          row.questionVersionId === null
            ? 'A question on this paper has no current version'
            : 'A question on this paper has no pinned version',
        );
      }

      return {
        position: row.position,
        questionId: row.question.id,
        questionType: version.questionType,
        contentHtml: version.contentHtml,
        explanationHtml: version.explanationHtml,
        latex: version.latex,
        marks: version.marks,
        negativeMarks: version.negativeMarks,
        options: version.options,
      };
    });
  }

  /**
   * The submit response's shape: the summary the result page shows, and no review. Reading the
   * result row directly means the paper is never loaded for a submit, so the key cannot reach a
   * submit response even by accident (decision 0081).
   */
  private async submitView(tx: Prisma.TransactionClient, attempt: LockedAttemptRow): Promise<AttemptSubmitView> {
    const result = await tx.result.findUnique({ where: { attemptId: attempt.id } });
    if (result === null) {
      throw new ConflictException({
        code: 'attempt_in_progress',
        message: 'This attempt has not ended yet',
      });
    }

    return {
      attemptId: attempt.id,
      status: attempt.status as AttemptStatus,
      submitSource: attempt.submit_source,
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      score: formatDecimal(result.score, 2),
      correctCount: result.correctCount,
      wrongCount: result.wrongCount,
      unattemptedCount: result.unattemptedCount,
      attemptedCount: result.attemptedCount,
      totalQuestions: result.totalQuestions,
      totalMarks: formatDecimal(result.totalMarks, 2),
      accuracy: formatDecimal(result.accuracy, 4),
    };
  }

  private async resultView(tx: Prisma.TransactionClient, attempt: LockedAttemptRow): Promise<AttemptResultView> {
    const result = await tx.result.findUnique({ where: { attemptId: attempt.id } });
    if (result === null) {
      throw new ConflictException({
        code: 'attempt_in_progress',
        message: 'This attempt has not ended yet',
      });
    }

    const answers = await tx.attemptAnswer.findMany({
      where: { attemptId: attempt.id },
      select: { questionId: true, chosenOptionId: true },
    });
    const chosen = new Map(answers.map((answer) => [answer.questionId, answer.chosenOptionId]));

    const paper = await this.loadPaper(tx, attempt.test_version_id);

    // The paper the attempt was taken on, for the result page's retake link. The review's
    // question list and marks are the attempt's own frozen version; a later edit to a question
    // opens a new version and never changes this paper's list.
    const enrollment = await tx.enrollment.findUnique({
      where: { id: attempt.enrollment_id },
      select: { testId: true, test: { select: { title: true } } },
    });

    return {
      attemptId: attempt.id,
      testId: enrollment?.testId ?? null,
      testTitle: enrollment?.test.title ?? null,
      status: attempt.status as AttemptStatus,
      submitSource: attempt.submit_source,
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      score: formatDecimal(result.score, 2),
      correctCount: result.correctCount,
      wrongCount: result.wrongCount,
      unattemptedCount: result.unattemptedCount,
      attemptedCount: result.attemptedCount,
      totalQuestions: result.totalQuestions,
      totalMarks: formatDecimal(result.totalMarks, 2),
      accuracy: formatDecimal(result.accuracy, 4),
      review: paper.map((question) =>
        reviewQuestion(
          question.position,
          question.questionId,
          question,
          question.options,
          (optionId) => chosen.get(question.questionId) === optionId,
        ),
      ),
    };
  }

  private stateView(attempt: LockedAttemptRow, now: Date): AttemptStateView {
    const remainingMs = attempt.deadline_at.getTime() - now.getTime();
    return {
      attemptId: attempt.id,
      status: attempt.status as AttemptStatus,
      startedAt: attempt.started_at.toISOString(),
      deadlineAt: attempt.deadline_at.toISOString(),
      serverNow: now.toISOString(),
      remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)),
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      submitSource: attempt.submit_source,
    };
  }

  // -------------------------------------------------------------------------
  // Rows and clock
  // -------------------------------------------------------------------------

  /**
   * The one INSERT. `deadline_at` is computed from the same transaction timestamp the A1 trigger
   * writes into `started_at`, so the difference is exactly the version's duration.
   */
  private async insertAttempt(
    tx: Prisma.TransactionClient,
    enrollment: LockedEnrollmentRow,
    actor: AuthenticatedUser,
    testVersionId: string,
    durationMinutes: number,
  ): Promise<CreatedAttemptRow> {
    try {
      const rows = await tx.$queryRaw<CreatedAttemptRow[]>`
        INSERT INTO "attempts" ("enrollment_id", "user_id", "test_version_id", "deadline_at")
        VALUES (
          ${enrollment.id}::uuid,
          ${actor.id}::uuid,
          ${testVersionId}::uuid,
          now() + (${durationMinutes}::int * interval '1 minute')
        )
        RETURNING "id", "status", "started_at", "deadline_at", now() AS "server_now"
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new ConflictException('The attempt was not created');
      }
      return row;
    } catch (error) {
      if (attemptAlreadyStarted(error)) {
        throw new ConflictException({
          code: 'attempt_already_started',
          message: 'This enrollment has already been started; a paper is delivered once',
        });
      }
      throw error;
    }
  }

  private async reloadAttempt(tx: Prisma.TransactionClient, attemptId: string): Promise<LockedAttemptRow> {
    const rows = await tx.$queryRaw<LockedAttemptRow[]>`
      SELECT "id", "enrollment_id", "user_id", "test_version_id", "status",
             "started_at", "deadline_at", "submitted_at", "submit_source"
      FROM "attempts" WHERE "id" = ${attemptId}::uuid
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException('Unknown attempt');
    }
    return row;
  }

  private async lockAttempt(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    attemptId: string,
  ): Promise<LockedAttemptRow> {
    const rows = await tx.$queryRaw<LockedAttemptRow[]>`
      SELECT "id", "enrollment_id", "user_id", "test_version_id", "status",
             "started_at", "deadline_at", "submitted_at", "submit_source"
      FROM "attempts" WHERE "id" = ${attemptId}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined || row.user_id !== actor.id) {
      throw new NotFoundException('Unknown attempt');
    }
    return row;
  }

  private async lockEnrollmentForActor(
    tx: Prisma.TransactionClient,
    actor: AuthenticatedUser,
    enrollmentId: string,
  ): Promise<LockedEnrollmentRow> {
    const row = await this.lockEnrollmentRow(tx, enrollmentId);
    if (row === null || row.user_id !== actor.id) {
      throw new NotFoundException('Unknown enrollment');
    }
    return row;
  }

  private async lockEnrollmentRow(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
  ): Promise<LockedEnrollmentRow | null> {
    const rows = await tx.$queryRaw<LockedEnrollmentRow[]>`
      SELECT "id", "user_id", "test_id", "test_version_id", "status"
      FROM "enrollments" WHERE "id" = ${enrollmentId}::uuid FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  private async graceSeconds(tx: Prisma.TransactionClient): Promise<number> {
    const setting = await tx.setting.findUnique({
      where: { key: GRACE_SETTING_KEY },
      select: { valueInt: true },
    });
    return setting?.valueInt ?? DEFAULT_GRACE_SECONDS;
  }

  /** The database's own clock. No timestamp from the client is read anywhere in this service. */
  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS "now"`;
    const row = rows[0];
    if (row === undefined) {
      throw new ConflictException('The database clock is unavailable');
    }
    return row.now;
  }

  /**
   * Runs a transaction and maps the scoring function's refusals to 400s with the same stable
   * codes. The scoring function names ids only, never the key.
   */
  private async runScoringTransaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(run);
    } catch (error) {
      if (error instanceof ScoringError) {
        throw new BadRequestException({ code: error.code.toLowerCase(), message: error.message });
      }
      throw error;
    }
  }
}
