import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import type { RequestMetadata } from '../auth/request';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { mediaIdsIn, plainText, sanitizeStoredContent } from './sanitize';
import type { QuestionInput, QuestionListQuery } from './validation';

const PAGE_SIZE = 20;

export interface OptionView {
  readonly position: number;
  readonly optionHtml: string;
  readonly isCorrect: boolean;
  readonly imageId: string | null;
}

export interface VersionView {
  readonly version: number;
  readonly questionType: string;
  readonly language: string;
  readonly difficulty: string;
  readonly contentHtml: string;
  readonly explanationHtml: string | null;
  readonly latex: string | null;
  readonly numericalAnswer: string | null;
  readonly marks: string;
  readonly negativeMarks: string;
  readonly publishedAt: string | null;
}

export interface QuestionView {
  readonly id: string;
  readonly examId: string;
  readonly subjectId: string;
  readonly topicId: string | null;
  readonly createdBy: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly updatedAt: string;
  readonly version: VersionView;
  readonly options: readonly OptionView[];
}

export interface QuestionListResult {
  readonly items: readonly QuestionView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

const VERSION_SELECT = {
  version: true,
  questionType: true,
  language: true,
  difficulty: true,
  contentHtml: true,
  explanationHtml: true,
  latex: true,
  numericalAnswer: true,
  marks: true,
  negativeMarks: true,
  publishedAt: true,
} satisfies Prisma.QuestionVersionSelect;

const QUESTION_SELECT = {
  id: true,
  examId: true,
  subjectId: true,
  topicId: true,
  createdBy: true,
  status: true,
  currentVersion: true,
  updatedAt: true,
} satisfies Prisma.QuestionSelect;

type QuestionRow = Prisma.QuestionGetPayload<{ select: typeof QUESTION_SELECT }>;

type VersionRow = Prisma.QuestionVersionGetPayload<{
  select: typeof VERSION_SELECT & { id: true; options: true };
}>;

function toView(question: QuestionRow, version: VersionRow): QuestionView {
  return {
    id: question.id,
    examId: question.examId,
    subjectId: question.subjectId,
    topicId: question.topicId,
    createdBy: question.createdBy,
    status: question.status,
    currentVersion: question.currentVersion,
    updatedAt: question.updatedAt.toISOString(),
    version: {
      version: version.version,
      questionType: version.questionType,
      language: version.language,
      difficulty: version.difficulty,
      contentHtml: sanitizeStoredContent(version.contentHtml),
      explanationHtml: version.explanationHtml === null ? null : sanitizeStoredContent(version.explanationHtml),
      latex: version.latex,
      numericalAnswer: version.numericalAnswer,
      marks: version.marks.toString(),
      negativeMarks: version.negativeMarks.toString(),
      publishedAt: version.publishedAt?.toISOString() ?? null,
    },
    options: version.options.map((option) => ({
      position: option.position,
      optionHtml: sanitizeStoredContent(option.optionHtml),
      isCorrect: option.isCorrect,
      imageId: option.imageId,
    })),
  };
}

/**
 * Question authoring.
 *
 * Ownership follows the catalog's rule: an editor works on what they created, and an
 * administrator works on everything. A foreign id is reported as missing rather than
 * forbidden, so the route cannot be used to discover which questions exist.
 *
 * Publishing freezes a version (the database refuses to change it afterwards), and any
 * later edit creates a new draft version, so a published paper never changes under a
 * student who already sat it.
 */
@Injectable()
export class QuestionsService {
  constructor(@Inject(DATABASE_PROBE) private readonly database: DatabaseService) {}

  private get prisma() {
    return this.database.prisma;
  }

