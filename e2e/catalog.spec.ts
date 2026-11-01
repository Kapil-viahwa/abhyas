import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * The catalog end to end: an Administrator creates a category and an exam, the public
 * page shows them, and a second editor cannot change what the first one made.
 */

/**
 * The same Administrator the other browser specs use: the seed creates one account and
 * refuses a second, so this spec signs in with the shared credentials rather than
 * expecting one of its own.
 */
const ADMIN_EMAIL = 'e2e-admin@example.com';
const ADMIN_LOGIN = 'administrator-9pass';
const EDITOR_LOGIN = 'catalog-editor-9pass';

/**
 * This spec talks to the stack as one client address. The API limits sign-ins per
 * address, and each spec file signs in several times, so every file gets its own —
 * the limit itself is untouched, and no two files share a counter.
 */
const CLIENT_IP = '198.18.0.31';
const CLIENT = { extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } };

test.use(CLIENT);

/**
 * Opens one of the four create forms. `getByText('Category')` is ambiguous here: the
 * word is both the `<summary>` that opens the form and the `<label>` of the exam form's
 * category picker, so the summary is what gets clicked.
 */
async function openBuilder(page: Page, kind: 'Category' | 'Exam' | 'Subject' | 'Topic'): Promise<void> {
  await page
    .locator('summary')
    .filter({ hasText: new RegExp(`^${kind}$`) })
    .click();
}

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

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
}

/**
 * A fixture read, not behaviour under test: the id of the exam with this name, read from
 * the stack's own database so the browser test can make the request the screens never
 * offer. The same pattern `setRole` uses in auth.spec.ts, and no test-only endpoint.
 */
function examIdFor(name: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'abhyas',
      '-d',
      'abhyas',
      '-t',
      '-A',
      '-c',
      `select id::text from exams where name = '${name.replace(/'/g, "''")}' limit 1`,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  ).trim();
}

function examIsActive(id: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'abhyas',
      '-d',
      'abhyas',
      '-t',
      '-A',
      '-c',
      `select is_active from exams where id = '${id}'`,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  ).trim();
}

