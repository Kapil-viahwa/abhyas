import { randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Phase 6, P2: the builder over real HTTP, against Postgres, the real guard and the real row
 * locks.
 *
 * The rules under test: an editor with manage-tests builds a paper and submits it; only an
 * Administrator publishes or archives one (an editor or a student gets 403 whatever flags they
 * hold); a paper's questions must be published, in the paper's exam, and the editor's own
 * unless the caller is an Administrator; reordering keeps positions 1..n and nothing else; a
 * transition the lifecycle does not allow is refused; two simultaneous submits or publishes
 * give exactly one winner; and editing a published paper opens a new version, leaving the live
 * version and an open enrollment's snapshot untouched.
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

interface VersionView {
  readonly version: number;
  readonly durationMinutes: number;
  readonly marksPerQuestion: string;
  readonly negativeMarksPerQuestion: string;
  readonly questionCount: number;
  readonly totalMarks: string;
  readonly publishedAt: string | null;
}

interface QuestionView {
  readonly questionId: string;
  readonly position: number;
  readonly options: ReadonlyArray<{ readonly isCorrect: boolean }>;
  readonly explanationHtml: string | null;
}

interface TestView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly maxAttempts: number | null;
  readonly submittedAt: string | null;
  readonly version: VersionView;
  readonly publishedVersion: VersionView | null;
  readonly questions: readonly QuestionView[];
}

