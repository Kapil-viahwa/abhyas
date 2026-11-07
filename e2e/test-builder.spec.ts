import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { setCoinSetting } from './coin-settings';
import { seedBuilderFixture } from './tests-fixture';

/**
 * The test builder in a browser (phase 6, P3): an editor holding `manage_tests` assembles a
 * paper from the bank, orders it, submits it; an Administrator publishes it; an editor never
 * sees the publish control and the publish route refuses one; a Student cannot reach the pages
 * or use the routes.
 *
 * This file sorts after `admin-operations`/`admin` and before `wallet` in the chromium project
 * (one worker, files in order). It pins `signup_coins` for its own registration and leaves the
 * platform default behind, so the wallet spec that follows starts where it expects to.
 *
 * The bank and the exam are seeded by `./tests-fixture` because the builder spec is about the
 * test screens, not about authoring questions through the TipTap editor. Both are owned by the
 * editor, which is what the API requires of an editor's own paper.
 */

const ADMIN_EMAIL = 'e2e-admin@example.com';
const ADMIN_LOGIN = 'administrator-9pass';
const EDITOR_LOGIN = 'builder-editor-9pass';
const STUDENT_LOGIN = 'student-9login-ok';

/** This spec's own source address, so its sign-ins do not share a rate-limit counter. */
const CLIENT_IP = '198.18.0.77';
const CLIENT = { extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } };

test.use(CLIENT);

const marker = randomUUID().slice(0, 8);
const editorEmail = `e2e-builder-editor-${marker}@example.com`;
const studentEmail = `e2e-builder-student-${marker}@example.com`;
const examName = `E2E Builder Category ${marker} · E2E Builder Exam ${marker}`;
const paperTitle = `E2E Builder Paper ${marker}`;
const alphaText = `Alpha builder question ${marker}`;
const betaText = `Beta builder question ${marker}`;

/** The paper the first test creates, used by the rest. */
let testId = '';

/** One of the fixture's published questions, for the question-editor check. */
let alphaQuestionId = '';

let adminSeeded = false;

function seedAdmin(): void {
  if (adminSeeded) {
    return;
  }

  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      '-e',
      `SEED_ADMIN_EMAIL=${ADMIN_EMAIL}`,
      '-e',
      `SEED_ADMIN_PASSWORD=${ADMIN_LOGIN}`,
      'api',
      'node',
      'apps/api/dist/seed/cli.js',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );

  adminSeeded = true;
}

function apiLogs(): string {
  return execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function waitForLink(after: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000;
  const searchable = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);

  while (Date.now() < deadline) {
    const logs = apiLogs();
    const start = logs.indexOf(after);
    const fresh = start >= 0 ? logs.slice(start + after.length) : logs;
    const match = [...fresh.matchAll(searchable)].at(-1);
    if (match?.[1] !== undefined) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`No mail link matching ${String(pattern)} appeared in the API log`);
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

async function registerStudent(browser: Browser, email: string): Promise<void> {
  const context = await browser.newContext(CLIENT);
  const page = await context.newPage();

  await page.goto('/register');
  await page.fill('input[name="fullName"]', 'Builder E2E Student');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', STUDENT_LOGIN);

  const before = apiLogs();
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/verify-email\?sent=1/);

  const token = await waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/);
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();

  await context.close();
}

test.beforeAll(() => {
  setCoinSetting('signup_coins', 1_000);
});

test.afterAll(() => {
  // The platform default, so the wallet spec that follows reads what it pins itself.
  setCoinSetting('signup_coins', 1_000);
  setCoinSetting('daily_reward_coins', 10);
});

