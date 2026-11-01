import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Exam, ExamCategory, Subject } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/access';
import { writeIdentityAudit } from '../auth/audit';
import { DatabaseService } from '../infra/database.service';
import { DATABASE_PROBE } from '../infra/tokens';
import { CatalogRevalidationService } from './revalidation.service';
import {
  parseCatalogUpdateBody,
  parseCategoryBody,
  parseExamBody,
  parseSubjectBody,
  parseTopicBody,
  type CatalogUpdateInput,
} from './validation';

export interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly createdBy: string;
}

export interface TopicNode {
  readonly id: string;
  readonly subjectId: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface SubjectNode {
  readonly id: string;
  readonly examId: string;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly topics: readonly TopicNode[];
}

export interface ExamNode {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly createdBy: string;
  readonly subjects: readonly SubjectNode[];
}

export interface CatalogTree {
  readonly categories: readonly CategoryNode[];
  readonly exams: readonly ExamNode[];
}

export interface PublicExam {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly logoKey: string | null;
  readonly sortOrder: number;
  readonly subjectCount: number;
}

export interface PublicCatalog {
  readonly categories: readonly CategoryNode[];
  readonly exams: readonly PublicExam[];
}

type AuditMeta = { readonly ip?: string | undefined };

/** A Prisma unique-constraint violation, recognised without importing the enum. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002';
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2003';
}

/**
 * The catalog.
 *
 * One rule shapes every write: an Administrator may change anything, and an editor
 * may change only what they created. Subjects and topics inherit the ownership of the
 * exam they belong to, so an editor cannot reach into a colleague's exam by creating a
 * subject underneath it.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(DATABASE_PROBE) private readonly database: DatabaseService,
    @Inject(CatalogRevalidationService) private readonly revalidation: CatalogRevalidationService,
  ) {}

  private get prisma() {
    return this.database.prisma;
  }

  async tree(): Promise<CatalogTree> {
    const [categories, exams, subjects, topics] = await Promise.all([
      this.prisma.examCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.exam.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.subject.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.topic.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    ]);

    const topicsBySubject = new Map<string, TopicNode[]>();
    for (const topic of topics) {
      const list = topicsBySubject.get(topic.subjectId) ?? [];
      list.push({
        id: topic.id,
        subjectId: topic.subjectId,
        name: topic.name,
        slug: topic.slug,
        sortOrder: topic.sortOrder,
        isActive: topic.isActive,
      });
      topicsBySubject.set(topic.subjectId, list);
    }

    const subjectsByExam = new Map<string, SubjectNode[]>();
    for (const subject of subjects) {
      const list = subjectsByExam.get(subject.examId) ?? [];
      list.push({
        id: subject.id,
        examId: subject.examId,
        name: subject.name,
        slug: subject.slug,
        sortOrder: subject.sortOrder,
        isActive: subject.isActive,
        topics: topicsBySubject.get(subject.id) ?? [],
      });
      subjectsByExam.set(subject.examId, list);
    }

    return {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        logoKey: category.logoKey,
        parentId: category.parentId,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        createdBy: category.createdBy,
      })),
      exams: exams.map((exam) => ({
        id: exam.id,
        categoryId: exam.categoryId,
        name: exam.name,
        slug: exam.slug,
        description: exam.description,
        logoKey: exam.logoKey,
        sortOrder: exam.sortOrder,
        isActive: exam.isActive,
        createdBy: exam.createdBy,
        subjects: subjectsByExam.get(exam.id) ?? [],
      })),
    };
  }

  /** What the public pages may show: active rows only, with inactive children dropped. */
  async publicCatalog(): Promise<PublicCatalog> {
    const [categories, exams, subjectCounts] = await Promise.all([
      this.prisma.examCategory.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.exam.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.subject.groupBy({ by: ['examId'], where: { isActive: true }, _count: { _all: true } }),
    ]);

    const activeCategoryIds = new Set(categories.map((category) => category.id));

    return {
      // A subcategory is only public when its parent is too.
      categories: categories
        .filter((category) => category.parentId === null || activeCategoryIds.has(category.parentId))
        .map((category) => ({
          id: category.id,
          name: category.name,
          slug: category.slug,
          description: category.description,
          logoKey: category.logoKey,
          parentId: category.parentId,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
          createdBy: category.createdBy,
        })),
      exams: exams
        .filter((exam) => activeCategoryIds.has(exam.categoryId))
        .map((exam) => ({
          id: exam.id,
          categoryId: exam.categoryId,
          name: exam.name,
          slug: exam.slug,
          description: exam.description,
          logoKey: exam.logoKey,
          sortOrder: exam.sortOrder,
          subjectCount: subjectCounts.find((row) => row.examId === exam.id)?._count._all ?? 0,
        })),
    };
  }

