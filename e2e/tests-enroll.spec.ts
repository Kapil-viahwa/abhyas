import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { setCoinSetting } from './coin-settings';
import { publishSeededPaper, seedAuthor, seedBuilderFixture } from './tests-fixture';

/**
 * The student catalog and enrollment (phase 6, P5).
 *
 * The paper is seeded in SQL beside its bank (`./tests-fixture`), the same route the builder
 * spec uses for its exam, because this file is about the student's screens and not about
 * authoring one. Two students are registered through the real form, so the grant, the debit and
 * the history are the stack's own. Every setting this file reads is pinned with the
 * upsert-and-verify fixture and restored afterwards: the e2e stack is one database shared by
 * every spec of the run (one worker, files in order).
 */

const PASSWORD = 'correct-horse-9battery';
const CLIENT_IP = '198.18.0.31';
const CLIENT = { extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } };

test.use(CLIENT);

const marker = randomUUID().slice(0, 8);
const titleA = `Catalog Paper A ${marker}`;
const titleB = `Catalog Paper B ${marker}`;

let testA = '';
let testB = '';
let studentEmail = '';

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

  throw new Error(`No mail link matching ${String(pattern)} appeared in the mail log`);
}

async function registerStudent(page: Page, email: string, fullName: string): Promise<void> {
  await page.goto('/register');
  await page.fill('input[name="fullName"]', fullName);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);

  const before = apiLogs();
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/verify-email\?sent=1/);

  const token = await waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/);
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/account/);
}

/** The enroll form's own fields, so a double submit sends exactly what the browser would. */
async function enrollForm(page: Page): Promise<{ readonly csrf: string; readonly testId: string; readonly key: string }> {
  const form = page.locator('form[action="/api/enrollments/enroll"]');
  await expect(form).toBeVisible();

  return {
    csrf: await form.locator('input[name="csrfToken"]').inputValue(),
    testId: await form.locator('input[name="testId"]').inputValue(),
    key: await form.locator('input[name="idempotencyKey"]').inputValue(),
  };
}

/** How many ENROLLMENT rows this student's wallet shows. */
async function enrollmentRowCount(page: Page): Promise<number> {
  await page.goto('/wallet?type=ENROLLMENT');
  return page.getByTestId('wallet-history').locator('tr', { hasText: 'ENROLLMENT' }).count();
}

