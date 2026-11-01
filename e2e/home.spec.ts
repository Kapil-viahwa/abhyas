import { expect, test } from '@playwright/test';

test('home page reports the API health against the running stack', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Mock tests');

  const status = page.getByTestId('api-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveAttribute('data-status', 'ok');

  await expect(page.getByTestId('database-status')).toHaveText('ok');
  await expect(page.getByTestId('redis-status')).toHaveText('ok');
});

test('API serves OpenAPI documentation', async ({ request }) => {
  const response = await request.get('http://localhost:3001/api/docs-json');

  expect(response.status()).toBe(200);

  const document = (await response.json()) as { paths?: Record<string, unknown> };
  expect(Object.keys(document.paths ?? {})).toContain('/health');
});