  async list(actor: AuthenticatedUser, query: QuestionListQuery): Promise<QuestionListResult> {
    const where: Prisma.QuestionWhereInput = {};

    // An editor sees their own work; an administrator sees everything.
    if (actor.roleCode !== 'ADMIN') {
      where.createdBy = actor.id;
    } else if (query.createdBy !== undefined) {
      where.createdBy = query.createdBy;
    }

    if (query.examId !== undefined) {
      where.examId = query.examId;
    }
    if (query.subjectId !== undefined) {
      where.subjectId = query.subjectId;
    }
    if (query.topicId !== undefined) {
      where.topicId = query.topicId;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }

    // Filters that live on the version apply to one of the question's versions.
    const versionFilter: Prisma.QuestionVersionWhereInput = {};
    if (query.difficulty !== undefined) {
      versionFilter.difficulty = query.difficulty;
    }
    if (query.language !== undefined) {
      versionFilter.language = query.language;
    }
    if (query.search !== undefined) {
      versionFilter.OR = [
        { contentHtml: { contains: query.search, mode: 'insensitive' } },
        { latex: { contains: query.search } },
      ];
    }
    if (Object.keys(versionFilter).length > 0) {
      where.versions = { some: versionFilter };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.question.count({ where }),
      this.prisma.question.findMany({
        where,
        select: QUESTION_SELECT,
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);

    const items = await Promise.all(rows.map(async (row) => toView(row, await this.versionFor(row))));

    return {
      items,
      total,
      page: query.page,
      pageSize: PAGE_SIZE,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  }

  async get(actor: AuthenticatedUser, id: string): Promise<QuestionView> {
    const question = await this.loadOwned(actor, id);
    return toView(question, await this.versionFor(question));
  }

  async create(actor: AuthenticatedUser, input: QuestionInput, meta: RequestMetadata = {}): Promise<QuestionView> {
    await this.assertCatalogAlignment(input.examId, input.subjectId, input.topicId);
    await this.assertMediaOwnership(actor, input);

    const created = await this.prisma.$transaction(async (tx) => {
      const question = await tx.question.create({
        data: {
          examId: input.examId,
          subjectId: input.subjectId,
          topicId: input.topicId,
          createdBy: actor.id,
          status: 'DRAFT',
          currentVersion: 1,
        },
        select: { id: true },
      });

      await tx.questionVersion.create({
        data: {
          questionId: question.id,
          version: 1,
          questionType: input.questionType,
          language: input.language,
          difficulty: input.difficulty,
          contentHtml: input.contentHtml,
          explanationHtml: input.explanationHtml,
          latex: input.latex,
          numericalAnswer: input.numericalAnswer,
          marks: input.marks,
          negativeMarks: input.negativeMarks,
          createdBy: actor.id,
          options: {
            create: input.options.map((option, index) => ({
              position: index + 1,
              optionHtml: option.optionHtml,
              isCorrect: option.isCorrect,
              imageId: option.imageId,
            })),
          },
        },
      });

      await writeIdentityAudit(tx, {
        action: 'QUESTION_CREATED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'question',
        entityId: question.id,
        metadata: { examId: input.examId, type: input.questionType },
        ip: meta.ip ?? null,
      });

      return question.id;
    });

    return this.get(actor, created);
  }

  async saveDraft(
    actor: AuthenticatedUser,
    id: string,
    input: QuestionInput,
    meta: RequestMetadata = {},
  ): Promise<QuestionView> {
    const question = await this.loadOwned(actor, id);
    const current = await this.versionFor(question);

    if (question.examId !== input.examId || question.subjectId !== input.subjectId) {
      // Moving a question between exams would silently change who may edit it, so the
      // catalog rows are fixed at creation and a move is its own operation later.
      throw new BadRequestException('A question cannot be moved to another exam or subject');
    }
    await this.assertCatalogAlignment(input.examId, input.subjectId, input.topicId);
    await this.assertMediaOwnership(actor, input);

    const targetVersion = current.publishedAt === null ? current.version : current.version + 1;

    await this.prisma.$transaction(async (tx) => {
      if (targetVersion === current.version) {
        await tx.questionVersion.update({
          where: { id: current.id },
          data: {
            questionType: input.questionType,
            language: input.language,
            difficulty: input.difficulty,
            contentHtml: input.contentHtml,
            explanationHtml: input.explanationHtml,
            latex: input.latex,
            numericalAnswer: input.numericalAnswer,
            marks: input.marks,
            negativeMarks: input.negativeMarks,
          },
        });

        // The answer key is rewritten with the draft, inside the same transaction.
        await tx.questionOption.deleteMany({ where: { versionId: current.id } });
        if (input.options.length > 0) {
          await tx.questionOption.createMany({
            data: input.options.map((option, index) => ({
              versionId: current.id,
              position: index + 1,
              optionHtml: option.optionHtml,
              isCorrect: option.isCorrect,
              imageId: option.imageId,
            })),
          });
        }
      } else {
        const next = await tx.questionVersion.create({
          data: {
            questionId: question.id,
            version: targetVersion,
            questionType: input.questionType,
            language: input.language,
            difficulty: input.difficulty,
            contentHtml: input.contentHtml,
            explanationHtml: input.explanationHtml,
            latex: input.latex,
            numericalAnswer: input.numericalAnswer,
            marks: input.marks,
            negativeMarks: input.negativeMarks,
            createdBy: actor.id,
          },
          select: { id: true },
        });

        if (input.options.length > 0) {
          await tx.questionOption.createMany({
            data: input.options.map((option, index) => ({
              versionId: next.id,
              position: index + 1,
              optionHtml: option.optionHtml,
              isCorrect: option.isCorrect,
              imageId: option.imageId,
            })),
          });
        }
      }

      await tx.question.update({
        where: { id: question.id },
        data: { currentVersion: targetVersion, status: 'DRAFT' },
      });

      await writeIdentityAudit(tx, {
        action: 'QUESTION_UPDATED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'question',
        entityId: question.id,
        metadata: { version: targetVersion },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  async publish(actor: AuthenticatedUser, id: string, meta: RequestMetadata = {}): Promise<QuestionView> {
    const question = await this.loadOwned(actor, id);
    const current = await this.versionFor(question);

    if (current.publishedAt !== null) {
      throw new BadRequestException('This version is already published');
    }

    if (current.questionType === 'MCQ') {
      if (current.options.length < 2 || current.options.length > 6) {
        throw new BadRequestException('An MCQ needs between 2 and 6 options');
      }
      if (current.options.filter((option) => option.isCorrect).length !== 1) {
        throw new BadRequestException('An MCQ needs exactly one correct option');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.questionVersion.update({ where: { id: current.id }, data: { publishedAt: new Date() } });
      await tx.question.update({ where: { id: question.id }, data: { status: 'PUBLISHED' } });

      await writeIdentityAudit(tx, {
        action: 'QUESTION_PUBLISHED',
        actorUserId: actor.id,
        actorRole: actor.roleCode,
        entityType: 'question',
        entityId: question.id,
        metadata: { version: current.version },
        ip: meta.ip ?? null,
      });
    });

    return this.get(actor, id);
  }

  /** The export an editor with manage-questions may take, and which is itself audited. */
  async exportCsv(actor: AuthenticatedUser, query: QuestionListQuery, meta: RequestMetadata = {}): Promise<string> {
    const page = await this.list(actor, { ...query, page: 1 });
    const rows: string[] = [
      'question_id,exam_id,subject_id,topic_id,type,language,difficulty,status,marks,negative_marks,text,correct_answer',
    ];

    for (const item of page.items) {
      const correct =
        item.version.questionType === 'NUMERICAL'
          ? item.version.numericalAnswer ?? ''
          : item.options
              .filter((option) => option.isCorrect)
              .map((option) => plainText(option.optionHtml))
              .join(' ');

      rows.push(
        [
          item.id,
          item.examId,
          item.subjectId,
          item.topicId ?? '',
          item.version.questionType,
          item.version.language,
          item.version.difficulty,
          item.status,
          item.version.marks,
          item.version.negativeMarks,
          csvCell(plainText(item.version.contentHtml)),
          csvCell(correct),
        ].join(','),
      );
    }

    await writeIdentityAudit(this.prisma, {
      action: 'QUESTIONS_EXPORTED',
      actorUserId: actor.id,
      actorRole: actor.roleCode,
      entityType: 'question',
      entityId: null,
      metadata: { count: page.items.length },
      ip: meta.ip ?? null,
    });

    return rows.join('\n');
  }

  private async loadOwned(actor: AuthenticatedUser, id: string): Promise<QuestionRow> {
    const question = await this.prisma.question.findUnique({ where: { id }, select: QUESTION_SELECT });

    if (!question || (actor.roleCode !== 'ADMIN' && question.createdBy !== actor.id)) {
      throw new NotFoundException('Unknown question');
    }

    return question;
  }

  private async versionFor(question: QuestionRow): Promise<VersionRow> {
    const version = await this.prisma.questionVersion.findUnique({
      where: { questionId_version: { questionId: question.id, version: question.currentVersion } },
      select: { ...VERSION_SELECT, id: true, options: { orderBy: { position: 'asc' } } },
    });

    if (!version) {
      throw new NotFoundException('The question has no current version');
    }

    return version;
  }

  private async assertCatalogAlignment(examId: string, subjectId: string, topicId: string | null): Promise<void> {
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      select: { examId: true },
    });
    if (!subject || subject.examId !== examId) {
      throw new BadRequestException('The subject does not belong to that exam');
    }

    if (topicId !== null) {
      const topic = await this.prisma.topic.findUnique({ where: { id: topicId }, select: { subjectId: true } });
      if (!topic || topic.subjectId !== subjectId) {
        throw new BadRequestException('The topic does not belong to that subject');
      }
    }
  }

  /**
   * Every image a question refers to must exist and be one this editor may use.
   *
   * The id travels in the content, so this runs on save and on every later save: an editor
   * cannot point a question at somebody else's upload, and a made-up id is refused with
   * the same words as a foreign one, so the route cannot be used to probe which ids exist.
   */
  private async assertMediaOwnership(actor: AuthenticatedUser, input: QuestionInput): Promise<void> {
    const ids = new Set<string>(mediaIdsIn(input.contentHtml));
    if (input.explanationHtml !== null) {
      for (const id of mediaIdsIn(input.explanationHtml)) {
        ids.add(id);
      }
    }
    for (const option of input.options) {
      for (const id of mediaIdsIn(option.optionHtml)) {
        ids.add(id);
      }
      if (option.imageId !== null) {
        ids.add(option.imageId);
      }
    }

    if (ids.size === 0) {
      return;
    }

    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, mimeType: true, uploadedBy: true },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));

    for (const id of ids) {
      const asset = byId.get(id);
      const usable =
        asset !== undefined &&
        asset.mimeType === 'image/webp' &&
        (actor.roleCode === 'ADMIN' || asset.uploadedBy === actor.id);

      if (!usable) {
        throw new BadRequestException('An image in this question is not available to you');
      }
    }
  }
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