test.describe.serial('the student catalog and enrollment', () => {
  test.beforeAll(() => {
    const author = seedAuthor(marker);
    const bank = seedBuilderFixture({
      editorId: author.authorId,
      marker,
      alphaText: `Catalog alpha question ${marker}`,
      betaText: `Catalog beta question ${marker}`,
    });

    testA = publishSeededPaper({
      authorId: author.authorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: titleA,
      maxAttempts: 2,
    }).testId;

    testB = publishSeededPaper({
      authorId: author.authorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: titleB,
      maxAttempts: 2,
    }).testId;

    setCoinSetting('signup_coins', 1_000);
    setCoinSetting('daily_reward_coins', 0);
    setCoinSetting('default_enrollment_cost', 100);
  });

  test.afterAll(() => {
    setCoinSetting('signup_coins', 1_000);
    setCoinSetting('daily_reward_coins', 10);
    setCoinSetting('default_enrollment_cost', 100);
  });

  test('a verified student browses the catalog and enrolls', async ({ page }) => {
    studentEmail = `e2e-catalog-${marker}@example.com`;
    await registerStudent(page, studentEmail, 'Catalog E2E Student');
    await signIn(page, studentEmail);

    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-balance')).toHaveText('1,000');

    await page.goto('/tests');
    const row = page.getByTestId('student-test').filter({ hasText: titleA });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('student-test-state')).toContainText('Not enrolled');

    await row.getByTestId('student-test-open').click();
    await expect(page).toHaveURL(new RegExp(`/tests/${testA}$`));
    await expect(page.getByTestId('test-cost')).toHaveText('100 coins');
    await expect(page.getByTestId('student-balance')).toHaveText('1,000');

    await page.getByTestId('enroll-button').click();
    await expect(page).toHaveURL(/\/tests\/[0-9a-f-]+\?enrolled=1/);
    await expect(page.getByTestId('open-enrollment')).toBeVisible();

    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-balance')).toHaveText('900');
    await expect(page.getByTestId('wallet-history')).toContainText('ENROLLMENT');

    // The catalog now shows the paper as an open attempt, and "Your tests" lists it.
    await page.goto('/tests');
    await expect(page.getByTestId('enrollment-list')).toContainText(titleA);
    await expect(
      page.getByTestId('student-test').filter({ hasText: titleA }).getByTestId('student-test-state'),
    ).toContainText('Open attempt 1');
  });

  test('a second enrollment on the same test is refused and charges nothing', async ({ page }) => {
    await signIn(page, studentEmail);

    await page.goto(`/tests/${testA}`);
    await expect(page.getByTestId('open-enrollment')).toBeVisible();
    await expect(page.getByTestId('enroll-button')).toHaveCount(0);

    const cookies = await page.context().cookies();
    const csrf = cookies.find((cookie) => cookie.name === 'abhyas_csrf')?.value ?? '';

    const refused = await page.request.post('/api/enrollments/enroll', {
      form: { csrfToken: csrf, testId: testA, idempotencyKey: `second-${randomUUID()}` },
      headers: { origin: 'http://localhost:3000' },
      maxRedirects: 0,
    });

    expect(refused.status()).toBe(303);
    const location = decodeURIComponent(refused.headers()['location'] ?? '');
    expect(location).toContain('error=open_enrollment');

    await page.goto(location);
    await expect(page.getByTestId('enroll-error')).toContainText('already have an open attempt');

    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-balance')).toHaveText('900');
    expect(await enrollmentRowCount(page)).toBe(1);
  });

  test('two quick submits of one form write exactly one debit', async ({ page }) => {
    await signIn(page, studentEmail);

    await page.goto(`/tests/${testB}`);
    const form = await enrollForm(page);
    expect(form.testId).toBe(testB);

    const post = () =>
      page.request.post('/api/enrollments/enroll', {
        form: { csrfToken: form.csrf, testId: form.testId, idempotencyKey: form.key },
        headers: { origin: 'http://localhost:3000' },
        maxRedirects: 0,
      });

    const [left, right] = await Promise.all([post(), post()]);
    expect(left.status()).toBe(303);
    expect(right.status()).toBe(303);
    expect(decodeURIComponent(left.headers()['location'] ?? '')).toContain('enrolled=1');
    expect(decodeURIComponent(right.headers()['location'] ?? '')).toContain('enrolled=1');

    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-balance')).toHaveText('800');
    expect(await enrollmentRowCount(page)).toBe(2);
  });

  test('a student without enough coins is told so, and is not charged', async ({ page }) => {
    setCoinSetting('signup_coins', 50);
    const email = `e2e-catalog-poor-${marker}@example.com`;
    await registerStudent(page, email, 'Catalog Poor Student');
    // The grant is paid at verification; the setting goes back before anything else reads it.
    setCoinSetting('signup_coins', 1_000);

    await signIn(page, email);
    await page.goto(`/tests/${testA}`);
    await expect(page.getByTestId('student-balance')).toHaveText('50');

    await page.getByTestId('enroll-button').click();
    await expect(page).toHaveURL(/error=insufficient_coins/);
    await expect(page.getByTestId('enroll-error')).toContainText('not have enough coins');

    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-balance')).toHaveText('50');
    expect(await enrollmentRowCount(page)).toBe(0);
  });

  test('an anonymous visitor is sent to sign in', async ({ page }) => {
    await page.goto('/tests');
    await expect(page).toHaveURL(/\/login\?next=%2Ftests/);

    await page.goto(`/tests/${testA}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Ftests%2F${testA}`));
  });
});