  async createCategory(actor: AuthenticatedUser, body: unknown, meta: AuditMeta = {}): Promise<CategoryNode> {
    const input = parseCategoryBody(body);

    if (input.parentId !== null) {
      const parent = await this.prisma.examCategory.findUnique({
        where: { id: input.parentId },
        select: { id: true, parentId: true },
      });
      if (!parent) {
        throw new NotFoundException('Unknown parent category');
      }
      if (parent.parentId !== null) {
        throw new BadRequestException('Categories are two levels deep: a subcategory cannot have children');
      }
    }

    try {
      const row = await this.prisma.examCategory.create({
        data: {
          name: input.name,
          slug: input.slug ?? '',
          description: input.description,
          logoKey: input.logoKey,
          parentId: input.parentId,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          createdBy: actor.id,
        },
      });

      await this.audit(actor, 'CONTENT_CATEGORY_CREATED', row.id, { name: row.name, slug: row.slug }, meta);
      await this.revalidation.trigger();

      return this.toCategoryNode(row);
    } catch (error) {
      throw this.explain(error, 'A category with that slug already exists');
    }
  }

  async updateCategory(
    actor: AuthenticatedUser,
    id: string,
    body: unknown,
    meta: AuditMeta = {},
  ): Promise<CategoryNode> {
    const existing = await this.prisma.examCategory.findUnique({
      where: { id },
      select: { id: true, createdBy: true, parentId: true },
    });
    if (!existing) {
      throw new NotFoundException('Unknown category');
    }
    this.assertOwner(actor, existing.createdBy);

    const update = parseCatalogUpdateBody(body);

    if (update.parentId !== undefined) {
      if (update.parentId === existing.id) {
        throw new BadRequestException('A category cannot be its own parent');
      }
      const children = await this.prisma.examCategory.count({ where: { parentId: existing.id } });
      if (update.parentId !== null && children > 0) {
        throw new BadRequestException('Categories are two levels deep: a category with children cannot become a subcategory');
      }
    }

    try {
      const row = await this.prisma.examCategory.update({
        where: { id },
        data: {
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.slug === undefined ? {} : { slug: update.slug }),
          ...(update.description === undefined ? {} : { description: update.description }),
          ...(update.logoKey === undefined ? {} : { logoKey: update.logoKey }),
          ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder }),
          ...(update.isActive === undefined ? {} : { isActive: update.isActive }),
          ...(update.parentId === undefined ? {} : { parentId: update.parentId }),
        },
      });

      await this.audit(actor, 'CONTENT_CATEGORY_UPDATED', row.id, { name: row.name }, meta);
      await this.revalidation.trigger();

      return this.toCategoryNode(row);
    } catch (error) {
      throw this.explain(error, 'A category with that slug already exists');
    }
  }

  async deleteCategory(actor: AuthenticatedUser, id: string, meta: AuditMeta = {}): Promise<void> {
    const existing = await this.prisma.examCategory.findUnique({
      where: { id },
      select: { id: true, name: true, createdBy: true },
    });
    if (!existing) {
      throw new NotFoundException('Unknown category');
    }
    this.assertOwner(actor, existing.createdBy);

    try {
      await this.prisma.examCategory.delete({ where: { id } });
    } catch (error) {
      throw this.explain(error, 'Move or delete the categories and exams inside it first');
    }

    await this.audit(actor, 'CONTENT_CATEGORY_DELETED', id, { name: existing.name }, meta);
    await this.revalidation.trigger();
  }

  async createExam(actor: AuthenticatedUser, body: unknown, meta: AuditMeta = {}): Promise<ExamNode> {
    const input = parseExamBody(body);

    const category = await this.prisma.examCategory.findUnique({ where: { id: input.categoryId }, select: { id: true } });
    if (!category) {
      throw new NotFoundException('Unknown category');
    }

    try {
      const row = await this.prisma.exam.create({
        data: {
          categoryId: input.categoryId,
          name: input.name,
          slug: input.slug ?? '',
          description: input.description,
          logoKey: input.logoKey,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          createdBy: actor.id,
        },
      });

      await this.audit(actor, 'CONTENT_EXAM_CREATED', row.id, { name: row.name, slug: row.slug }, meta);
      await this.revalidation.trigger();

      return { ...this.toExamBase(row), subjects: [] };
    } catch (error) {
      throw this.explain(error, 'An exam with that slug already exists');
    }
  }

  async updateExam(actor: AuthenticatedUser, id: string, body: unknown, meta: AuditMeta = {}): Promise<ExamNode> {
    const existing = await this.prisma.exam.findUnique({
      where: { id },
      select: { id: true, createdBy: true },
    });
    if (!existing) {
      throw new NotFoundException('Unknown exam');
    }
    this.assertOwner(actor, existing.createdBy);

    const update = parseCatalogUpdateBody(body);

    try {
      const row = await this.prisma.exam.update({
        where: { id },
        data: {
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.slug === undefined ? {} : { slug: update.slug }),
          ...(update.description === undefined ? {} : { description: update.description }),
          ...(update.logoKey === undefined ? {} : { logoKey: update.logoKey }),
          ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder }),
          ...(update.isActive === undefined ? {} : { isActive: update.isActive }),
        },
      });

      await this.audit(actor, 'CONTENT_EXAM_UPDATED', row.id, { name: row.name }, meta);
      await this.revalidation.trigger();

      return this.examWithSubjects(row);
    } catch (error) {
      throw this.explain(error, 'An exam with that slug already exists');
    }
  }

  async deleteExam(actor: AuthenticatedUser, id: string, meta: AuditMeta = {}): Promise<void> {
    const existing = await this.prisma.exam.findUnique({
      where: { id },
      select: { id: true, name: true, createdBy: true },
    });
    if (!existing) {
      throw new NotFoundException('Unknown exam');
    }
    this.assertOwner(actor, existing.createdBy);

    try {
      await this.prisma.exam.delete({ where: { id } });
    } catch (error) {
      throw this.explain(error, 'Delete the subjects inside this exam first');
    }

    await this.audit(actor, 'CONTENT_EXAM_DELETED', id, { name: existing.name }, meta);
    await this.revalidation.trigger();
  }

  async createSubject(actor: AuthenticatedUser, body: unknown, meta: AuditMeta = {}): Promise<SubjectNode> {
    const input = parseSubjectBody(body);

    // Ownership lives on the exam, so creating a subject inside somebody else's exam
    // is the same denial as editing it.
    await this.examOwner(input.examId);

    try {
      const row = await this.prisma.subject.create({
        data: {
          examId: input.examId,
          name: input.name,
          slug: input.slug ?? '',
          description: input.description,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          createdBy: actor.id,
        },
      });

      await this.audit(actor, 'CONTENT_SUBJECT_CREATED', row.id, { name: row.name, examId: row.examId }, meta);
      await this.revalidation.trigger();

      return this.toSubjectNode(row, []);
    } catch (error) {
      throw this.explain(error, 'That exam already has a subject with that slug');
    }
  }

  async updateSubject(actor: AuthenticatedUser, id: string, body: unknown, meta: AuditMeta = {}): Promise<SubjectNode> {
    const existing = await this.prisma.subject.findUnique({ where: { id }, select: { id: true, examId: true } });
    if (!existing) {
      throw new NotFoundException('Unknown subject');
    }
    await this.examOwner(existing.examId);

    const update = parseCatalogUpdateBody(body);

    try {
      const row = await this.prisma.subject.update({
        where: { id },
        data: {
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.slug === undefined ? {} : { slug: update.slug }),
          ...(update.description === undefined ? {} : { description: update.description }),
          ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder }),
          ...(update.isActive === undefined ? {} : { isActive: update.isActive }),
        },
      });

      await this.audit(actor, 'CONTENT_SUBJECT_UPDATED', row.id, { name: row.name }, meta);
      await this.revalidation.trigger();

      const topics = await this.prisma.topic.findMany({ where: { subjectId: id } });
      return this.toSubjectNode(
        row,
        topics.map((topic) => ({
          id: topic.id,
          subjectId: topic.subjectId,
          name: topic.name,
          slug: topic.slug,
          sortOrder: topic.sortOrder,
          isActive: topic.isActive,
        })),
      );
    } catch (error) {
      throw this.explain(error, 'That exam already has a subject with that slug');
    }
  }

  async deleteSubject(actor: AuthenticatedUser, id: string, meta: AuditMeta = {}): Promise<void> {
    const existing = await this.prisma.subject.findUnique({
      where: { id },
      select: { id: true, name: true, examId: true },
    });
    if (!existing) {
      throw new NotFoundException('Unknown subject');
    }
    await this.examOwner(existing.examId);

    try {
      await this.prisma.subject.delete({ where: { id } });
    } catch (error) {
      throw this.explain(error, 'Delete the topics inside this subject first');
    }

    await this.audit(actor, 'CONTENT_SUBJECT_DELETED', id, { name: existing.name }, meta);
    await this.revalidation.trigger();
  }

  async createTopic(actor: AuthenticatedUser, body: unknown, meta: AuditMeta = {}): Promise<TopicNode> {
    const input = parseTopicBody(body);
    await this.subjectExamOwner(input.subjectId);

    try {
      const row = await this.prisma.topic.create({
        data: {
          subjectId: input.subjectId,
          name: input.name,
          slug: input.slug ?? '',
          description: input.description,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          createdBy: actor.id,
        },
      });

      await this.audit(actor, 'CONTENT_TOPIC_CREATED', row.id, { name: row.name, subjectId: row.subjectId }, meta);
      await this.revalidation.trigger();

      return {
        id: row.id,
        subjectId: row.subjectId,
        name: row.name,
        slug: row.slug,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
      };
    } catch (error) {
      throw this.explain(error, 'That subject already has a topic with that slug');
    }
  }

  async updateTopic(actor: AuthenticatedUser, id: string, body: unknown, meta: AuditMeta = {}): Promise<TopicNode> {
    const existing = await this.prisma.topic.findUnique({ where: { id }, select: { id: true, subjectId: true } });
    if (!existing) {
      throw new NotFoundException('Unknown topic');
    }
    await this.subjectExamOwner(existing.subjectId);

    const update = parseCatalogUpdateBody(body);

    try {
      const row = await this.prisma.topic.update({
        where: { id },
        data: {
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.slug === undefined ? {} : { slug: update.slug }),
          ...(update.description === undefined ? {} : { description: update.description }),
          ...(update.sortOrder === undefined ? {} : { sortOrder: update.sortOrder }),
          ...(update.isActive === undefined ? {} : { isActive: update.isActive }),
        },
      });

      await this.audit(actor, 'CONTENT_TOPIC_UPDATED', row.id, { name: row.name }, meta);
      await this.revalidation.trigger();

      return {
        id: row.id,
        subjectId: row.subjectId,
        name: row.name,
        slug: row.slug,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
      };
    } catch (error) {
      throw this.explain(error, 'That subject already has a topic with that slug');
    }
  }

  async deleteTopic(actor: AuthenticatedUser, id: string, meta: AuditMeta = {}): Promise<void> {
    const existing = await this.prisma.topic.findUnique({
      where: { id },
      select: { id: true, name: true, subjectId: true },
    });
    if (!existing) {
      throw new NotFoundException('Unknown topic');
    }
    await this.subjectExamOwner(existing.subjectId);

    try {
      await this.prisma.topic.delete({ where: { id } });
    } catch (error) {
      throw this.explain(error, 'This topic cannot be deleted');
    }

    await this.audit(actor, 'CONTENT_TOPIC_DELETED', id, { name: existing.name }, meta);
    await this.revalidation.trigger();
  }

  /** Administrator wins everywhere; an editor only ever owns what they created. */
  private assertOwner(actor: AuthenticatedUser, ownerId: string): void {
    if (actor.roleCode !== 'ADMIN' && ownerId !== actor.id) {
      throw new ForbiddenException('You can only change content you created');
    }
  }

  private async examOwner(examId: string): Promise<string> {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId }, select: { createdBy: true } });
    if (!exam) {
      throw new NotFoundException('Unknown exam');
    }
    return exam.createdBy;
  }

  private async subjectExamOwner(subjectId: string): Promise<string> {
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      select: { exam: { select: { createdBy: true } } },
    });
    if (!subject) {
      throw new NotFoundException('Unknown subject');
    }
    return subject.exam.createdBy;
  }

  private toSubjectNode(row: Subject, topics: readonly TopicNode[]): SubjectNode {
    return {
      id: row.id,
      examId: row.examId,
      name: row.name,
      slug: row.slug,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      topics,
    };
  }

  private toCategoryNode(row: ExamCategory): CategoryNode {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      logoKey: row.logoKey,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdBy: row.createdBy,
    };
  }

  private toExamBase(row: Exam): Omit<ExamNode, 'subjects'> {
    return {
      id: row.id,
      categoryId: row.categoryId,
      name: row.name,
      slug: row.slug,
      description: row.description,
      logoKey: row.logoKey,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdBy: row.createdBy,
    };
  }

  private async examWithSubjects(row: Exam): Promise<ExamNode> {
    const subjects = await this.prisma.subject.findMany({ where: { examId: row.id } });

    return {
      ...this.toExamBase(row),
      subjects: subjects.map((subject) => ({
        id: subject.id,
        examId: subject.examId,
        name: subject.name,
        slug: subject.slug,
        sortOrder: subject.sortOrder,
        isActive: subject.isActive,
        topics: [],
      })),
    };
  }

  private async audit(
    actor: AuthenticatedUser,
    action: string,
    entityId: string,
    metadata: Prisma.InputJsonObject,
    meta: AuditMeta,
  ): Promise<void> {
    await writeIdentityAudit(this.prisma, {
      action,
      actorUserId: actor.id,
      actorRole: actor.roleCode,
      entityType: 'catalog',
      entityId,
      metadata,
      ip: meta.ip ?? null,
    });
  }

  /** Turns a database constraint into the sentence the editor sees. */
  private explain(error: unknown, conflictMessage: string): unknown {
    if (isUniqueViolation(error)) {
      return new ConflictException(conflictMessage);
    }
    if (isForeignKeyViolation(error)) {
      return new ConflictException(conflictMessage);
    }
    return error;
  }
}
