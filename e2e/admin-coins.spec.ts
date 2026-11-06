import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { setCoinSetting } from './coin-settings';

/**
 * The Administrator's coin screens (phase 5, item Q4): find an account, adjust it with a
 * reason, credit many from a CSV, watch the job and download the report.
 *
 * This file runs first in the chromium project (one worker, files in order), so it pins every
 * setting it reads and restores the defaults when it is done: a spec never inherits another
 * spec's state, and it never leaves its own behind.
 */

/** The shared Administrator: the seed creates exactly one, and refuses a second. */
const ADMIN_EMAIL = 'e2e-admin@example.com';
const ADMIN_LOGIN = 'administrator-9pass';
const STUDENT_LOGIN = 'student-9login-ok';
const EDITOR_LOGIN = 'coins-editor-9pass';

/** This spec's own source address, so its sign-ins do not share a rate-limit counter. */
const CLIENT_IP = '198.18.0.42';
const CLIENT = { extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } };

test.use(CLIENT);

const marker = randomUUID().slice(0, 8);
const studentA = `e2e-coins-a-${marker}@example.com`;
const studentB = `e2e-coins-b-${marker}@example.com`;
const missing = `e2e-coins-missing-${marker}@example.com`;
const editorEmail = `e2e-coins-editor-${marker}@example.com`;

/** The student record the later tests act on, captured by the first one. */
let studentId = '';

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