test.describe.serial('the test builder', () => {
  test('an editor with manage-tests builds, orders and submits a paper', async ({ page, browser }) => {
    test.setTimeout(180_000);
    seedAdmin();

    // An Administrator creates the editor through the screens, with manage-tests only.
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await page.goto('/admin/users/new');
    await page.fill('input[name="fullName"]', 'Builder E2E Editor');
    await page.fill('input[name="email"]', editorEmail);
    await page.fill('input[name="password"]', EDITOR_LOGIN);
    await page.check('input[name="manage_tests"]');
    await page.getByRole('button', { name: 'Create editor' }).click();
    await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]+\?created=1/);

    const editorId = new URL(page.url()).pathname.split('/').filter(Boolean).pop() ?? '';
    expect(editorId).not.toBe('');

    const seeded = seedBuilderFixture({ editorId, marker, alphaText, betaText });
    alphaQuestionId = seeded.alphaQuestionId;
    const context = await browser.newContext(CLIENT);
    const editor = await context.newPage();
    await signIn(editor, editorEmail, EDITOR_LOGIN);
    await expect(editor).toHaveURL(/\/editor$/);

    await editor.getByRole('link', { name: 'Open the tests' }).click();
    await expect(editor).toHaveURL(/\/editor\/tests$/);

    await editor.getByTestId('new-test').click();
    await expect(editor).toHaveURL(/\/editor\/tests\/new$/);
    await editor.getByTestId('new-test-title').fill(paperTitle);
    await editor.getByTestId('new-test-exam').selectOption({ label: examName });
    await editor.getByTestId('new-test-duration').fill('45');
    await editor.getByRole('button', { name: 'Create draft' }).click();

    await expect(editor).toHaveURL(/\/editor\/tests\/[0-9a-f-]+\?created=1/);
    testId = new URL(editor.url()).pathname.split('/').filter(Boolean).pop() ?? '';
    expect(testId).not.toBe('');
    await expect(editor.getByText('Draft created')).toBeVisible();
    await expect(editor.getByTestId('test-status')).toHaveText('draft');

    // The pattern.
    await editor.getByTestId('test-marks').fill('2');
    await editor.getByTestId('test-negative').fill('0.5');
    await editor.getByTestId('test-max-attempts').fill('3');
    await editor.getByTestId('save-pattern').click();
    await expect(editor).toHaveURL(/saved=1/);
    await expect(editor.getByText('Saved.')).toBeVisible();
    await expect(editor.getByTestId('test-duration')).toHaveValue('45');
    // The API returns the decimal as Prisma's text, so the scale may or may not be padded.
    await expect(editor.getByTestId('test-marks')).toHaveValue(/^2(\.00)?$/);
    await expect(editor.getByTestId('test-negative')).toHaveValue(/^0\.5(0)?$/);

    // Two published questions of this exam.
    const order = editor.getByTestId('question-order');
    for (const [index, text] of [alphaText, betaText].entries()) {
      const candidate = editor.getByTestId('question-candidate').filter({ hasText: text });
      await expect(candidate).toBeVisible();
      await candidate.getByTestId('add-question').click();
      // The paper's row count is the wait: the URL is already `?saved=1` after the first add,
      // so the URL alone would pass before the second navigation even started.
      await expect(order.getByTestId('paper-question')).toHaveCount(index + 1);
    }

    await expect(order.getByTestId('paper-question').first()).toContainText(alphaText);
    await expect(order.getByTestId('answer-key').first()).toContainText('Correct option: 2');

    // Move the first one down: the paper's order is the server's.
    await order.getByTestId('paper-question').first().getByTestId('move-down').click();
    await expect(editor.getByTestId('question-order').getByTestId('paper-question').first()).toContainText(betaText);

    await editor.getByTestId('submit-test').click();
    await expect(editor).toHaveURL(/submitted=1/);
    await expect(editor.getByTestId('test-status')).toHaveText('submitted');

    await context.close();
  });

  test('the editor has no publish control and the publish route refuses one', async ({ browser }) => {
    expect(testId).not.toBe('');

    const context = await browser.newContext(CLIENT);
    const editor = await context.newPage();
    await signIn(editor, editorEmail, EDITOR_LOGIN);

    await editor.goto(`/editor/tests/${testId}`);
    await expect(editor.getByTestId('test-status')).toHaveText('submitted');
    await expect(editor.getByTestId('publish-test')).toHaveCount(0);
    await expect(editor.getByTestId('archive-test')).toHaveCount(0);
    await expect(editor.getByTestId('submit-test')).toHaveCount(0);

    const csrf = (await context.cookies()).find((cookie) => cookie.name === 'abhyas_csrf')?.value ?? '';
    const refused = await editor.request.post(`/api/admin/tests/${testId}/publish`, {
      form: { csrfToken: csrf },
      headers: { origin: 'http://localhost:3000' },
      maxRedirects: 0,
    });

    expect(refused.status()).toBe(303);
    expect(decodeURIComponent(refused.headers()['location'] ?? '')).toContain('Insufficient permissions');
    expect(refused.headers()['location'] ?? '').not.toContain('published=1');

    // Nothing published: the API refused before the handler ran.
    await editor.goto(`/editor/tests/${testId}`);
    await expect(editor.getByTestId('test-status')).toHaveText('submitted');

    await context.close();
  });

  test('an administrator publishes the paper', async ({ page }) => {
    expect(testId).not.toBe('');

    seedAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);

    await page.goto('/admin/tests');
    const row = page.getByTestId('admin-test-list').locator('li').filter({ hasText: paperTitle });
    await expect(row.getByTestId('admin-test-status')).toHaveText('submitted');
    await row.getByRole('link', { name: 'Review' }).click();

    await expect(page.getByTestId('test-status')).toHaveText('submitted');
    await expect(page.getByTestId('publish-test')).toBeVisible();
    await page.getByTestId('publish-test').click();

    await expect(page).toHaveURL(/published=1/);
    await expect(page.getByTestId('test-status')).toHaveText('published');
    await expect(page.getByTestId('live-version')).toContainText('Live version 1');
    await expect(page.getByTestId('publish-test')).toHaveCount(0);
    await expect(page.getByTestId('archive-test')).toBeVisible();

    await page.goto('/admin/tests');
    await expect(
      page.getByTestId('admin-test-list').locator('li').filter({ hasText: paperTitle }).getByTestId('admin-test-status'),
    ).toHaveText('published');
  });

  test('a student reaches none of the pages and none of the routes', async ({ browser }) => {
    expect(testId).not.toBe('');

    await registerStudent(browser, studentEmail);

    const context = await browser.newContext(CLIENT);
    const student = await context.newPage();
    await signIn(student, studentEmail, STUDENT_LOGIN);
    await expect(student).toHaveURL(/\/account/);

    await student.goto('/editor/tests');
    await expect(student).toHaveURL(/\/account\?denied=1/);

    await student.goto(`/editor/tests/${testId}`);
    await expect(student).toHaveURL(/\/account\?denied=1/);

    await student.goto('/admin/tests');
    await expect(student).toHaveURL(/\/account\?denied=1/);

    const csrf = (await context.cookies()).find((cookie) => cookie.name === 'abhyas_csrf')?.value ?? '';
    const refused = await student.request.post(`/api/admin/tests/${testId}/archive`, {
      form: { csrfToken: csrf },
      headers: { origin: 'http://localhost:3000' },
      maxRedirects: 0,
    });

    expect(refused.status()).toBe(303);
    expect(refused.headers()['location'] ?? '').toContain('error=');
    expect(refused.headers()['location'] ?? '').not.toContain('archived=1');

    await context.close();
  });

  // The two question pages threw a server error between phase 4 and the catalog fix in
  // `316423a`: `catalogChoices` read a nested tree the API never sent, so both pages died
  // before they painted. The editor has no data-testid of its own, so the wait is on the
  // student-preview panel — the one test id the form carries — rather than a sleep.
  test('the question pages render for an editor', async ({ browser }) => {
    expect(alphaQuestionId).not.toBe('');

    const context = await browser.newContext(CLIENT);
    const editor = await context.newPage();
    await signIn(editor, editorEmail, EDITOR_LOGIN);

    await editor.goto('/editor/questions/new');
    await expect(editor).toHaveURL(/\/editor\/questions\/new$/);
    await expect(editor.getByRole('heading', { name: 'New question' })).toBeVisible();
    await expect(editor.getByTestId('question-preview')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Create draft' })).toBeVisible();

    await editor.goto(`/editor/questions/${alphaQuestionId}`);
    await expect(editor.getByRole('heading', { name: 'Edit question' })).toBeVisible();
    await expect(editor.getByTestId('question-preview')).toBeVisible();
    // The fixture's question is published, which only the API's own answer can say.
    await expect(editor.getByRole('button', { name: 'Already published' })).toBeVisible();

    await context.close();
  });
});