test.describe.serial('the exam catalog', () => {
  const marker = randomUUID().slice(0, 6);
  const categoryName = `Banking ${marker}`;
  const examName = `IBPS Clerk ${marker}`;

  test('an administrator creates a category and an exam', async ({ page }) => {
    registerAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await expect(page).toHaveURL(/\/admin$/);

    // Warm the public page's cache with the catalog as it stands. The next test's
    // assertions only pass if this write drops that cache — which is the API's
    // revalidation call doing its job.
    await page.goto('/exams');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Exams');
    await expect(page.getByRole('link', { name: categoryName })).toHaveCount(0);

    await page.goto('/admin/catalog');
    await openBuilder(page, 'Category');
    // By test id: every tree row also holds an edit form of the same kind, so a
    // `form:has(input[name="type"]...)` selector would no longer be unique.
    const categoryForm = page.getByTestId('create-form-categories');
    await categoryForm.locator('input[name="name"]').fill(categoryName);
    await categoryForm.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/created=1/);

    await openBuilder(page, 'Exam');
    const examForm = page.getByTestId('create-form-exams');
    await examForm.locator('input[name="name"]').fill(examName);
    await examForm.locator('select[name="categoryId"]').selectOption({ label: categoryName });
    await examForm.locator('button[type="submit"]').click();
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

  test('an administrator renames and reorders a category, and the public list follows', async ({ page }) => {
    registerAdmin();
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await expect(page).toHaveURL(/\/admin$/);

    // Two more top-level categories with explicit orders: the move below needs distinct
    // values to have a visible effect, since rows that share an order sort by name.
    const first = `Zulu ${marker}`;
    const second = `Alpha ${marker}`;

    for (const [name, order] of [
      [first, '1'],
      [second, '2'],
    ] as const) {
      await page.goto('/admin/catalog');
      await openBuilder(page, 'Category');
      const form = page.getByTestId('create-form-categories');
      await form.locator('input[name="name"]').fill(name);
      await form.locator('button[type="submit"]').click();
      await expect(page).toHaveURL(/created=1/);

      const row = page.locator(`[data-testid="catalog-row"][data-name="${name}"]`);
      // The row holds an edit form and a move form per neighbour, so the order field is
      // read through the form that owns it rather than by name across the whole row.
      const editForm = row.getByTestId('edit-form');

      await row.locator('summary').first().click();
      await editForm.locator('input[name="sortOrder"]').fill(order);
      await editForm.getByRole('button', { name: 'Save changes' }).click();

      await expect(page).toHaveURL(/updated=1/);
    }

    await page.goto('/exams');
    const links = page.locator('section.grid article h2 a');
    await expect(links.filter({ hasText: first })).toHaveCount(1);
    await expect(links.filter({ hasText: second })).toHaveCount(1);

    const ordered = await links.allTextContents();
    expect(ordered.indexOf(first)).toBeLessThan(ordered.indexOf(second));

    // One place up: the pair swaps orders, and the public list follows the swap.
    await page.goto('/admin/catalog');
    await page
      .locator(`[data-testid="catalog-row"][data-name="${second}"]`)
      .getByRole('button', { name: `Move ${second} up` })
      .click();
    await expect(page).toHaveURL(/updated=1/);

    await page.goto('/exams');
    const afterMove = await page.locator('section.grid article h2 a').allTextContents();
    expect(afterMove.indexOf(second)).toBeLessThan(afterMove.indexOf(first));
  });

  test('an editor can author in their own catalog but not reach the admin ones', async ({ page, browser }) => {
    registerAdmin();

    const editorEmail = `e2e-catalog-editor-${marker}@example.com`;

    // The Administrator creates an editor who may manage questions.
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    await page.goto('/admin/users/new');
    await page.fill('input[name="fullName"]', 'Catalog Editor');
    await page.fill('input[name="email"]', editorEmail);
    await page.fill('input[name="password"]', EDITOR_LOGIN);
    await page.check('input[name="manage_questions"]');
    // By role, not `button[type="submit"]`: the shared administration nav also has a
    // submit button (Sign out), and it comes first in the document.
    await page.getByRole('button', { name: 'Create editor' }).click();
    await expect(page).toHaveURL(/created=1/);

    // A separate browser context, so the Administrator's cookies do not answer for the
    // editor: this test signs in as a different person.
    const editorContext = await browser.newContext(CLIENT);
    const editorPage = await editorContext.newPage();

    await signIn(editorPage, editorEmail, EDITOR_LOGIN);
    await expect(editorPage).toHaveURL(/\/editor$/);

    await editorPage.goto('/editor/catalog');
    await expect(editorPage.getByTestId('catalog-tree')).toBeVisible();

    // The administration screens remain closed to an editor.
    await editorPage.goto('/admin/catalog');
    await expect(editorPage).toHaveURL(/\/account\?denied=1/);

    await editorContext.close();
  });

  test("an editor cannot change another editor's exam", async ({ page, browser }) => {
    registerAdmin();

    const editorAEmail = `e2e-catalog-a-${marker}@example.com`;
    const editorBEmail = `e2e-catalog-b-${marker}@example.com`;
    const examName = `SSC CGL ${marker}`;

    // Two editors who may author content. Neither may touch the other's rows.
    await signIn(page, ADMIN_EMAIL, ADMIN_LOGIN);
    for (const email of [editorAEmail, editorBEmail]) {
      await page.goto('/admin/users/new');
      await page.fill('input[name="fullName"]', 'Catalog Author');
      await page.fill('input[name="email"]', email);
      await page.fill('input[name="password"]', EDITOR_LOGIN);
      await page.check('input[name="manage_questions"]');
      // By role, not `button[type="submit"]`: the shared administration nav also has a
      // submit button (Sign out), and it comes first in the document.
      await page.getByRole('button', { name: 'Create editor' }).click();
      await expect(page).toHaveURL(/created=1/);
    }

    // Editor A authors a category and an exam in their own area.
    const contextA = await browser.newContext(CLIENT);
    const pageA = await contextA.newPage();
    await signIn(pageA, editorAEmail, EDITOR_LOGIN);
    await expect(pageA).toHaveURL(/\/editor$/);
    await pageA.goto('/editor/catalog');

    const categoryName = `Staff Selection ${marker}`;
    await openBuilder(pageA, 'Category');
    const categoryForm = pageA.getByTestId('create-form-categories');
    await categoryForm.locator('input[name="name"]').fill(categoryName);
    await categoryForm.locator('button[type="submit"]').click();
    await expect(pageA).toHaveURL(/created=1/);

    await openBuilder(pageA, 'Exam');
    const examForm = pageA.getByTestId('create-form-exams');
    await examForm.locator('input[name="name"]').fill(examName);
    await examForm.locator('select[name="categoryId"]').selectOption({ label: categoryName });
    await examForm.locator('button[type="submit"]').click();
    await expect(pageA).toHaveURL(/created=1/);
    await contextA.close();

    const examId = examIdFor(examName);
    expect(examId).not.toBe('');

    // Editor B, in their own session, sends the request the screens never offer: the
    // other editor's exam id, with B's own CSRF value.
    const contextB = await browser.newContext(CLIENT);
    const pageB = await contextB.newPage();
    await signIn(pageB, editorBEmail, EDITOR_LOGIN);
    await expect(pageB).toHaveURL(/\/editor$/);
    await pageB.goto('/editor/catalog');

    const csrf = await pageB.locator('input[name="csrfToken"]').first().inputValue();

    await pageB.evaluate(
      ({ csrfToken, id }: { csrfToken: string; id: string }) => {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/api/catalog/update';
        // The tree has one update form per row, so this one names itself.
        form.id = 'editor-b-request';

        const fields: Record<string, string> = {
          csrfToken,
          area: 'editor',
          type: 'exams',
          id,
          action: 'deactivate',
        };

        for (const [name, value] of Object.entries(fields)) {
          const field = document.createElement('input');
          field.type = 'hidden';
          field.name = name;
          field.value = value;
          form.appendChild(field);
        }

        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = 'Send';
        form.appendChild(submit);

        document.body.appendChild(form);
      },
      { csrfToken: csrf, id: examId },
    );

    // Clicking the button rather than calling form.submit(): Playwright waits for the
    // navigation the submit causes, so the assertion below reads the answer the API sent.
    await pageB.click('#editor-b-request button[type="submit"]');

    await expect(pageB).toHaveURL(/error=/);
    await expect(pageB.getByText('You can only change content you created')).toBeVisible();

    // The exam A made is untouched, and the API refused rather than half-applied.
    expect(examIsActive(examId)).toBe('t');

    await contextB.close();
  });
});
