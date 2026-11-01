import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * Settings and the audit trail in a browser: a change is made, then found in the trail
 * with the filters the viewer offers. Neither an editor nor a student can open either
 * screen.
 */

/** The shared Administrator: the seed creates exactly one, and refuses a second. */
const ADMIN_EMAIL = 'e2e-admin@example.com';
const ADMIN_LOGIN = 'administrator-9pass';
const EDITOR_LOGIN = 'ops-editor-9pass';
const STUDENT_LOGIN = 'student-9login-ok';

let seeded = false;

function registerAdmin(): void {
  if (seeded) {
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

  seeded = true;
}

function apiLogs(): string {
  return execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function waitForLink(before: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000;
  const searchable = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);

  while (Date.now() < deadline) {
    const logs = apiLogs();
    const start = logs.indexOf(before);
    const fresh = start >= 0 ? logs.slice(start + before.length) : logs;
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
}

test.describe.serial('settings and the audit trail', () => {
  const marker = randomUUID().slice(0, 6);

  test('a setting change is saved and appears in the audit trail', async ({ page }) => {
    registerAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto('/admin/settings');
    const row = page.getByTestId('settings-list').locator('li').filter({ hasText: 'signup_coins' });
    await row.locator('input[name="value"]').fill('1005');
    await row.locator('button[type="submit"]').click();

    await expect(page).toHaveURL(/updated=1/);
    await expect(page.getByText('Setting saved.')).toBeVisible();

    await page.goto('/admin/audit?action=SETTINGS_CHANGED');
    const table = page.getByTestId('audit-table');
    await expect(table).toContainText('SETTINGS_CHANGED');

    // The bounds the row carries are shown next to the field.
    await page.goto('/admin/settings');
    const boundsText = page.getByTestId('settings-list').locator('li').filter({ hasText: 'signup_coins' });
    await expect(boundsText).toContainText('0 to 100000');
  });

  test('the audit viewer can export a CSV', async ({ page }) => {
    registerAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);

    const response = await page.request.get('/api/admin/audit-export?action=SETTINGS_CHANGED');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');

    const body = await response.text();
    expect(body.split('\n')[0]).toBe('occurred_at,actor_email,actor_role,action,entity_type,entity_id,ip,metadata');
    expect(body).toContain('SETTINGS_CHANGED');
  });

  test('an editor cannot open the settings or the audit trail', async ({ page, browser }) => {
    registerAdmin();
    const editorEmail = `e2e-ops-editor-${marker}@example.com`;

    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await page.goto('/admin/users/new');
    await page.fill('input[name="fullName"]', 'Ops Editor');
    await page.fill('input[name="email"]', editorEmail);
    await page.fill('input[name="password"]', EDITOR_LOGIN);
    await page.check('input[name="manage_tests"]');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/created=1/);

    const context = await browser.newContext();
    const editorPage = await context.newPage();
    await signIn(editorPage, editorEmail, EDITOR_LOGIN);
    await expect(editorPage).toHaveURL(/\/editor$/);

    await editorPage.goto('/admin/settings');
    await expect(editorPage).toHaveURL(/\/account\?denied=1/);

    await editorPage.goto('/admin/audit');
    await expect(editorPage).toHaveURL(/\/account\?denied=1/);

    await context.close();
  });

  test('a student cannot open the settings or the audit trail', async ({ browser }) => {
    const studentEmail = `e2e-ops-student-${marker}@example.com`;
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('/register');
    await page.fill('input[name="fullName"]', 'Ops Student');
    await page.fill('input[name="email"]', studentEmail);
    await page.fill('input[name="password"]', STUDENT_LOGIN);

    const before = apiLogs();
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/verify-email\?sent=1/);

    const token = await waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/);
    await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();

    await signIn(page, studentEmail, STUDENT_LOGIN);
    await expect(page).toHaveURL(/\/account/);

    await page.goto('/admin/settings');
    await expect(page).toHaveURL(/\/account\?denied=1/);

    await page.goto('/admin/audit');
    await expect(page).toHaveURL(/\/account\?denied=1/);

    await context.close();
  });
});