/** Register one student in a browser of their own, and verify the address the API printed. */
async function registerStudent(browser: Browser, email: string): Promise<void> {
  const context = await browser.newContext(CLIENT);
  const page = await context.newPage();

  await page.goto('/register');
  await page.fill('input[name="fullName"]', 'Coins E2E Student');
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

/** The pending submission's own fields: the same key, the same body, submitted twice. */
async function formFields(page: Page): Promise<{ userId: string; csrf: string; key: string }> {
  return {
    userId: await page.locator('input[name="userId"]').inputValue(),
    csrf: await page.locator('input[name="csrfToken"]').first().inputValue(),
    key: await page.locator('input[name="idempotencyKey"]').inputValue(),
  };
}

test.beforeAll(() => {
  setCoinSetting('signup_coins', 1_000);
  setCoinSetting('daily_reward_coins', 0);
  setCoinSetting('coin_max_bulk_users', 5_000);
  setCoinSetting('coin_max_bulk_coins', 1_000_000);
});

test.afterAll(() => {
  // Back to the platform defaults, so the specs after this one start where they expect to.
  setCoinSetting('daily_reward_coins', 10);
  setCoinSetting('signup_coins', 1_000);
});

test.describe.serial('the administrator coin screens', () => {
  test('credits one account, and a double submit writes one ledger row', async ({ page, browser }) => {
    seedAdmin();
    await registerStudent(browser, studentA);
    await registerStudent(browser, studentB);

    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto(`/admin/coins?q=${encodeURIComponent(studentA)}`);
    const recipients = page.getByTestId('coin-recipients');
    await expect(recipients).toContainText(studentA);
    await recipients.locator('li').filter({ hasText: studentA }).getByRole('link', { name: 'Open' }).click();

    await expect(page.getByTestId('coin-balance')).toHaveText('1,000');
    const fields = await formFields(page);
    studentId = fields.userId;

    await page.fill('input[name="amount"]', '50');
    await page.fill('input[name="remark"]', 'E2E credit');
    await page.fill('input[name="password"]', ADMIN_LOGIN);
    await page.getByRole('button', { name: 'Add or deduct coins' }).click();

    await expect(page).toHaveURL(/adjusted=1/);
    await expect(page.getByTestId('coin-balance')).toHaveText('1,050');
    await expect(page.getByTestId('coin-ledger')).toContainText('ADMIN_CREDIT');

    // The open form's own key and body, twice at once, exactly as a double click arrives.
    const pending = await formFields(page);
    const submit = () =>
      page.request.post('/api/admin/coins/adjust', {
        form: {
          csrfToken: pending.csrf,
          userId: pending.userId,
          idempotencyKey: pending.key,
          amount: '7',
          remark: 'E2E double submit',
          password: ADMIN_LOGIN,
        },
        headers: { origin: 'http://localhost:3000' },
        maxRedirects: 0,
      });

    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first.status(), second.status()]).toEqual([303, 303]);

    await page.reload();
    await expect(page.getByTestId('coin-balance')).toHaveText('1,057');
    await expect(page.getByTestId('coin-ledger').locator('tr').filter({ hasText: '+7' })).toHaveCount(1);
  });

  test('credits several accounts from a CSV and reports the row that matched nothing', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await page.goto('/admin/coins/bulk');

    const csv = `email\n${studentA}\n${studentB}\n${missing}\n`;
    await page.setInputFiles('input[name="csv"]', {
      name: 'bulk.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await page.fill('input[name="amount"]', '25');
    await page.fill('input[name="remark"]', 'E2E bulk');
    await page.getByRole('button', { name: 'Preview' }).click();

    await expect(page).toHaveURL(/preview=1/);
    const preview = page.getByTestId('bulk-preview');
    await expect(preview).toContainText(studentA);
    await expect(preview).toContainText(studentB);
    await expect(page.getByTestId('bulk-unmatched')).toContainText(missing);

    await page.fill('input[name="password"]', ADMIN_LOGIN);
    await page.getByRole('button', { name: 'Credit 2 accounts' }).click();

    await expect(page).toHaveURL(/\/admin\/coins\/bulk\/[0-9a-f-]+\?started=1/);

    // The worker's drain runs every thirty seconds: reload the status screen until it is done.
    await expect
      .poll(
        async () => {
          await page.goto(page.url());
          return (await page.getByTestId('bulk-status').textContent())?.trim();
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe('COMPLETED');

    await expect(page.getByTestId('bulk-credited')).toHaveText('2 / 2');

    const jobId = new URL(page.url()).pathname.split('/').filter(Boolean).pop() ?? '';
    const report = await page.request.get(`/api/admin/coins/download?kind=report&id=${encodeURIComponent(jobId)}`);

    expect(report.status()).toBe(200);
    expect(report.headers()['content-type']).toContain('text/csv');
    expect(await report.text()).toContain(studentA);
  });

  test('an editor and a student cannot open the pages or write coins', async ({ page, browser }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);

    await page.goto('/admin/users/new');
    await page.fill('input[name="fullName"]', 'Coins Editor');
    await page.fill('input[name="email"]', editorEmail);
    await page.fill('input[name="password"]', EDITOR_LOGIN);
    await page.check('input[name="manage_tests"]');
    await page.getByRole('button', { name: 'Create editor' }).click();
    await expect(page).toHaveURL(/created=1/);

    for (const [email, password] of [
      [editorEmail, EDITOR_LOGIN],
      [studentA, STUDENT_LOGIN],
    ] as const) {
      const context = await browser.newContext(CLIENT);
      const outsider = await context.newPage();

      await signIn(outsider, email, password);
      await outsider.goto('/admin/coins');
      await expect(outsider).toHaveURL(/\/account\?denied=1/);
      await outsider.goto('/admin/coins/bulk');
      await expect(outsider).toHaveURL(/\/account\?denied=1/);

      // A direct form post to the write route: the API refuses it, so nothing is credited.
      const csrf = (await context.cookies()).find((cookie) => cookie.name === 'abhyas_csrf')?.value ?? '';
      const refused = await outsider.request.post('/api/admin/coins/adjust', {
        form: {
          csrfToken: csrf,
          userId: studentId,
          idempotencyKey: randomUUID(),
          amount: '10',
          remark: 'E2E refusal',
          password,
        },
        headers: { origin: 'http://localhost:3000' },
        maxRedirects: 0,
      });

      expect(refused.status()).toBe(303);
      expect(refused.headers()['location'] ?? '').toContain('error=');
      expect(refused.headers()['location'] ?? '').not.toContain('adjusted=1');

      await context.close();
    }

    // 1,000 at signup, +50 from the adjust, +7 from the double submit, +25 from the bulk.
    await page.goto(`/admin/coins/${studentId}`);
    await expect(page.getByTestId('coin-balance')).toHaveText('1,082');
  });
});
