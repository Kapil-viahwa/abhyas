import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * The student wallet page (phase 5, item 4b): the grant, the daily reward and the history a
 * student actually sees. The daily reward is switched off for the registration step so the
 * opening balance is the 1,000-coin grant, then switched on to prove it is paid once.
 *
 * Both settings the page's numbers depend on are pinned here, not just the reward. The e2e
 * stack is one database shared by every spec of the run, and `admin-operations.spec.ts` sets
 * `signup_coins` to 1,005 as its proof that the settings screen saves. This file runs after
 * it (one worker, files in order), so the grant it saw was 1,005 and the wallet showed 1,005
 * where this file expected 1,000. `CoinService` reads the setting row from the database on
 * every call, so nothing was cached: the expectation was right and the fixture was incomplete.
 */

const PASSWORD = 'correct-horse-9battery';
const CLIENT_IP = '198.18.0.21';

test.use({ extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } });

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

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/account/);
}

/** The two settings the wallet page's numbers come from. */
type CoinSetting = 'signup_coins' | 'daily_reward_coins';

/**
 * A fixture, like the role switch in the auth spec: one statement against the stack's
 * database. It upserts and reads the value back, so a fixture that did not land fails here
 * with its own message instead of surfacing as a wrong balance two screens later.
 */
function setCoinSetting(key: CoinSetting, value: number): void {
  const sql = [
    'DO $$',
    'DECLARE landed integer;',
    'BEGIN',
    '  INSERT INTO settings (key, value_type, value_int)',
    `  VALUES ('${key}', 'integer', ${String(value)})`,
    '  ON CONFLICT (key) DO UPDATE SET value_int = EXCLUDED.value_int',
    '  RETURNING value_int INTO landed;',
    `  IF landed IS DISTINCT FROM ${String(value)} THEN`,
    `    RAISE EXCEPTION '${key} did not land at ${String(value)} (it is %)', landed;`,
    '  END IF;',
    'END $$;',
  ].join('\n');

  execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'abhyas', '-d', 'abhyas', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

test.describe.serial('the student wallet', () => {
  const email = `wallet-e2e-${randomUUID().slice(0, 8)}@example.com`;

  test('a newly verified student sees the 1,000 coin grant', async ({ page }) => {
    setCoinSetting('signup_coins', 1_000);
    setCoinSetting('daily_reward_coins', 0);

    await page.goto('/register');
    await page.fill('input[name="fullName"]', 'Wallet E2E Student');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', PASSWORD);

    const before = apiLogs();
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/verify-email\?sent=1/);

    const token = await waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/);
    await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();

    await signIn(page, email);
    await page.goto('/wallet');

    await expect(page.getByTestId('wallet-balance')).toHaveText('1,000');
    await expect(page.getByTestId('wallet-earned')).toHaveText('1,000');

    const history = page.getByTestId('wallet-history');
    await expect(history).toContainText('SIGNUP_GRANT');
    // The reward is off, so a reward row here means the fixture did not land.
    await expect(history).not.toContainText('DAILY_REWARD');
  });

  test('pays the daily reward once, and a second sign-in changes nothing', async ({ page, browser }) => {
    setCoinSetting('signup_coins', 1_000);
    setCoinSetting('daily_reward_coins', 10);

    await signIn(page, email);
    await page.goto('/wallet');
    await expect(page.getByTestId('wallet-balance')).toHaveText('1,010');
    await expect(page.getByTestId('wallet-reward')).toContainText('has been added');
    await expect(page.getByTestId('wallet-history')).toContainText('DAILY_REWARD');

    // A fresh browser context is a second sign-in on the same day.
    const again = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } });
    const second = await again.newPage();
    await signIn(second, email);
    await second.goto('/wallet');
    await expect(second.getByTestId('wallet-balance')).toHaveText('1,010');
    await again.close();
  });

  test('filters the history by type', async ({ page }) => {
    await signIn(page, email);
    await page.goto('/wallet?type=DAILY_REWARD');

    const rows = page.getByTestId('wallet-history').locator('tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('DAILY_REWARD');
  });

  test('sends an anonymous visitor to sign in', async ({ page }) => {
    await page.goto('/wallet');
    await expect(page).toHaveURL(/\/login\?next=%2Fwallet/);
  });
});
