import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * Administration in a browser: an Administrator creates an editor through the screens,
 * and the new editor can reach their own area and nothing else.
 *
 * The Administrator account is made by running the repository's own seed inside the
 * running API container — the same script an operator runs — so no test-only route
 * exists in the application to create one.
 */

/**
 * One Administrator for the whole browser suite. The seed refuses to create a second
 * one, so every spec that needs an Administrator signs in with these credentials and
 * the second and third seed runs report `admin-already-exists` instead of a failure.
 */
const ADMIN_EMAIL = 'e2e-admin@example.com';
const ADMIN_LOGIN = 'administrator-9pass';
const EDITOR_LOGIN = 'editorial-9pass';

let seeded = false;

function seedAdmin(): void {
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

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

test.describe.serial('administration', () => {
  const editorEmail = `e2e-editor-${randomUUID().slice(0, 8)}@example.com`;

  test('an administrator creates an editor with explicit capability', async ({ page }) => {
    seedAdmin();

    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto('/admin/users/new');
    await page.fill('input[name="fullName"]', 'E2E Editor');
    await page.fill('input[name="email"]', editorEmail);
    await page.fill('input[name="password"]', EDITOR_LOGIN);
    await page.check('input[name="manage_questions"]');

    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/admin\/users\/[0-9a-f-]+\?created=1/);
    await expect(page.getByText('Editor created.')).toBeVisible();
    await expect(page.getByText(editorEmail)).toBeVisible();
    // Only the ticked capability is shown; the other two are denials.
    await expect(page.getByText('Questions', { exact: true })).toBeVisible();
  });

  test('the user list finds the new editor through the search field', async ({ page }) => {
    seedAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);

    await page.goto('/admin/users');
    await page.fill('input[name="search"]', editorEmail);
    await page.click('button:has-text("Filter")');

    const rows = page.getByTestId('user-list').locator('li');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(editorEmail);
  });

  test('the editor reaches their own area and none of the administration', async ({ page }) => {
    await signIn(page, editorEmail, EDITOR_LOGIN);

    await expect(page).toHaveURL(/\/editor$/);
    await expect(page.getByRole('heading', { name: 'Editor area' })).toBeVisible();

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/account\?denied=1/);

    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/account\?denied=1/);

    await page.goto('/admin/users/new');
    await expect(page).toHaveURL(/\/account\?denied=1/);
  });

  test('the administrator can suspend the editor and the editor is signed out', async ({ page, browser }) => {
    seedAdmin();

    const editorContext = await browser.newContext();
    const editor = await editorContext.newPage();
    await signIn(editor, editorEmail, EDITOR_LOGIN);
    await expect(editor).toHaveURL(/\/editor$/);

    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await page.goto('/admin/users');
    await page.fill('input[name="search"]', editorEmail);
    await page.click('button:has-text("Filter")');
    await page.getByRole('link', { name: 'Open' }).first().click();

    await page.click('button:has-text("Suspend")');
    await expect(page).toHaveURL(/status=saved/);
    await expect(page.getByText('suspended')).toBeVisible();

    // The editor's session is gone on the very next page load.
    await editor.goto('/editor');
    await expect(editor).toHaveURL(/\/login/);

    await editorContext.close();
  });
});
