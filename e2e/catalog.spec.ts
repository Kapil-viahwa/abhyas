import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * The catalog end to end: an Administrator creates a category and an exam, the public
 * page shows them, and a second editor cannot change what the first one made.
 */

const ADMIN_EMAIL = 'e2e-catalog-admin@example.com';
const ADMIN_PASSWORD = 'catalog-admin-9pass';
const EDITOR_PASSWORD = 'catalog-editor-9pass';

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
      `SEED_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
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

test.describe.serial('the exam catalog', () => {
  const marker = randomUUID().slice(0, 6);
  const categoryName = `Banking ${marker}`;
  const examName = `IBPS Clerk ${marker}`;

  test('an administrator creates a category and an exam', async ({ page }) => {
    registerAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin$/);

    await page.goto('/admin/catalog');
    await page.getByText('Category', { exact: true }).click();
    await page.fill('form:has(input[name="type"][value="categories"]) input[name="name"]', categoryName);
    await page.click('form:has(input[name="type"][value="categories"]) button[type="submit"]');
    await expect(page).toHaveURL(/created=1/);

    await page.getByText('Exam', { exact: true }).click();
    await page.fill('form:has(input[name="type"][value="exams"]) input[name="name"]', examName);
    await page.click('form:has(input[name="type"][value="exams"]) button[type="submit"]');
    await expect(page).toHaveURL(/created=1/);

    await expect(page.getByTestId('catalog-tree')).toContainText(categoryName);
    await expect(page.getByTestId('catalog-tree')).toContainText(examName);
  });

  test('the public pages show it, with a title and a canonical URL', async ({ page }) => {
    const slug = categoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    await page.goto('/exams');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Exams');
    await expect(page.getByRole('link', { name: categoryName })).toBeVisible();

    await page.goto(`/exams/${slug}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(categoryName);
    await expect(page.getByRole('link', { name: examName })).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(`${categoryName} exams \\| Abhyas`));

    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute('href', new RegExp(`/exams/${slug}$`));

    const examSlug = examName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await page.goto(`/exams/${slug}/${examSlug}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(examName);
    await expect(page.getByText(/subjects are defined for/)).toBeVisible();
  });

  test('an editor can author in their own catalog but not reach the admin ones', async ({ page, browser }) => {
    registerAdmin();

    const editorEmail = `e2e-catalog-editor-${marker}@example.com`;

    // The Administrator creates an editor who may manage questions.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto('/admin/users/new');
    await page.fill('input[name="fullName"]', 'Catalog Editor');
    await page.fill('input[name="email"]', editorEmail);
    await page.fill('input[name="password"]', EDITOR_PASSWORD);
    await page.check('input[name="manage_questions"]');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/created=1/);

    // A separate browser context, so the Administrator's cookies do not answer for the
    // editor: this test signs in as a different person.
    const editorContext = await browser.newContext();
    const editorPage = await editorContext.newPage();

    await signIn(editorPage, editorEmail, EDITOR_PASSWORD);
    await expect(editorPage).toHaveURL(/\/editor$/);

    await editorPage.goto('/editor/catalog');
    await expect(editorPage.getByTestId('catalog-tree')).toBeVisible();

    // The administration screens remain closed to an editor.
    await editorPage.goto('/admin/catalog');
    await expect(editorPage).toHaveURL(/\/account\?denied=1/);

    await editorContext.close();
  });
});