describe('the test builder over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  let admin!: Person;
  let editorA!: Person;
  let editorB!: Person;
  let editorNoTests!: Person;
  let student!: Person;

  let examA = '';
  let examB = '';
  let subjectA = '';
  let subjectB = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('tests_builder');

    process.env.DATABASE_URL = db.appUrl;
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
    process.env.S3_ENDPOINT = 'memory:';
    process.env.S3_BUCKET = 'abhyas-media';
    process.env.S3_ACCESS_KEY_ID = 'abhyas-dev';
    process.env.S3_SECRET_ACCESS_KEY = 'abhyas-dev-secret';

    redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }), {
      logger: ['error'],
    });
    await app.init();
    await waitUntilHealthy(app);

    admin = await makePerson('ADMIN', [], null);
    editorA = await makePerson('EDITOR', ['content.write', 'tests.write'], admin.id);
    editorB = await makePerson('EDITOR', ['content.write', 'tests.write'], admin.id);
    editorNoTests = await makePerson('EDITOR', ['content.write'], admin.id);
    student = await makePerson('USER', [], null);

    const category = await db.client.examCategory.create({
      data: { name: 'Phase 6 Category', slug: `p6-cat-${randomUUID().slice(0, 8)}`, createdBy: admin.id },
      select: { id: true },
    });

    examA = (
      await db.client.exam.create({
        data: {
          categoryId: category.id,
          name: 'Phase 6 A',
          slug: `phase-6-a-${randomUUID().slice(0, 8)}`,
          createdBy: editorA.id,
        },
        select: { id: true },
      })
    ).id;

    examB = (
      await db.client.exam.create({
        data: {
          categoryId: category.id,
          name: 'Phase 6 B',
          slug: `phase-6-b-${randomUUID().slice(0, 8)}`,
          createdBy: editorB.id,
        },
        select: { id: true },
      })
    ).id;

    subjectA = (
      await db.client.subject.create({
        data: {
          examId: examA,
          name: 'Reasoning',
          slug: `reasoning-${randomUUID().slice(0, 8)}`,
          createdBy: editorA.id,
        },
        select: { id: true },
      })
    ).id;

    subjectB = (
      await db.client.subject.create({
        data: {
          examId: examB,
          name: 'English',
          slug: `english-${randomUUID().slice(0, 8)}`,
          createdBy: editorB.id,
        },
        select: { id: true },
      })
    ).id;
  }, 240_000);

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

  function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) {
    const headers = { authorization: `Bearer ${token}` };
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
        email: `p6-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Phase Six Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    for (const code of permissions) {
      const permission = await db.client.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      // A person cannot grant themselves a permission (the database refuses it), so the fixture
      // records the administrator who would have granted it in the real flow.
      await db.client.userPermission.create({
        data: { userId: user.id, permissionId: permission.id, grantedBy },
      });
    }

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  /** A question with one correct option, already published unless the test asks otherwise. */
  async function newQuestion(
    owner: Person,
    examId: string,
    subjectId: string,
    options: { published?: boolean } = {},
  ): Promise<string> {
    const published = options.published !== false;
    const question = await db.client.question.create({
      data: {
        examId,
        subjectId,
        createdBy: owner.id,
        status: published ? 'PUBLISHED' : 'DRAFT',
        currentVersion: 1,
      },
      select: { id: true },
    });

    await db.client.questionVersion.create({
      data: {
        questionId: question.id,
        version: 1,
        questionType: 'MCQ',
        language: 'EN',
        difficulty: 'MEDIUM',
        contentHtml: '<p>Which of these is a prime?</p>',
        explanationHtml: '<p>Seven has no divisors.</p>',
        marks: 2,
        negativeMarks: '0.5',
        createdBy: owner.id,
        publishedAt: published ? new Date() : null,
        options: {
          create: [
            { position: 1, optionHtml: '<p>4</p>', isCorrect: false },
            { position: 2, optionHtml: '<p>7</p>', isCorrect: true },
            { position: 3, optionHtml: '<p>9</p>', isCorrect: false },
          ],
        },
      },
    });

    return question.id;
  }

  async function createPaper(actor: Person = editorA): Promise<string> {
    const created = await call('POST', '/v1/editor/tests', actor.token, {
      examId: examA,
      title: `Paper ${randomUUID().slice(0, 8)}`,
    });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as TestView).id;
  }

  async function draftWithQuestions(actor: Person = editorA): Promise<{ id: string; questionIds: string[] }> {
    const id = await createPaper(actor);
    const questionIds = [await newQuestion(actor, examA, subjectA), await newQuestion(actor, examA, subjectA)];
    const set = await call('PUT', `/v1/editor/tests/${id}/questions`, actor.token, { questionIds });
    expect(set.statusCode, set.body).toBe(200);
    return { id, questionIds };
  }

  async function submittedPaper(actor: Person = editorA): Promise<{ id: string; questionIds: string[] }> {
    const paper = await draftWithQuestions(actor);
    const submitted = await call('POST', `/v1/editor/tests/${paper.id}/submit`, actor.token);
    expect(submitted.statusCode, submitted.body).toBe(200);
    return paper;
  }

  /** A 64-hex fingerprint, the shape `coin_transactions_fingerprint_format` requires. */
  function fingerprint(): string {
    return randomUUID().replace(/-/g, '').repeat(2);
  }

  /** Tops the wallet up through the ledger, so no statement ever writes a negative balance. */
  async function ensureFunds(userId: string): Promise<number> {
    const wallet = await db.client.coinWallet.upsert({
      where: { userId },
      create: { userId, balance: 0 },
      update: {},
      select: { balance: true },
    });

    if (wallet.balance >= 100) {
      return wallet.balance;
    }

    const topUp = 1000 - wallet.balance;
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

    return wallet.balance + topUp;
  }

  /** One ENROLLMENT charge of 100, written the way `CoinService.spend` will write it in P4. */
  async function enrollmentCharge(userId: string): Promise<string> {
    const previous = await ensureFunds(userId);
    const entry = await db.client.coinTransaction.create({
      data: {
        userId,
        type: 'ENROLLMENT',
        amount: -100,
        previousBalance: previous,
        newBalance: previous - 100,
        referenceType: 'enrollment',
        referenceId: randomUUID(),
        idempotencyKey: `enroll:${randomUUID()}`,
        requestFingerprint: fingerprint(),
      },
      select: { id: true },
    });
    return entry.id;
  }

  it('lets an editor with manage-tests create, edit, order and submit a paper', async () => {
    const questionIds = [
      await newQuestion(editorA, examA, subjectA),
      await newQuestion(editorA, examA, subjectA),
      await newQuestion(editorA, examA, subjectA),
    ];

    const created = await call('POST', '/v1/editor/tests', editorA.token, {
      examId: examA,
      title: 'SSC CGL mock 1',
      description: 'A first paper.',
    });
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json() as TestView;
    expect(draft.status).toBe('DRAFT');
    expect(draft.version.version).toBe(1);
    expect(draft.version.durationMinutes).toBe(60);

    const saved = await call('PATCH', `/v1/editor/tests/${draft.id}`, editorA.token, {
      title: 'SSC CGL mock 1 (revised)',
      durationMinutes: 45,
      marksPerQuestion: '2',
      negativeMarksPerQuestion: '0.5',
      maxAttempts: 3,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const edited = saved.json() as TestView;
    expect(edited.title).toBe('SSC CGL mock 1 (revised)');
    expect(edited.maxAttempts).toBe(3);
    expect(edited.version.durationMinutes).toBe(45);
    expect(edited.version.marksPerQuestion).toBe('2');
    expect(edited.version.negativeMarksPerQuestion).toBe('0.5');

    const ordered = await call('PUT', `/v1/editor/tests/${draft.id}/questions`, editorA.token, { questionIds });
    expect(ordered.statusCode, ordered.body).toBe(200);
    const paper = ordered.json() as TestView;
    expect(paper.questions.map((question) => question.questionId)).toEqual(questionIds);
    expect(paper.questions.map((question) => question.position)).toEqual([1, 2, 3]);
    expect(paper.version.questionCount).toBe(3);
    expect(paper.version.totalMarks).toBe('6.00');

    const submitted = await call('POST', `/v1/editor/tests/${draft.id}/submit`, editorA.token);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const submittedBody = submitted.json() as TestView;
    expect(submittedBody.status).toBe('SUBMITTED');
    expect(submittedBody.submittedAt).not.toBeNull();

    const list = await call('GET', '/v1/editor/tests', editorA.token);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toContain(draft.id);

    for (const action of ['TEST_CREATED', 'TEST_UPDATED', 'TEST_QUESTIONS_SET', 'TEST_SUBMITTED']) {
      const row = await db.client.auditLog.findFirst({
        where: { action, entityId: draft.id, actorUserId: editorA.id },
        select: { action: true },
      });
      expect(row?.action).toBe(action);
    }
  });

  it('refuses an unknown field, a bad pattern value, a foreign exam and an unknown filter', async () => {
    const unknownField = await call('POST', '/v1/editor/tests', editorA.token, {
      examId: examA,
      title: 'Paper',
      surprise: true,
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json().message).toMatch(/surprise is not a field/);

    const zeroDuration = await call('POST', '/v1/editor/tests', editorA.token, {
      examId: examA,
      title: 'Paper',
      durationMinutes: 0,
    });
    expect(zeroDuration.statusCode).toBe(400);

    const missingTitle = await call('POST', '/v1/editor/tests', editorA.token, { examId: examA });
    expect(missingTitle.statusCode).toBe(400);

    // Editor A may not build for editor B's exam, and the refusal is the same as an unknown one.
    const foreignExam = await call('POST', '/v1/editor/tests', editorA.token, { examId: examB, title: 'Paper' });
    expect(foreignExam.statusCode).toBe(404);
    expect(foreignExam.json().message).toMatch(/Unknown exam/);

    const paper = await createPaper();
    const negativeAboveMarks = await call('PATCH', `/v1/editor/tests/${paper}`, editorA.token, {
      marksPerQuestion: '1',
      negativeMarksPerQuestion: '2',
    });
    expect(negativeAboveMarks.statusCode).toBe(400);
    expect(negativeAboveMarks.json().message).toMatch(/cannot be more than marksPerQuestion/);

    const emptyPatch = await call('PATCH', `/v1/editor/tests/${paper}`, editorA.token, {});
    expect(emptyPatch.statusCode).toBe(400);

    const badStatus = await call('GET', '/v1/editor/tests?status=NOPE', editorA.token);
    expect(badStatus.statusCode).toBe(400);

    const badFilter = await call('GET', '/v1/editor/tests?limit=1', editorA.token);
    expect(badFilter.statusCode).toBe(400);

    const repeated = await call('GET', `/v1/editor/tests?examId=${examA}&examId=${examA}`, editorA.token);
    expect(repeated.statusCode).toBe(400);

    const badUuid = await call('GET', '/v1/editor/tests/not-a-uuid', editorA.token);
    expect(badUuid.statusCode).toBe(400);
  });

  it('refuses to submit a paper with no questions, and to publish a draft', async () => {
    const paper = await createPaper();

    const submitted = await call('POST', `/v1/editor/tests/${paper}/submit`, editorA.token);
    expect(submitted.statusCode).toBe(400);
    expect(submitted.json().message).toMatch(/at least one question/);

    const published = await call('POST', `/v1/admin/tests/${paper}/publish`, admin.token);
    expect(published.statusCode).toBe(409);
    expect(published.json().message).toMatch(/must be submitted/);
  });

  it('lets an editor without manage-tests read the list but refuses every write', async () => {
    const paper = await draftWithQuestions();

    const list = await call('GET', '/v1/editor/tests', editorNoTests.token);
    expect(list.statusCode).toBe(200);

    const create = await call('POST', '/v1/editor/tests', editorNoTests.token, { examId: examA, title: 'Mine' });
    expect(create.statusCode).toBe(403);

    const edit = await call('PATCH', `/v1/editor/tests/${paper.id}`, editorNoTests.token, { durationMinutes: 30 });
    expect(edit.statusCode).toBe(403);

    const set = await call('PUT', `/v1/editor/tests/${paper.id}/questions`, editorNoTests.token, {
      questionIds: paper.questionIds,
    });
    expect(set.statusCode).toBe(403);

    const submit = await call('POST', `/v1/editor/tests/${paper.id}/submit`, editorNoTests.token);
    expect(submit.statusCode).toBe(403);

    const publish = await call('POST', `/v1/admin/tests/${paper.id}/publish`, editorNoTests.token);
    expect(publish.statusCode).toBe(403);

    // The whole paper is unchanged: none of the refusals ran a handler.
    const unchanged = await db.client.test.findUniqueOrThrow({
      where: { id: paper.id },
      select: { status: true, currentVersion: true },
    });
    expect(unchanged.status).toBe('DRAFT');
    expect(unchanged.currentVersion).toBe(1);
  });

  it('refuses a student on every builder route and never sends an answer key back', async () => {
    const paper = await draftWithQuestions();

    const routes: Array<readonly [method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: Record<string, unknown>]> = [
      ['GET', '/v1/editor/tests'],
      ['GET', `/v1/editor/tests/${paper.id}`],
      ['POST', '/v1/editor/tests', { examId: examA, title: 'Mine' }],
      ['PATCH', `/v1/editor/tests/${paper.id}`, { durationMinutes: 30 }],
      ['PUT', `/v1/editor/tests/${paper.id}/questions`, { questionIds: paper.questionIds }],
      ['POST', `/v1/editor/tests/${paper.id}/submit`],
      ['POST', `/v1/admin/tests/${paper.id}/publish`],
      ['POST', `/v1/admin/tests/${paper.id}/archive`],
    ];

    for (const [method, url, payload] of routes) {
      const response = await call(method, url, student.token, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.body).not.toContain('isCorrect');
      expect(response.body).not.toContain('explanationHtml');
    }

    const anonymous = await app.inject({ method: 'GET', url: '/v1/editor/tests' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses an editor publish or archive, and keeps one editor out of another paper', async () => {
    const paper = await submittedPaper();

    const publish = await call('POST', `/v1/admin/tests/${paper.id}/publish`, editorA.token);
    expect(publish.statusCode).toBe(403);
    expect(publish.json().message).toMatch(/Insufficient permissions/);

    const archive = await call('POST', `/v1/admin/tests/${paper.id}/archive`, editorA.token);
    expect(archive.statusCode).toBe(403);

    // Editor A's flags are tests.write and content.write; `tests.publish` is not one of them,
    // and the database refuses to grant it to anyone but an Administrator (P1).
    const codes = await db.client.userPermission.findMany({
      where: { userId: editorA.id },
      select: { permission: { select: { code: true } } },
    });
    expect(codes.map((row) => row.permission.code).sort()).toEqual(['content.write', 'tests.write']);

    const foreignRead = await call('GET', `/v1/editor/tests/${paper.id}`, editorB.token);
    expect(foreignRead.statusCode).toBe(404);

    const foreignSubmit = await call('POST', `/v1/editor/tests/${paper.id}/submit`, editorB.token);
    expect(foreignSubmit.statusCode).toBe(404);
  });

  it('validates every question on the paper', async () => {
    const paper = await createPaper();
    const unpublished = await newQuestion(editorA, examA, subjectA, { published: false });
    const otherExam = await newQuestion(editorA, examB, subjectB);
    const someoneElses = await newQuestion(editorB, examA, subjectA);

    const notPublished = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, {
      questionIds: [unpublished],
    });
    expect(notPublished.statusCode).toBe(400);
    expect(notPublished.json().message).toMatch(/Question 1 is not published/);

    const wrongExam = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, {
      questionIds: [otherExam],
    });
    expect(wrongExam.statusCode).toBe(400);
    expect(wrongExam.json().message).toMatch(/belongs to a different exam/);

    const foreign = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, {
      questionIds: [someoneElses],
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toMatch(/is not available to you/);

    const invented = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, {
      questionIds: [randomUUID()],
    });
    expect(invented.statusCode).toBe(400);
    expect(invented.json().message).toMatch(/does not exist/);

    const duplicated = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, {
      questionIds: [someoneElses, someoneElses],
    });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json().message).toMatch(/only once/);

    // An Administrator may place another editor's question on this editor's paper.
    const asAdmin = await call('PUT', `/v1/editor/tests/${paper}/questions`, admin.token, {
      questionIds: [someoneElses],
    });
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    expect((asAdmin.json() as TestView).questions[0]?.questionId).toBe(someoneElses);
  });

  it('keeps positions unique and gapless when the paper is reordered', async () => {
    const paper = await draftWithQuestions();
    const [first, second] = paper.questionIds;
    const third = await newQuestion(editorA, examA, subjectA);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const three = await call('PUT', `/v1/editor/tests/${paper.id}/questions`, editorA.token, {
      questionIds: [first, second, third],
    });
    expect(three.statusCode, three.body).toBe(200);

    const reordered = await call('PUT', `/v1/editor/tests/${paper.id}/questions`, editorA.token, {
      questionIds: [third, first],
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    const body = reordered.json() as TestView;
    expect(body.questions.map((question) => question.questionId)).toEqual([third, first]);
    expect(body.questions.map((question) => question.position)).toEqual([1, 2]);

    const version = await db.client.testVersion.findFirstOrThrow({
      where: { testId: paper.id, version: 1 },
      select: { id: true },
    });
    const rows = await db.client.testQuestion.findMany({
      where: { testVersionId: version.id },
      orderBy: { position: 'asc' },
      select: { position: true, questionId: true },
    });
    expect(rows.map((row) => row.position)).toEqual([1, 2]);
    expect(rows.map((row) => row.questionId)).toEqual([third, first]);
  });

  it('refuses every transition the lifecycle does not allow', async () => {
    const paper = await draftWithQuestions();

    const archiveDraft = await call('POST', `/v1/admin/tests/${paper.id}/archive`, admin.token);
    expect(archiveDraft.statusCode).toBe(409);
    expect(archiveDraft.json().message).toMatch(/Only a published test/);

    const submitted = await call('POST', `/v1/editor/tests/${paper.id}/submit`, editorA.token);
    expect(submitted.statusCode, submitted.body).toBe(200);

    const secondSubmit = await call('POST', `/v1/editor/tests/${paper.id}/submit`, editorA.token);
    expect(secondSubmit.statusCode).toBe(409);

    const editSubmitted = await call('PATCH', `/v1/editor/tests/${paper.id}`, editorA.token, { durationMinutes: 30 });
    expect(editSubmitted.statusCode).toBe(409);

    const published = await call('POST', `/v1/admin/tests/${paper.id}/publish`, admin.token);
    expect(published.statusCode, published.body).toBe(200);
    const publishedBody = published.json() as TestView;
    expect(publishedBody.status).toBe('PUBLISHED');
    expect(publishedBody.version.publishedAt).not.toBeNull();

    const publishAgain = await call('POST', `/v1/admin/tests/${paper.id}/publish`, admin.token);
    expect(publishAgain.statusCode).toBe(409);
    expect(publishAgain.json().message).toMatch(/already published/);

    const archived = await call('POST', `/v1/admin/tests/${paper.id}/archive`, admin.token);
    expect(archived.statusCode, archived.body).toBe(200);
    expect((archived.json() as TestView).status).toBe('ARCHIVED');

    const archiveAgain = await call('POST', `/v1/admin/tests/${paper.id}/archive`, admin.token);
    expect(archiveAgain.statusCode).toBe(409);

    const editArchived = await call('PATCH', `/v1/editor/tests/${paper.id}`, editorA.token, { durationMinutes: 30 });
    expect(editArchived.statusCode).toBe(409);

    const submitArchived = await call('POST', `/v1/editor/tests/${paper.id}/submit`, editorA.token);
    expect(submitArchived.statusCode).toBe(409);
  });

  it('gives exactly one winner when two submits arrive at once', async () => {
    const paper = await draftWithQuestions();

    const [first, second] = await Promise.all([
      call('POST', `/v1/editor/tests/${paper.id}/submit`, editorA.token),
      call('POST', `/v1/editor/tests/${paper.id}/submit`, editorA.token),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

    const row = await db.client.test.findUniqueOrThrow({ where: { id: paper.id }, select: { status: true } });
    expect(row.status).toBe('SUBMITTED');

    const audits = await db.client.auditLog.count({ where: { action: 'TEST_SUBMITTED', entityId: paper.id } });
    expect(audits).toBe(1);
  });

  it('gives exactly one winner when two publishes arrive at once', async () => {
    const paper = await submittedPaper();

    const [first, second] = await Promise.all([
      call('POST', `/v1/admin/tests/${paper.id}/publish`, admin.token),
      call('POST', `/v1/admin/tests/${paper.id}/publish`, admin.token),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);

    const publishedVersions = await db.client.testVersion.count({
      where: { testId: paper.id, publishedAt: { not: null } },
    });
    expect(publishedVersions).toBe(1);

    const audits = await db.client.auditLog.count({ where: { action: 'TEST_PUBLISHED', entityId: paper.id } });
    expect(audits).toBe(1);
  });

  it('opens a new version when a published paper is edited, and leaves the sold version alone', async () => {
    const questionIds = [await newQuestion(editorA, examA, subjectA), await newQuestion(editorA, examA, subjectA)];
    const paper = await createPaper();
    const set = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, { questionIds });
    expect(set.statusCode, set.body).toBe(200);
    const submitted = await call('POST', `/v1/editor/tests/${paper}/submit`, editorA.token);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const published = await call('POST', `/v1/admin/tests/${paper}/publish`, admin.token);
    expect(published.statusCode, published.body).toBe(200);

    const versionOne = await db.client.testVersion.findFirstOrThrow({
      where: { testId: paper, version: 1 },
      select: { id: true },
    });

    // An enrollment on the live version: the snapshot a student was sold.
    const charge = await enrollmentCharge(student.id);
    await db.client.enrollment.create({
      data: {
        testId: paper,
        testVersionId: versionOne.id,
        userId: student.id,
        coinTransactionId: charge,
        idempotencyKey: `enroll:${randomUUID()}`,
      },
    });

    const edited = await call('PATCH', `/v1/editor/tests/${paper}`, editorA.token, { durationMinutes: 90 });
    expect(edited.statusCode, edited.body).toBe(200);
    const afterEdit = edited.json() as TestView;
    expect(afterEdit.status).toBe('PUBLISHED');
    expect(afterEdit.currentVersion).toBe(2);
    expect(afterEdit.version.version).toBe(2);
    expect(afterEdit.version.publishedAt).toBeNull();
    expect(afterEdit.publishedVersion?.version).toBe(1);
    expect(afterEdit.publishedVersion?.durationMinutes).toBe(60);

    const third = await newQuestion(editorA, examA, subjectA);
    const narrowed = await call('PUT', `/v1/editor/tests/${paper}/questions`, editorA.token, {
      questionIds: [third],
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect((narrowed.json() as TestView).version.questionCount).toBe(1);

    // The sold version keeps its paper, and the database refuses to rewrite it.
    const soldQuestions = await db.client.testQuestion.count({ where: { testVersionId: versionOne.id } });
    expect(soldQuestions).toBe(2);
    await expect(
      db.client.testVersion.update({ where: { id: versionOne.id }, data: { durationMinutes: 15 } }),
    ).rejects.toThrow(/published version cannot be updated/);

    const enrollment = await db.client.enrollment.findFirstOrThrow({
      where: { testId: paper, userId: student.id },
      select: { testVersionId: true },
    });
    expect(enrollment.testVersionId).toBe(versionOne.id);

    // The revision is handed over (recorded, the test stays published) and then published.
    const handedOver = await call('POST', `/v1/editor/tests/${paper}/submit`, editorA.token);
    expect(handedOver.statusCode, handedOver.body).toBe(200);
    expect((handedOver.json() as TestView).status).toBe('PUBLISHED');

    const republished = await call('POST', `/v1/admin/tests/${paper}/publish`, admin.token);
    expect(republished.statusCode, republished.body).toBe(200);
    const revision = republished.json() as TestView;
    expect(revision.status).toBe('PUBLISHED');
    expect(revision.publishedVersion?.version).toBe(2);
    expect(revision.version.publishedAt).not.toBeNull();

    const stillSold = await db.client.enrollment.findFirstOrThrow({
      where: { testId: paper, userId: student.id },
      select: { testVersionId: true },
    });
    expect(stillSold.testVersionId).toBe(versionOne.id);
  });

  it('shows the answer key to an Editor and an Administrator, and the list carries no paper', async () => {
    const paper = await draftWithQuestions();

    for (const actor of [editorA, admin]) {
      const detail = await call('GET', `/v1/editor/tests/${paper.id}`, actor.token);
      expect(detail.statusCode, detail.body).toBe(200);
      const body = detail.json() as TestView;
      expect(body.questions).toHaveLength(2);
      expect(body.questions[0]?.explanationHtml).not.toBeNull();
      expect(body.questions[0]?.options.some((option) => option.isCorrect)).toBe(true);
    }

    const list = await call('GET', '/v1/editor/tests', admin.token);
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: TestView[] }).items;
    expect(items.every((item) => item.questions.length === 0)).toBe(true);
  });
});
