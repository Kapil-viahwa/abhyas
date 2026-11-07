import { randomBytes, randomUUID } from 'node:crypto';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { SESSIONS_SERVICE, type SessionsService } from '../src/auth/sessions.service';
import { hashPassword } from '../src/auth/password';
import { RATE_LIMITS } from '../src/infra/rate-limiter';
import { imageLimiter, MAX_CONCURRENT_DECODES, MAX_QUEUED_DECODES } from '../src/media/image';
import { boundUploadBody, UPLOAD_BODY_LIMIT_BYTES, type RouteHookHost } from '../src/media/upload-limit';

import { createMigratedTestDatabase, type TestDatabase } from './support/database';

/**
 * Question authoring over real HTTP, against Postgres, the real guard and the real
 * in-memory object store the database job is configured with.
 *
 * The rules under test: content is sanitised on the server, the answer key is enforced,
 * a published version is frozen, and an editor only reaches what they created.
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

describe('questions and media over HTTP', () => {
  let db!: TestDatabase;
  let app!: NestFastifyApplication;
  let redis!: Redis;

  let editorA: { id: string; token: string };
  let editorB: { id: string; token: string };
  let admin: { id: string; token: string };
  let examId = '';
  let subjectId = '';
  let topicId = '';

  beforeAll(async () => {
    db = await createMigratedTestDatabase('questions');

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
    // The upload route gets the same per-route body limit the real entry point sets.
    boundUploadBody(app.getHttpAdapter().getInstance() as unknown as RouteHookHost);
    await app.init();
    await waitUntilHealthy(app);

    admin = await makePerson('ADMIN', false);
    editorA = await makePerson('EDITOR', true, admin.id);
    editorB = await makePerson('EDITOR', true, admin.id);

    const category = await db.client.examCategory.create({
      data: { name: 'Banking', slug: `banking-${randomUUID().slice(0, 6)}`, createdBy: admin.id },
      select: { id: true },
    });
    const exam = await db.client.exam.create({
      data: { categoryId: category.id, name: 'IBPS Clerk', slug: `ibps-${randomUUID().slice(0, 6)}`, createdBy: editorA.id },
      select: { id: true },
    });
    examId = exam.id;

    const subject = await db.client.subject.create({
      data: { examId, name: 'Reasoning', slug: 'reasoning', createdBy: editorA.id },
      select: { id: true },
    });
    subjectId = subject.id;

    const topic = await db.client.topic.create({
      data: { subjectId, name: 'Syllogism', slug: 'syllogism', createdBy: editorA.id },
      select: { id: true },
    });
    topicId = topic.id;
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

  async function makePerson(
    roleCode: 'USER' | 'EDITOR' | 'ADMIN',
    withFlags: boolean,
    grantedBy?: string,
  ): Promise<{ id: string; token: string }> {
    const role = await db.client.role.findUniqueOrThrow({ where: { code: roleCode }, select: { id: true } });
    const user = await db.client.user.create({
      data: {
        email: `q-${roleCode.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
        fullName: 'Question Person',
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    if (withFlags) {
      const codes = ['content.read', 'content.write', 'content.publish'];
      for (const code of codes) {
        const permission = await db.client.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
        // A person cannot grant themselves a permission (the database refuses it), so the
        // fixture records the administrator who would have granted it in the real flow.
        await db.client.userPermission.create({
          data: { userId: user.id, permissionId: permission.id, grantedBy: grantedBy ?? null },
        });
      }
    }

    const issued = await app.get<SessionsService>(SESSIONS_SERVICE).issue(user.id);
    return { id: user.id, token: issued.accessToken };
  }

  function call(method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: Record<string, unknown>) {
    const headers = { authorization: `Bearer ${token}` };
    return app.inject(payload === undefined ? { method, url, headers } : { method, url, headers, payload });
  }

  function mcq(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      examId,
      subjectId,
      topicId,
      questionType: 'MCQ',
      language: 'EN',
      difficulty: 'MEDIUM',
      contentHtml: '<p>Which of these is a prime?</p>',
      explanationHtml: '<p>Seven has no divisors.</p>',
      marks: 2,
      negativeMarks: '0.5',
      options: [
        { optionHtml: '<p>4</p>', isCorrect: false },
        { optionHtml: '<p>7</p>', isCorrect: true },
        { optionHtml: '<p>9</p>', isCorrect: false },
      ],
      ...overrides,
    };
  }

  it('neutralises XSS in the question text, options and explanation', async () => {
    const response = await call(
      'POST',
      '/v1/questions',
      editorA.token,
      mcq({
        contentHtml: '<p>Safe<script>alert("x")</script><img src=x onerror="alert(1)"> text</p>',
        explanationHtml: '<p onmouseover="alert(1)">Explanation</p><iframe src="https://evil"></iframe>',
        options: [
          { optionHtml: '<p>4</p>', isCorrect: false },
          { optionHtml: '<p><b>7</b><svg onload="alert(1)"></svg></p>', isCorrect: true },
        ],
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; version: { contentHtml: string; explanationHtml: string } };

    expect(body.version.contentHtml).not.toMatch(/script|onerror|iframe/i);
    expect(body.version.contentHtml).toContain('Safe');
    expect(body.version.explanationHtml ?? '').not.toMatch(/onmouseover|iframe/i);

    const stored = await db.client.questionVersion.findFirstOrThrow({
      where: { questionId: body.id },
      select: { contentHtml: true, explanationHtml: true, options: { select: { optionHtml: true } } },
    });

    expect(stored.contentHtml).not.toMatch(/<script|onerror/i);
    expect(stored.explanationHtml ?? '').not.toMatch(/onmouseover|iframe/i);
    expect(stored.options.map((option) => option.optionHtml).join(' ')).not.toMatch(/svg|onload/i);
  });

  it('refuses an answer key that is not exactly one correct option between two and six', async () => {
    const oneOption = await call('POST', '/v1/questions', editorA.token, mcq({
      options: [{ optionHtml: '<p>4</p>', isCorrect: true }],
    }));
    expect(oneOption.statusCode).toBe(400);

    const twoCorrect = await call('POST', '/v1/questions', editorA.token, mcq({
      options: [
        { optionHtml: '<p>4</p>', isCorrect: true },
        { optionHtml: '<p>7</p>', isCorrect: true },
      ],
    }));
    expect(twoCorrect.statusCode).toBe(400);
    expect(twoCorrect.json().message).toMatch(/exactly one correct/);

    const seven = Array.from({ length: 7 }, (_, index) => ({ optionHtml: `<p>${String(index)}</p>`, isCorrect: index === 0 }));
    const tooMany = await call('POST', '/v1/questions', editorA.token, mcq({ options: seven }));
    expect(tooMany.statusCode).toBe(400);
  });

  it('stores a numerical answer exactly and refuses options on it', async () => {
    const numeric = await call('POST', '/v1/questions', editorA.token, {
      examId,
      subjectId,
      topicId,
      questionType: 'NUMERICAL',
      language: 'HI',
      difficulty: 'HARD',
      contentHtml: '<p>12 × 12 = ?</p>',
      numericalAnswer: '144',
      marks: 1,
    });

    expect(numeric.statusCode).toBe(201);
    const body = numeric.json() as { id: string; options: unknown[]; version: { numericalAnswer: string; language: string } };
    expect(body.version.numericalAnswer).toBe('144');
    expect(body.version.language).toBe('HI');
    expect(body.options).toEqual([]);

    const withOptions = await call('POST', '/v1/questions', editorA.token, {
      examId,
      subjectId,
      questionType: 'NUMERICAL',
      numericalAnswer: '144',
      contentHtml: '<p>12 × 12 = ?</p>',
      options: [{ optionHtml: '<p>144</p>', isCorrect: true }],
    });
    expect(withOptions.statusCode).toBe(400);
  });

  it('stores an option LaTeX formula under the same limit as the question one', async () => {
    const created = await call('POST', '/v1/questions', editorA.token, {
      ...mcq(),
      options: [
        { optionHtml: '<p>144</p>', latex: '\\frac{12}{1}', isCorrect: true },
        { optionHtml: '<p>288</p>', isCorrect: false },
      ],
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { options: Array<{ latex: string | null; position: number }> };
    expect(body.options[0]?.latex).toBe('\\frac{12}{1}');
    expect(body.options[1]?.latex).toBeNull();

    // The same 4000-character ceiling, and the same sanitiser, as the question's own LaTeX.
    const tooLong = await call('POST', '/v1/questions', editorA.token, {
      ...mcq(),
      options: [
        { optionHtml: '<p>a</p>', latex: 'x'.repeat(4_001), isCorrect: true },
        { optionHtml: '<p>b</p>', isCorrect: false },
      ],
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().message).toMatch(/option 1 latex must be 4000 characters or fewer/);
  });

  it('creates a new draft version after publish, and a published version cannot be changed', async () => {
    const created = await call('POST', '/v1/questions', editorA.token, mcq());
    const id = (created.json() as { id: string }).id;

    const published = await call('POST', `/v1/questions/${id}/publish`, editorA.token);
    expect(published.statusCode).toBe(200);
    expect((published.json() as { status: string }).status).toBe('PUBLISHED');

    // Editing a published question produces version 2, still a draft.
    const saved = await call('PATCH', `/v1/questions/${id}`, editorA.token, mcq({ contentHtml: '<p>Corrected text</p>' }));
    expect(saved.statusCode).toBe(200);
    const afterEdit = saved.json() as { currentVersion: number; status: string; version: { contentHtml: string; publishedAt: string | null } };
    expect(afterEdit.currentVersion).toBe(2);
    expect(afterEdit.status).toBe('DRAFT');
    expect(afterEdit.version.publishedAt).toBeNull();

    // The published version itself is frozen by a database trigger.
    const publishedRow = await db.client.questionVersion.findFirstOrThrow({
      where: { questionId: id, version: 1 },
      select: { id: true },
    });
    await expect(
      db.client.questionVersion.update({ where: { id: publishedRow.id }, data: { contentHtml: '<p>tampered</p>' } }),
    ).rejects.toThrow(/published version cannot be updated/);
    await expect(db.client.questionVersion.delete({ where: { id: publishedRow.id } })).rejects.toThrow(
      /published version cannot be deleted/,
    );
  });

  it('refuses a foreign question, its publish and its edit, and lets the administrator through', async () => {
    const created = await call('POST', '/v1/questions', editorA.token, mcq());
    const id = (created.json() as { id: string }).id;

    const read = await call('GET', `/v1/questions/${id}`, editorB.token);
    expect(read.statusCode).toBe(404);

    const edit = await call('PATCH', `/v1/questions/${id}`, editorB.token, mcq());
    expect(edit.statusCode).toBe(404);

    const publish = await call('POST', `/v1/questions/${id}/publish`, editorB.token);
    expect(publish.statusCode).toBe(404);

    const asAdmin = await call('GET', `/v1/questions/${id}`, admin.token);
    expect(asAdmin.statusCode).toBe(200);

    const adminPublish = await call('POST', `/v1/questions/${id}/publish`, admin.token);
    expect(adminPublish.statusCode).toBe(200);
  });

  it('lists only my own questions for an editor, and filters and pages for an administrator', async () => {
    await call('POST', '/v1/questions', editorA.token, mcq({ contentHtml: '<p>Searchable alpha question</p>' }));

    const mine = await call('GET', '/v1/questions?search=Searchable', editorA.token);
    expect(mine.statusCode).toBe(200);
    const mineBody = mine.json() as { items: Array<{ createdBy: string }>; total: number };
    expect(mineBody.total).toBeGreaterThan(0);
    expect(mineBody.items.every((item) => item.createdBy === editorA.id)).toBe(true);

    const theirs = await call('GET', '/v1/questions?search=Searchable', editorB.token);
    expect((theirs.json() as { total: number }).total).toBe(0);

    const filtered = await call('GET', `/v1/questions?difficulty=HARD&page=1`, admin.token);
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json() as { items: Array<{ version: { difficulty: string } }> };
    expect(filteredBody.items.every((item) => item.version.difficulty === 'HARD')).toBe(true);
  });

  it('exports CSV and audits the export', async () => {
    const response = await call('GET', '/v1/questions/export', editorA.token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const lines = response.body.split('\n');
    expect(lines[0]).toContain('question_id');
    expect(lines.length).toBeGreaterThan(1);

    const audit = await db.client.auditLog.findFirst({
      where: { action: 'QUESTIONS_EXPORTED', actorUserId: editorA.id },
    });
    expect(audit).not.toBeNull();
  });

  it('uploads an image through the pipeline and hands back a short-lived URL', async () => {
    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();

    const upload = await call('POST', '/v1/media/images', editorA.token, { dataBase64: png.toString('base64') });
    expect(upload.statusCode).toBe(201);
    const asset = upload.json() as { id: string; width: number; height: number };

    expect(asset.width).toBe(30);
    expect(asset.height).toBe(20);

    const url = await call('GET', `/v1/media/images/${asset.id}/url`, editorA.token);
    expect(url.statusCode).toBe(200);
    expect((url.json() as { url: string }).url).toContain('question-image/');
    expect((url.json() as { expiresInSeconds: number }).expiresInSeconds).toBe(300);

    // Somebody else cannot ask for a signed URL, and a student cannot upload at all.
    const foreign = await call('GET', `/v1/media/images/${asset.id}/url`, editorB.token);
    expect(foreign.statusCode).toBe(404);

    const student = await makePerson('USER', false);
    const denied = await call('POST', '/v1/media/images', student.token, { dataBase64: png.toString('base64') });
    expect(denied.statusCode).toBe(403);
  });

  it('refuses a renamed executable upload', async () => {
    const exe = Buffer.from('MZ' + '\u0090'.repeat(2048), 'binary');

    const response = await call('POST', '/v1/media/images', editorA.token, { dataBase64: exe.toString('base64') });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/JPEG, PNG and WebP/);
  });

  it('reads the bytes, never the name or content type the client claims', async () => {
    const exe = Buffer.from('MZ' + '\u0090'.repeat(2048), 'binary');

    // A double extension and a content type that lies: neither reaches the decision.
    const lie = await call('POST', '/v1/media/images', editorA.token, {
      dataBase64: exe.toString('base64'),
      fileName: 'diagram.png',
      mimeType: 'image/png',
    });
    expect(lie.statusCode).toBe(400);
    expect(lie.json().message).toMatch(/JPEG, PNG and WebP/);

    // The same in reverse: a real image with an alarming name and type is accepted, and
    // stored under a key the server generated.
    const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer();

    const accepted = await call('POST', '/v1/media/images', editorA.token, {
      dataBase64: png.toString('base64'),
      fileName: 'notes.exe',
      mimeType: 'application/x-msdownload',
    });
    expect(accepted.statusCode).toBe(201);

    const body = accepted.json() as { id: string; width: number; height: number };
    // The response describes the stored asset; no image bytes travel back.
    expect(Object.keys(body).sort()).toEqual(['byteSize', 'createdAt', 'height', 'id', 'width']);

    const stored = await db.client.mediaAsset.findUniqueOrThrow({
      where: { id: body.id },
      select: { objectKey: true, mimeType: true },
    });
    expect(stored.objectKey).toMatch(/^question-image\/[0-9a-f-]{36}\.webp$/);
    expect(stored.objectKey).not.toContain('notes');
    expect(stored.mimeType).toBe('image/webp');
  });

  it('stops reading an oversized upload at its own limit, and takes a normal photograph', async () => {
    // Every other route accepts 1 MB. The upload route takes a base64 image, so it has its
    // own limit and Fastify answers 413 instead of buffering a body it will refuse.
    const oversize = 'A'.repeat(UPLOAD_BODY_LIMIT_BYTES + 1_048_576);

    const refused = await call('POST', '/v1/media/images', editorA.token, { dataBase64: oversize });
    expect(refused.statusCode).toBe(413);

    // A 1.5 MB image is an ordinary upload, and its base64 envelope is larger than the
    // general limit, which is exactly what the route's own limit is for.
    const noise = randomBytes(700 * 700 * 3);
    const big = await sharp(noise, { raw: { width: 700, height: 700, channels: 3 } }).png().toBuffer();
    expect(big.length).toBeGreaterThan(1_048_576);

    const accepted = await call('POST', '/v1/media/images', editorA.token, { dataBase64: big.toString('base64') });
    expect(accepted.statusCode).toBe(201);
    expect((accepted.json() as { width: number }).width).toBe(700);
  });

  it('answers 503 with Retry-After when the decode queue is full', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();

    // Fill every slot the limiter has: the running decodes and the whole waiting queue.
    const releases: Array<() => void> = [];
    const held = Array.from({ length: MAX_CONCURRENT_DECODES + MAX_QUEUED_DECODES }, () =>
      imageLimiter.run(
        () =>
          new Promise<void>((resolve) => {
            releases.push(() => resolve());
          }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const refused = await call('POST', '/v1/media/images', editorA.token, { dataBase64: png.toString('base64') });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers['retry-after']).toBe('1');

    // Drain the queue: releasing a running decode lets the next queued one start, which
    // pushes its own release, until every held job has settled and the limiter is empty.
    while (imageLimiter.running > 0 || imageLimiter.queued > 0) {
      const pending = releases.shift();
      if (pending === undefined) {
        break;
      }
      pending();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(held);

    // Once the queue drains the same request is accepted again.
    const accepted = await call('POST', '/v1/media/images', editorA.token, { dataBase64: png.toString('base64') });
    expect(accepted.statusCode).toBe(201);
  });

  it('meters uploads per account and answers 429 once the window is spent', async () => {
    const limitedEditor = await makePerson('EDITOR', true, admin.id);
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#0f0' } })
      .png()
      .toBuffer();
    const limit = RATE_LIMITS.mediaUploadPerUser.limit;

    for (let attempt = 0; attempt < limit; attempt += 1) {
      const accepted = await call('POST', '/v1/media/images', limitedEditor.token, { dataBase64: png.toString('base64') });
      expect(accepted.statusCode, `upload ${String(attempt + 1)} of ${String(limit)}`).toBe(201);
    }

    const refused = await call('POST', '/v1/media/images', limitedEditor.token, { dataBase64: png.toString('base64') });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('60');

    // A different editor has their own window.
    const other = await call('POST', '/v1/media/images', editorA.token, { dataBase64: png.toString('base64') });
    expect(other.statusCode).toBe(201);
  });

  it('refuses an image that belongs to another editor, and stores the reference to its own', async () => {
    const logo = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#654321' } })
      .png()
      .toBuffer();

    const upload = await call('POST', '/v1/media/images', editorA.token, { dataBase64: logo.toString('base64') });
    expect(upload.statusCode).toBe(201);
    const assetId = (upload.json() as { id: string }).id;

    const content = `<p>See the diagram</p><img data-media-id="${assetId}">`;

    // Editor B cannot point a question at editor A's upload.
    const foreign = await call('POST', '/v1/questions', editorB.token, mcq({ contentHtml: content }));
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().message).toMatch(/not available to you/);

    // An id that does not exist is refused with the same words, so the route cannot be
    // used to discover which images exist.
    const invented = await call(
      'POST',
      '/v1/questions',
      editorB.token,
      mcq({ contentHtml: `<p>See the diagram</p><img data-media-id="${randomUUID()}">` }),
    );
    expect(invented.statusCode).toBe(400);
    expect(invented.json().message).toMatch(/not available to you/);

    // The owner may use it, and the stored markup keeps the reference and nothing else.
    const mine = await call('POST', '/v1/questions', editorA.token, mcq({ contentHtml: content }));
    expect(mine.statusCode).toBe(201);
    const storedContent = (mine.json() as { version: { contentHtml: string } }).version.contentHtml;
    expect(storedContent).toContain(`data-media-id="${assetId}"`);
    expect(storedContent).not.toContain('src=');
  });
});
