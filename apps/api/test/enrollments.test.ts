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
 * Phase 6, P4: enrollment over real HTTP, against Postgres, the real guard and the real row
 * locks.
 *
 * What is proven: one enrollment is one `ENROLLMENT` debit of the platform's price and one
 * `OPEN` row, written together; one `Idempotency-Key` pays once, sequentially or at the same
 * moment, and the same key on another test is a conflict; two different keys racing for one
 * paper give exactly one winner and roll the loser's debit back; a wallet with exactly the
 * price spends it once and never goes negative; an open enrollment blocks a second one and a
 * retake after completion pays again, leaving the old attempt untouched; the paper's attempt
 * cap is enforced; a suspended account, a draft, a submitted paper and an archived one are all
 * refused with nothing written; each refusal names a stable `code` beside the message it always
 * sent, which is how the web tier tells three different 409s and two different 400s apart; and
 * no answer carries a `userId`, an answer key, a creator or a ledger detail.
 */

const PASSWORD = 'correct-horse-9battery';
const PRICE_SETTING = 'default_enrollment_cost';

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

interface TestSummary {
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

interface EnrollmentState {
  readonly status: string;
  readonly attemptNumber: number | null;
  readonly enrollmentId: string | null;
  readonly attemptsUsed: number;
}

interface CatalogItem extends TestSummary {
  readonly enrollment: EnrollmentState;
}

interface CatalogPage {
  readonly items: CatalogItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pages: number;
}

interface EnrollmentView {
  readonly id: string;
  readonly testId: string;
  readonly testVersionId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly enrolledAt: string;
  readonly completedAt: string | null;
  readonly cost: number;
  readonly balanceAfter: number;
  readonly test: TestSummary;
}

describe('enrollment over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  let admin!: Person;
  let editor!: Person;
  let exam = '';
  let subject = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('enrollments');

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
    editor = await makePerson('EDITOR', ['content.write', 'tests.write'], admin.id);

    const category = await db.client.examCategory.create({
      data: { name: 'Enrollment Category', slug: `enr-cat-${randomUUID().slice(0, 8)}`, createdBy: admin.id },
      select: { id: true },
    });

    exam = (
      await db.client.exam.create({
        data: {
          categoryId: category.id,
          name: 'Enrollment Exam',
          slug: `enr-exam-${randomUUID().slice(0, 8)}`,
          createdBy: editor.id,
        },
        select: { id: true },
      })
    ).id;

    subject = (
      await db.client.subject.create({
        data: {
          examId: exam,
          name: 'Reasoning',
          slug: `enr-sub-${randomUUID().slice(0, 8)}`,
          createdBy: editor.id,
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

  // -------------------------------------------------------------------------
  // The harness
  // -------------------------------------------------------------------------

  function call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    token: string | null,
    options: { readonly payload?: Record<string, unknown>; readonly key?: string } = {},
  ) {
    const headers: Record<string, string> = {};
    if (token !== null) {
      headers.authorization = `Bearer ${token}`;
    }
    if (options.key !== undefined) {
      headers['idempotency-key'] = options.key;
    }

    return app.inject({
      method,
      url,
      headers,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
  }

  function enroll(student: Person, testId: string, key: string, payload: Record<string, unknown> = {}) {
    return call('POST', `/v1/tests/${testId}/enroll`, student.token, { payload, key });
  }

  async function makePerson(
    roleCode: 'USER' | 'EDITOR' | 'ADMIN',
    permissions: readonly string[],
    grantedBy: string | null,
  ): Promise<Person> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `p6-enroll-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Enrollment Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    for (const code of permissions) {
      const permission = await db.client.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      await db.client.userPermission.create({ data: { userId: user.id, permissionId: permission.id, grantedBy } });
    }

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  /** A 64-hex fingerprint, the shape `coin_transactions_fingerprint_format` requires. */
  function fingerprint(): string {
    return randomUUID().replace(/-/g, '').repeat(2);
  }

  /** Tops a wallet up through the ledger, so the balance is never posted by a statement. */
  async function fund(person: Person, coins: number): Promise<number> {
    const wallet = await db.client.coinWallet.upsert({
      where: { userId: person.id },
      create: { userId: person.id, balance: 0 },
      update: {},
      select: { balance: true },
    });

    if (coins <= 0) {
      return wallet.balance;
    }

    const next = wallet.balance + coins;
    await db.client.coinTransaction.create({
      data: {
        userId: person.id,
        type: 'ADMIN_CREDIT',
        amount: coins,
        previousBalance: wallet.balance,
        newBalance: next,
        idempotencyKey: `fund:${randomUUID()}`,
        requestFingerprint: fingerprint(),
      },
    });

    return next;
  }

  async function balanceOf(person: Person): Promise<number> {
    const wallet = await db.client.coinWallet.findUnique({ where: { userId: person.id }, select: { balance: true } });
    return wallet?.balance ?? 0;
  }

  async function ledgerRows(person: Person): Promise<number> {
    return db.client.coinTransaction.count({ where: { userId: person.id, type: 'ENROLLMENT' } });
  }

  async function enrollmentRows(person: Person): Promise<number> {
    return db.client.enrollment.count({ where: { userId: person.id } });
  }

  async function newQuestion(owner: Person): Promise<string> {
    const question = await db.client.question.create({
      data: { examId: exam, subjectId: subject, createdBy: owner.id, status: 'PUBLISHED', currentVersion: 1 },
      select: { id: true },
    });

    await db.client.questionVersion.create({
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
        createdBy: owner.id,
        publishedAt: null,
        options: {
          create: [
            { position: 1, optionHtml: '<p>4</p>', isCorrect: false },
            { position: 2, optionHtml: '<p>7</p>', isCorrect: true },
            { position: 3, optionHtml: '<p>9</p>', isCorrect: false },
          ],
        },
      },
    });

    // Written unpublished, then published: `question_options_frozen` refuses an option insert
    // into a version whose `published_at` is already set.
    await db.client.questionVersion.update({
      where: { questionId_version: { questionId: question.id, version: 1 } },
      data: { publishedAt: new Date() },
    });

    return question.id;
  }

  async function createPaper(maxAttempts: number | null | undefined = undefined): Promise<string> {
    const created = await call('POST', '/v1/editor/tests', editor.token, {
      payload: { examId: exam, title: `Paper ${randomUUID().slice(0, 8)}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const patched = await call('PATCH', `/v1/editor/tests/${id}`, editor.token, {
      payload: {
        durationMinutes: 45,
        marksPerQuestion: '2',
        negativeMarksPerQuestion: '0.5',
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const questionIds = [await newQuestion(editor), await newQuestion(editor)];
    const ordered = await call('PUT', `/v1/editor/tests/${id}/questions`, editor.token, { payload: { questionIds } });
    expect(ordered.statusCode, ordered.body).toBe(200);

    return id;
  }

  async function submittedPaper(maxAttempts: number | null | undefined = undefined): Promise<string> {
    const id = await createPaper(maxAttempts);
    const submitted = await call('POST', `/v1/editor/tests/${id}/submit`, editor.token);
    expect(submitted.statusCode, submitted.body).toBe(200);
    return id;
  }

  async function publishedPaper(maxAttempts: number | null | undefined = undefined): Promise<string> {
    const id = await submittedPaper(maxAttempts);
    const published = await call('POST', `/v1/admin/tests/${id}/publish`, admin.token);
    expect(published.statusCode, published.body).toBe(200);
    return id;
  }

  /** Upserts a setting and fails if the value did not land, like the e2e fixture. */
  async function setSetting(key: string, value: number): Promise<void> {
    await db.client.setting.update({ where: { key }, data: { valueInt: value } });
    const row = await db.client.setting.findUniqueOrThrow({ where: { key }, select: { valueInt: true } });
    expect(row.valueInt, `the ${key} setting did not take ${String(value)}`).toBe(value);
  }

  // -------------------------------------------------------------------------
  // The rules
  // -------------------------------------------------------------------------

  it('enrolls once: one debit, one OPEN row, and no forbidden field in any answer', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testId = await publishedPaper();

    const response = await enroll(student, testId, `one-${randomUUID()}`);
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as EnrollmentView;

    expect(response.headers['content-type']).toContain('application/json');
    expect(body.testId).toBe(testId);
    expect(body.status).toBe('OPEN');
    expect(body.attemptNumber).toBe(1);
    expect(body.completedAt).toBeNull();
    expect(body.cost).toBe(100);
    expect(body.balanceAfter).toBe(900);
    expect(body.test.id).toBe(testId);
    expect(body.test.exam.id).toBe(exam);
    expect(body.test.durationMinutes).toBe(45);
    expect(body.test.questionCount).toBe(2);
    expect(body.test.totalMarks).toBe('4.00');
    expect(body.test.marksPerQuestion).toBe('2');
    expect(body.test.negativeMarksPerQuestion).toBe('0.5');
    expect(body.test.cost).toBe(100);

    expect(await balanceOf(student)).toBe(900);

    const ledger = await db.client.coinTransaction.findMany({ where: { userId: student.id, type: 'ENROLLMENT' } });
    expect(ledger).toHaveLength(1);
    const entry = ledger[0];
    expect(entry?.amount).toBe(-100);
    expect(entry?.previousBalance).toBe(1000);
    expect(entry?.newBalance).toBe(900);
    expect(entry?.referenceType).toBe('enrollment');
    expect(entry?.referenceId).toBe(body.id);
    expect(entry?.idempotencyKey).toMatch(/^enroll:/);
    expect(entry?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const rows = await db.client.enrollment.findMany({ where: { userId: student.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('OPEN');
    expect(rows[0]?.testVersionId).toBe(body.testVersionId);
    expect(rows[0]?.coinTransactionId).toBe(entry?.id);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'ENROLLMENT_CREATED', entityId: body.id },
      select: { actorUserId: true },
    });
    expect(audit?.actorUserId).toBe(student.id);

    // The catalog, the paper and my own list all sell the same thing and show my state.
    const catalog = await call('GET', '/v1/tests', student.token);
    expect(catalog.statusCode, catalog.body).toBe(200);
    const page = catalog.json() as CatalogPage;
    const listed = page.items.find((item) => item.id === testId);
    expect(listed?.cost).toBe(100);
    expect(listed?.enrollment).toEqual({
      status: 'OPEN',
      attemptNumber: 1,
      enrollmentId: body.id,
      attemptsUsed: 1,
    });

    const detail = await call('GET', `/v1/tests/${testId}`, student.token);
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as CatalogItem).enrollment.status).toBe('OPEN');

    const mine = await call('GET', '/v1/enrollments/me', student.token);
    expect(mine.statusCode, mine.body).toBe(200);
    const mineBody = mine.json() as { items: EnrollmentView[]; total: number };
    expect(mineBody.total).toBe(1);
    expect(mineBody.items[0]?.id).toBe(body.id);

    // Nothing a student may not see, in any of the four answers.
    for (const raw of [response.body, catalog.body, detail.body, mine.body]) {
      for (const forbidden of [
        'isCorrect',
        'explanationHtml',
        'answerKey',
        'createdBy',
        'userId',
        'idempotencyKey',
        'coinTransactionId',
        'requestFingerprint',
      ]) {
        expect(raw).not.toContain(forbidden);
      }
    }
  });

  it('replays one Idempotency-Key: one debit, one row, and the same answer', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testA = await publishedPaper();
    const testB = await publishedPaper();
    const key = `replay-${randomUUID()}`;

    const first = await enroll(student, testA, key);
    const second = await enroll(student, testA, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json()).toEqual(first.json());

    // The same key from two tabs at the same moment, on a second paper.
    const raceKey = `race-${randomUUID()}`;
    const [left, right] = await Promise.all([enroll(student, testB, raceKey), enroll(student, testB, raceKey)]);
    expect(left.statusCode, left.body).toBe(201);
    expect(right.statusCode, right.body).toBe(201);
    expect((left.json() as EnrollmentView).id).toBe((right.json() as EnrollmentView).id);
    expect(right.json()).toEqual(left.json());

    expect(await enrollmentRows(student)).toBe(2);
    expect(await ledgerRows(student)).toBe(2);
    expect(await balanceOf(student)).toBe(800);

    // The key already spent on test A is a conflict on test B, and writes nothing.
    const reused = await enroll(student, testB, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().message).toMatch(/already used for another test/);
    expect(await enrollmentRows(student)).toBe(2);
    expect(await balanceOf(student)).toBe(800);
  });

  it('gives exactly one winner when two different keys race for one paper', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testId = await publishedPaper();

    const [left, right] = await Promise.all([
      enroll(student, testId, `left-${randomUUID()}`),
      enroll(student, testId, `right-${randomUUID()}`),
    ]);

    const statuses = [left.statusCode, right.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    expect(await balanceOf(student)).toBe(900);
    expect(await ledgerRows(student)).toBe(1);
    expect(await enrollmentRows(student)).toBe(1);
  });

  it('spends the last coins once when two papers race for one wallet', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 100);
    const first = await publishedPaper();
    const second = await publishedPaper();

    const outcomes = await Promise.all([
      enroll(student, first, `a-${randomUUID()}`),
      enroll(student, second, `b-${randomUUID()}`),
    ]);

    const accepted = outcomes.filter((outcome) => outcome.statusCode === 201);
    const refused = outcomes.filter((outcome) => outcome.statusCode === 400);
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.json().message).toMatch(/Not enough coins/);

    expect(await balanceOf(student)).toBe(0);
    expect(await ledgerRows(student)).toBe(1);
    expect(await enrollmentRows(student)).toBe(1);
  });

  it('refuses an unaffordable enrollment and writes nothing', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 50);
    const testId = await publishedPaper();

    const response = await enroll(student, testId, `poor-${randomUUID()}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/Not enough coins/);

    expect(await balanceOf(student)).toBe(50);
    expect(await ledgerRows(student)).toBe(0);
    expect(await enrollmentRows(student)).toBe(0);
  });

  it('blocks a second enrollment while one is open, and a retake after completion pays again', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testId = await publishedPaper();

    const first = await enroll(student, testId, `first-${randomUUID()}`);
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json() as EnrollmentView;

    const blocked = await enroll(student, testId, `second-${randomUUID()}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toMatch(/open enrollment/);
    expect(await enrollmentRows(student)).toBe(1);
    expect(await balanceOf(student)).toBe(900);

    // The attempt engine (phase 7) is what closes an attempt; here the row is closed directly
    // so the retake rule can be proved now.
    await db.client.enrollment.update({
      where: { id: firstBody.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const retake = await enroll(student, testId, `third-${randomUUID()}`);
    expect(retake.statusCode, retake.body).toBe(201);
    const retakeBody = retake.json() as EnrollmentView;
    expect(retakeBody.attemptNumber).toBe(2);
    expect(retakeBody.balanceAfter).toBe(800);

    const old = await db.client.enrollment.findUniqueOrThrow({ where: { id: firstBody.id } });
    expect(old.status).toBe('COMPLETED');
    expect(old.coinTransactionId).not.toBe('');
    expect(old.testVersionId).toBe(firstBody.testVersionId);

    expect(await enrollmentRows(student)).toBe(2);
    expect(await ledgerRows(student)).toBe(2);
    expect(await balanceOf(student)).toBe(800);
  });

  it('refuses a retake once the paper’s attempt cap is reached', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testId = await publishedPaper(1);

    const first = await enroll(student, testId, `cap-1-${randomUUID()}`);
    expect(first.statusCode, first.body).toBe(201);

    await db.client.enrollment.update({
      where: { id: (first.json() as EnrollmentView).id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const again = await enroll(student, testId, `cap-2-${randomUUID()}`);
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toMatch(/allows 1 attempt/);
    expect(await enrollmentRows(student)).toBe(1);
    expect(await balanceOf(student)).toBe(900);
  });

  it('refuses a suspended account and a paper that is not for sale, writing nothing', async () => {
    const suspended = await makePerson('USER', [], null);
    await fund(suspended, 1000);
    const published = await publishedPaper();
    await db.client.user.update({ where: { id: suspended.id }, data: { status: 'SUSPENDED' } });

    // The guard refuses a suspended account's session before the handler: 401, not the
    // handler's 403, and nothing is read or written.
    const denied = await enroll(suspended, published, `susp-${randomUUID()}`);
    expect(denied.statusCode).toBe(401);
    expect(await enrollmentRows(suspended)).toBe(0);
    expect(await balanceOf(suspended)).toBe(1000);

    const student = await makePerson('USER', [], null);
    await fund(student, 1000);

    const draft = await createPaper();
    const onDraft = await enroll(student, draft, `draft-${randomUUID()}`);
    expect(onDraft.statusCode).toBe(409);
    expect(onDraft.json().message).toMatch(/not published yet/);

    const submitted = await submittedPaper();
    const onSubmitted = await enroll(student, submitted, `submitted-${randomUUID()}`);
    expect(onSubmitted.statusCode).toBe(409);
    expect(onSubmitted.json().message).toMatch(/not published yet/);

    const archived = await publishedPaper();
    const archiving = await call('POST', `/v1/admin/tests/${archived}/archive`, admin.token);
    expect(archiving.statusCode, archiving.body).toBe(200);

    const onArchived = await enroll(student, archived, `archived-${randomUUID()}`);
    expect(onArchived.statusCode).toBe(409);
    expect(onArchived.json().message).toMatch(/archived/);

    // An archived paper leaves the catalog, and its own page says it is not there.
    const catalog = await call('GET', '/v1/tests', student.token);
    const page = catalog.json() as CatalogPage;
    expect(page.items.map((item) => item.id)).not.toContain(archived);

    const detail = await call('GET', `/v1/tests/${archived}`, student.token);
    expect(detail.statusCode).toBe(404);

    expect(await enrollmentRows(student)).toBe(0);
    expect(await ledgerRows(student)).toBe(0);
    expect(await balanceOf(student)).toBe(1000);
  });

  it('takes no userId anywhere and insists on a well-formed Idempotency-Key', async () => {
    const student = await makePerson('USER', [], null);
    const other = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testId = await publishedPaper();

    const bodyUserId = await call('POST', `/v1/tests/${testId}/enroll`, student.token, {
      payload: { userId: other.id },
      key: `u-${randomUUID()}`,
    });
    expect(bodyUserId.statusCode).toBe(400);
    expect(bodyUserId.json().message).toMatch(/userId is never accepted/);

    const queryUserId = await call('POST', `/v1/tests/${testId}/enroll?userId=${other.id}`, student.token, {
      payload: {},
      key: `q-${randomUUID()}`,
    });
    expect(queryUserId.statusCode).toBe(400);
    expect(queryUserId.json().message).toMatch(/userId is never accepted/);

    const extraField = await call('POST', `/v1/tests/${testId}/enroll`, student.token, {
      payload: { testId: other.id },
      key: `x-${randomUUID()}`,
    });
    expect(extraField.statusCode).toBe(400);

    const missingKey = await call('POST', `/v1/tests/${testId}/enroll`, student.token, { payload: {} });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().message).toMatch(/Idempotency-Key header is required/);

    const malformedKey = await call('POST', `/v1/tests/${testId}/enroll`, student.token, { payload: {}, key: 'short' });
    expect(malformedKey.statusCode).toBe(400);

    const anonymous = await call('POST', `/v1/tests/${testId}/enroll`, null, {
      payload: {},
      key: `anon-${randomUUID()}`,
    });
    expect(anonymous.statusCode).toBe(401);

    // The read routes refuse a userId, an unknown filter and a page size past the cap.
    expect((await call('GET', `/v1/tests?userId=${other.id}`, student.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/tests?limit=1', student.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/tests?pageSize=999', student.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/tests?page=abc', student.token)).statusCode).toBe(400);
    expect((await call('GET', `/v1/enrollments/me?userId=${other.id}`, student.token)).statusCode).toBe(400);
    expect((await call('GET', '/v1/tests', null)).statusCode).toBe(401);
    expect((await call('GET', '/v1/enrollments/me', null)).statusCode).toBe(401);

    expect(await enrollmentRows(student)).toBe(0);
    expect(await ledgerRows(student)).toBe(0);
    expect(await balanceOf(student)).toBe(1000);
  });

  it('names every refusal with a stable code beside its unchanged message', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);

    const testId = await publishedPaper(1);
    const key = `codes-${randomUUID()}`;

    const first = await enroll(student, testId, key);
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json() as EnrollmentView;

    // A second attempt at a paper whose first attempt is still open.
    const blocked = await enroll(student, testId, `codes-open-${randomUUID()}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'open_enrollment' });
    expect(blocked.json().message).toMatch(/open enrollment/);

    // The key that paid for the first paper, offered for another one.
    const other = await publishedPaper();
    const reused = await enroll(student, other, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'key_reused' });
    expect(reused.json().message).toMatch(/already used for another test/);

    // The paper's one attempt is spent once its open row is closed.
    await db.client.enrollment.update({
      where: { id: firstBody.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    const capped = await enroll(student, testId, `codes-cap-${randomUUID()}`);
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toMatchObject({ code: 'attempt_cap_reached' });
    expect(capped.json().message).toMatch(/allows 1 attempt/);

    // A paper that cannot be bought yet, and one that has been withdrawn.
    const draft = await createPaper();
    const onDraft = await enroll(student, draft, `codes-draft-${randomUUID()}`);
    expect(onDraft.statusCode).toBe(409);
    expect(onDraft.json()).toMatchObject({ code: 'not_for_sale' });
    expect(onDraft.json().message).toMatch(/not published yet/);

    const archived = await publishedPaper();
    const archiving = await call('POST', `/v1/admin/tests/${archived}/archive`, admin.token);
    expect(archiving.statusCode, archiving.body).toBe(200);

    const onArchived = await enroll(student, archived, `codes-archived-${randomUUID()}`);
    expect(onArchived.statusCode).toBe(409);
    expect(onArchived.json()).toMatchObject({ code: 'not_for_sale' });
    expect(onArchived.json().message).toMatch(/archived/);

    // The refusal a 400 shares with a malformed request: the price.
    const poor = await makePerson('USER', [], null);
    await fund(poor, 50);
    const affordable = await publishedPaper();

    const broke = await enroll(poor, affordable, `codes-poor-${randomUUID()}`);
    expect(broke.statusCode).toBe(400);
    expect(broke.json()).toMatchObject({ code: 'insufficient_coins' });
    expect(broke.json().message).toMatch(/Not enough coins/);

    // The other 400 carries no code at all, so a screen can never mistake a malformed body for
    // a student who is short of coins.
    const malformed = await call('POST', `/v1/tests/${testId}/enroll`, student.token, {
      payload: { testId },
      key: `codes-malformed-${randomUUID()}`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).toBeUndefined();

    // Every refusal above left the wallets and the rows exactly where they were.
    expect(await balanceOf(student)).toBe(900);
    expect(await ledgerRows(student)).toBe(1);
    expect(await enrollmentRows(student)).toBe(1);
    expect(await balanceOf(poor)).toBe(50);
    expect(await ledgerRows(poor)).toBe(0);
    expect(await enrollmentRows(poor)).toBe(0);
  });

  it('charges the price the setting names, read at enrollment time', async () => {
    const student = await makePerson('USER', [], null);
    await fund(student, 1000);
    const testId = await publishedPaper();

    await setSetting(PRICE_SETTING, 150);
    try {
      const response = await enroll(student, testId, `price-${randomUUID()}`);
      expect(response.statusCode, response.body).toBe(201);
      const body = response.json() as EnrollmentView;
      expect(body.cost).toBe(150);
      expect(body.balanceAfter).toBe(850);
      expect(body.test.cost).toBe(150);

      const ledger = await db.client.coinTransaction.findMany({ where: { userId: student.id, type: 'ENROLLMENT' } });
      expect(ledger[0]?.amount).toBe(-150);
      expect(await balanceOf(student)).toBe(850);
    } finally {
      // The setting is restored and re-read, so the next test file's default is untouched.
      await setSetting(PRICE_SETTING, 100);
    }
  });
});
