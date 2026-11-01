import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * The authentication flows, against the running stack.
 *
 * Tokens are single-use secrets that only exist in plaintext inside the verification
 * and reset mails, so this reads them from the outbox the API prints to its own log —
 * no test-only endpoint, and nothing added to the application to make the test easier.
 */

const PASSWORD = 'correct-horse-9battery';
const NEW_PASSWORD = 'battery-horse-9-correct';

function apiLogs(): string {
  // The stack is the development compose file, launched by the e2e CI job.
  return execFileSync('docker', ['compose', 'logs', '--no-color', 'api'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Waits for a link that appeared after `before`, so an older mail cannot match. */
async function waitForLink(before: string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const logs = apiLogs();
    const start = logs.indexOf(before);
    const fresh = start >= 0 ? logs.slice(start + before.length) : logs;
    const match = [...fresh.matchAll(pattern)].at(-1);
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

test.describe.serial('authentication flows', () => {
  const email = `e2e-${randomUUID().slice(0, 8)}@example.com`;

  test('registers an account and follows the verification link', async ({ page }) => {
    await page.goto('/register');
    await page.fill('input[name="fullName"]', 'E2E Student');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', PASSWORD);

    const before = apiLogs();
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/verify-email\?sent=1/);

    const token = await waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/);
    await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);

    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  });

  test('signs in and lands on the account page', async ({ page }) => {
    await signIn(page, email, PASSWORD);

    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByTestId('session-list').locator('li')).toHaveCount(1);
  });

  test('shows both sessions and ends the other one', async ({ page, browser }) => {
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/account/);

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await signIn(other, email, PASSWORD);
    await expect(other).toHaveURL(/\/account/);

    await page.goto('/account');
    await expect(page.getByTestId('session-list').locator('li')).toHaveCount(2);

    const otherRow = page
      .getByTestId('session-list')
      .locator('li')
      .filter({ hasNot: page.getByText('this device') });
    await otherRow.getByRole('button', { name: 'End session' }).click();
    await expect(page).toHaveURL(/revoked=1/);

    await other.goto('/account');
    await expect(other).toHaveURL(/\/login/);

    await otherContext.close();
  });

  test('changes the password and the other device is signed out', async ({ page, browser }) => {
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/account/);

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await signIn(other, email, PASSWORD);
    await expect(other).toHaveURL(/\/account/);

    await page.goto('/account');
    await page.fill('input[name="currentPassword"]', PASSWORD);
    await page.fill('input[name="newPassword"]', NEW_PASSWORD);
    await page.getByRole('button', { name: 'Save new password' }).click();

    await expect(page).toHaveURL(/password=changed/);

    await other.goto('/account');
    await expect(other).toHaveURL(/\/login/);

    await otherContext.close();
  });

  test('blocks a student from the administrator area', async ({ page }) => {
    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/account/);

    await page.goto('/admin');

    await expect(page).toHaveURL(/\/account\?denied=1/);
    await expect(page.getByText('You do not have access to that page.')).toBeVisible();
  });

  test('signs out, and the account page is closed afterwards', async ({ page }) => {
    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/account/);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login\?signedOut=1/);

    await page.goto('/account');
    await expect(page).toHaveURL(/\/login/);
  });

  test('resets the password from a single-use link', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.fill('input[name="email"]', email);

    const before = apiLogs();
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/sent=1/);

    const token = await waitForLink(before, /reset-password\?token=([A-Za-z0-9_-]+)/);
    await page.goto(`/reset-password?token=${encodeURIComponent(token)}`);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login\?reset=1/);

    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/account/);
  });

  test('sends the security headers on every page', async ({ request }) => {
    const response = await request.get('/');
    const headers = response.headers();

    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
