import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { hashPassword } from '../src/auth/password';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * The exam catalog over real HTTP.
 *
 * The rules these tests exist for:
 * 1. An editor with `content.write` may create content and change only what they made.
 * 2. Subjects and topics inherit the ownership of their exam, so they are not a way around it.
 * 3. The public catalog shows active rows only.
 * 4. The database refuses a bad slug and a third category level whatever the API does.
 */

const PASSWORD = 'correct-horse-9battery';

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

describe('the exam catalog over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  beforeAll(async () => {
    db = await createMigratedTestDatabase('catalog');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    // Revalidation is not running in this job; point it at a port that refuses at once.
    process.env.WEB_URL = 'http://127.0.0.1:9';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitUntilHealthy(app);
  }, 180_000);

  afterAll(async () => {
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

  async function makeAdmin(): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'ADMIN' }, select: { id: true } });
    const email = `catalog-admin-${randomUUID().slice(0, 8)}@example.com`;
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Catalog Admin',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  async function makeEditor(grants: readonly string[] = ['content.write']): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'EDITOR' }, select: { id: true } });
    const email = `catalog-editor-${randomUUID().slice(0, 8)}@example.com`;
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Catalog Editor',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const permissions = await db.client.permission.findMany({ where: { code: { in: [...grants] } } });
    for (const permission of permissions) {
      await db.client.userPermission.create({
        data: { userId: user.id, permissionId: permission.id, grantedBy: null },
      });
    }

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  async function makeStudent(): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: 'USER' }, select: { id: true } });
    const email = `catalog-student-${randomUUID().slice(0, 8)}@example.com`;
    const user = await db.client.user.create({
      data: {
        email,
        fullName: 'Catalog Student',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token: string | null,
    payload?: Record<string, unknown>,
  ) {
    const headers = token === null ? {} : { authorization: `Bearer ${token}` };
    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  async function createCategory(token: string, name: string, parentId?: string) {
    return call('POST', '/v1/catalog/categories', token, {
      name,
      parentId: parentId ?? null,
    });
  }

  async function createExam(token: string, categoryId: string, name: string) {
    return call('POST', '/v1/catalog/exams', token, { name, categoryId });
  }

  describe('constraints', () => {
    it('refuses a slug that is not a slug and a duplicate one', async () => {
      const admin = await makeAdmin();
      const categoryId = (await createCategory(admin.token, 'Banking')).json().id as string;

      const duplicate = await createCategory(admin.token, 'Banking Again');
      // The name-derived slug differs, so make the clash explicit.
      const sameSlug = await call('POST', '/v1/catalog/categories', admin.token, {
        name: 'Another Banking',
        slug: 'banking-again',
      });
      expect(duplicate.statusCode).toBe(201);
      expect(sameSlug.statusCode).toBe(409);

      const invalid = await call('POST', '/v1/catalog/categories', admin.token, {
        name: 'Invalid Slug',
        slug: 'Not A Slug!',
      });
      expect(invalid.statusCode).toBe(400);

      // The database refuses the same thing even when the API is bypassed.
      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "exam_categories" ("name", "slug", "created_by") VALUES ('Raw', 'Bad Slug', $1::uuid)`,
          admin.id,
        ),
      ).rejects.toThrow();

      const exam = await createExam(admin.token, categoryId, 'SBI PO');
      expect(exam.statusCode).toBe(201);
      const duplicateExam = await call('POST', '/v1/catalog/exams', admin.token, {
        name: 'SBI PO Again',
        slug: slugOf(exam),
        categoryId,
      });
      expect(duplicateExam.statusCode).toBe(409);
    });

    it('keeps the category tree two levels deep', async () => {
      const admin = await makeAdmin();
      const root = (await createCategory(admin.token, 'SSC')).json().id as string;
      const child = await createCategory(admin.token, 'SSC CGL', root);
      expect(child.statusCode).toBe(201);

      const grandchild = await createCategory(admin.token, 'SSC CGL Tier 1', child.json().id as string);
      expect(grandchild.statusCode).toBe(400);

      await expect(
        db.client.$executeRawUnsafe(
          `INSERT INTO "exam_categories" ("name", "slug", "parent_id", "created_by") VALUES ('Raw', 'raw-child', $1::uuid, $2::uuid)`,
          child.json().id as string,
          admin.id,
        ),
      ).rejects.toThrow(/two levels deep/);
    });

    function slugOf(response: { json: () => unknown }): string {
      const body = response.json() as { slug?: string };
      return body.slug ?? '';
    }
  });

  describe('ownership', () => {
    it('lets an editor create content and change only their own', async () => {
      const admin = await makeAdmin();
      const editorA = await makeEditor();
      const editorB = await makeEditor();

      const category = await createCategory(editorA.token, `Railways ${randomUUID().slice(0, 4)}`);
      expect(category.statusCode).toBe(201);
      const categoryId = category.json().id as string;

      const exam = await createExam(editorA.token, categoryId, `RRB NTPC ${randomUUID().slice(0, 4)}`);
      expect(exam.statusCode).toBe(201);
      const examId = exam.json().id as string;

      // The creator may edit it.
      const ownUpdate = await call('PATCH', `/v1/catalog/exams/${examId}`, editorA.token, { name: 'RRB NTPC Updated' });
      expect(ownUpdate.statusCode).toBe(200);

      // Another editor may not touch it, in any of the three ways.
      const foreignUpdate = await call('PATCH', `/v1/catalog/exams/${examId}`, editorB.token, { name: 'Hijacked' });
      expect(foreignUpdate.statusCode).toBe(403);

      const foreignSubject = await call('POST', '/v1/catalog/subjects', editorB.token, {
        name: 'General Awareness',
        examId,
      });
      expect(foreignSubject.statusCode).toBe(403);

      const foreignDelete = await call('DELETE', `/v1/catalog/exams/${examId}`, editorB.token);
      expect(foreignDelete.statusCode).toBe(403);

      // And the exam is untouched.
      const stillThere = await call('GET', '/v1/catalog/tree', editorA.token);
      const tree = stillThere.json() as { exams: Array<{ id: string; name: string }> };
      expect(tree.exams.find((row) => row.id === examId)?.name).toBe('RRB NTPC Updated');

      // The administrator is not subject to the rule.
      const adminUpdate = await call('PATCH', `/v1/catalog/exams/${examId}`, admin.token, { isActive: false });
      expect(adminUpdate.statusCode).toBe(200);
    });

    it('inherits ownership through the exam for subjects and topics', async () => {
      const editorA = await makeEditor();
      const editorB = await makeEditor();

      const categoryId = (await createCategory(editorA.token, `Defence ${randomUUID().slice(0, 4)}`)).json().id as string;
      const examId = (await createExam(editorA.token, categoryId, `NDA ${randomUUID().slice(0, 4)}`)).json().id as string;
      const subject = await call('POST', '/v1/catalog/subjects', editorA.token, { name: 'Mathematics', examId });
      expect(subject.statusCode).toBe(201);
      const subjectId = subject.json().id as string;

      // Editor B cannot add a topic under A's subject, or edit it.
      const foreignTopic = await call('POST', '/v1/catalog/topics', editorB.token, {
        name: 'Trigonometry',
        subjectId,
      });
      expect(foreignTopic.statusCode).toBe(403);

      const foreignSubjectUpdate = await call('PATCH', `/v1/catalog/subjects/${subjectId}`, editorB.token, {
        name: 'Hijacked',
      });
      expect(foreignSubjectUpdate.statusCode).toBe(403);

      const ownTopic = await call('POST', '/v1/catalog/topics', editorA.token, { name: 'Trigonometry', subjectId });
      expect(ownTopic.statusCode).toBe(201);
      const topicId = ownTopic.json().id as string;

      const foreignTopicUpdate = await call('PATCH', `/v1/catalog/topics/${topicId}`, editorB.token, {
        name: 'Hijacked',
      });
      expect(foreignTopicUpdate.statusCode).toBe(403);
    });

    it('refuses an editor whose capability was never granted, and a student', async () => {
      const editorWithoutFlags = await makeEditor([]);
      const student = await makeStudent();

      expect((await call('GET', '/v1/catalog/tree', editorWithoutFlags.token)).statusCode).toBe(403);
      expect((await createCategory(editorWithoutFlags.token, 'Nope')).statusCode).toBe(403);

      expect((await call('GET', '/v1/catalog/tree', student.token)).statusCode).toBe(403);
      expect((await createCategory(student.token, 'Nope')).statusCode).toBe(403);
    });
  });

  describe('the public catalog', () => {
    it('lists active rows only, and a subcategory needs an active parent', async () => {
      const admin = await makeAdmin();
      const marker = randomUUID().slice(0, 4);

      const visible = (await createCategory(admin.token, `Visible ${marker}`)).json() as { id: string; slug: string };
      const hidden = (await createCategory(admin.token, `Hidden ${marker}`)).json() as { id: string; slug: string };
      await call('PATCH', `/v1/catalog/categories/${hidden.id}`, admin.token, { isActive: false });

      const visibleChild = await createCategory(admin.token, `Visible Child ${marker}`, visible.id);
      expect(visibleChild.statusCode).toBe(201);

      const hiddenParent = (await createCategory(admin.token, `Hidden Parent ${marker}`)).json() as { id: string };
      const childOfHidden = await createCategory(admin.token, `Child Of Hidden ${marker}`, hiddenParent.id);
      expect(childOfHidden.statusCode).toBe(201);
      await call('PATCH', `/v1/catalog/categories/${hiddenParent.id}`, admin.token, { isActive: false });

      const visibleExam = (await createExam(admin.token, visible.id, `Public Exam ${marker}`)).json() as {
        id: string;
        slug: string;
      };
      const hiddenExam = (await createExam(admin.token, visible.id, `Draft Exam ${marker}`)).json() as { id: string };
      await call('PATCH', `/v1/catalog/exams/${hiddenExam.id}`, admin.token, { isActive: false });

      const response = await call('GET', '/v1/public/catalog', null);
      expect(response.statusCode).toBe(200);

      const body = response.json() as {
        categories: Array<{ id: string; slug: string; parentId: string | null }>;
        exams: Array<{ id: string; slug: string }>;
      };

      const slugs = body.categories.map((row) => row.slug);
      expect(slugs).toContain(visible.slug);
      expect(slugs).not.toContain(hidden.slug);
      expect(slugs).not.toContain(`child-of-hidden-${marker}`);
      expect(slugs).not.toContain(`hidden-parent-${marker}`);

      const examIds = body.exams.map((row) => row.id);
      expect(examIds).toContain(visibleExam.id);
      expect(examIds).not.toContain(hiddenExam.id);
    });
  });
});
