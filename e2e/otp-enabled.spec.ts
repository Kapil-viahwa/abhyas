import { randomInt } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * The enabled half of the master switch: the same screens, driven in a browser against a
 * stack started with `docker-compose.otp.yml`.
 *
 * The code is fixed there (`OTP_FAKE_FIXED_CODE`, decision 0051), because a browser cannot
 * read an SMS and no route hands a code out. Nothing else is special about it: codes still
 * expire, still spend after five wrong guesses, and still obey the resend cooldown — which
 * is exactly what the lockout and the countdown below are here to prove.
 */

const CODE = process.env.E2E_OTP_CODE ?? '123456';

/**
 * A different client address per test, so the per-address ceiling can never be consumed by
 * a neighbouring test — or by the retry of the one that just failed. The limit itself is
 * untouched.
 */
let clientAddress = 0;
test.beforeEach(async ({ context }) => {
  clientAddress += 1;
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.1.${String(clientAddress)}` });
});

/** A number nobody else in the run will use: this suite must not depend on test order. */
function nextNumber(): string {
  return `+9196${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
}

/**
 * The button that submits a code form.
 *
 * That form has two submit buttons — the one that confirms, and the resend button, which is
 * a submit with its own `formAction`. Naming the one that confirms keeps the locator exact.
 */
function confirmButton(page: Page, formAction: string) {
  return page
    .locator(`form[action="${formAction}"]`)
    .locator('button[type="submit"]:not([data-testid="resend-code"])');
}

/** Creates an account from a number through the real screens, ending signed in. */
async function register(page: Page, number: string): Promise<void> {
  await page.goto('/register/mobile');
  await page.fill('input[name="fullName"]', 'Mobile Student');
  await page.fill('input[name="destination"]', number);
  await page.click('form[action="/api/auth/mobile/register"] button[type="submit"]');

  await expect(page).toHaveURL(/\/register\/mobile\?sent=1/);
  await expect(page.getByText(`A code was sent to ${number}.`)).toBeVisible();

  await page.fill('input[name="code"]', CODE);
  await confirmButton(page, '/api/auth/mobile/register/verify').click();
  await expect(page).toHaveURL(/\/account$/);
}

test('registers with a mobile number and signs the student in', async ({ page }) => {
  await register(page, nextNumber());

  // A mobile-first account has no email, and the page says so rather than showing "null".
  await expect(page.getByText(/No email linked/)).toBeVisible();
});

test('signs in with a code on a later visit, on the same session as a password would', async ({ page }) => {
  const number = nextNumber();
  await register(page, number);

  await page.click('form[action="/api/auth/logout"] button[type="submit"]');
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login/);

  await page.goto('/login/mobile');
  await page.fill('input[name="destination"]', number);
  await page.click('form[action="/api/auth/mobile/login"] button[type="submit"]');

  await expect(page).toHaveURL(/\/login\/mobile\?sent=1/);
  await page.fill('input[name="code"]', CODE);
  await confirmButton(page, '/api/auth/mobile/login/verify').click();
  await expect(page).toHaveURL(/\/account$/);
});

test('links a second number from the account page, proving it with a confirmation code', async ({ page }) => {
  await register(page, nextNumber());
  const added = nextNumber();

  // A mobile-first account has no password, so with OTP on the confirmation code is the proof
  // the account has to offer. It goes to the number the account already owns.
  await page.locator('form[action="/api/account/reauth/otp"] button[type="submit"]').click();
  await expect(page).toHaveURL(/\/account\?reauth=sent/);
  await expect(page.getByText('A confirmation code was sent to your current number.')).toBeVisible();

  const link = page.locator('form[action="/api/account/mobile/link"]');
  await link.locator('input[name="destination"]').fill(added);
  await link.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/account\?.*sent=1/);

  const confirm = page.locator('form[action="/api/account/mobile/link/verify"]');
  await expect(confirm.locator('input[name="password"]')).toHaveCount(0);
  await confirm.locator('input[name="destination"]').fill(added);
  await confirm.locator('input[name="code"]').fill(CODE);
  await confirm.locator('input[name="reauthCode"]').fill(CODE);
  await confirm.locator('button[type="submit"]').click();

  await expect(page).toHaveURL(/\/account\?mobile=linked/);
  await expect(page.getByText('Your mobile number was added.')).toBeVisible();
});

test('holds the resend button for the cooldown the API sets', async ({ page }) => {
  await page.goto('/login/mobile');
  await page.fill('input[name="destination"]', nextNumber());
  await page.click('form[action="/api/auth/mobile/login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/login\/mobile\?sent=1/);

  const resend = page.getByTestId('resend-code');
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText(/Resend in \d+s/);
});

test('burns the code after five wrong guesses and refuses the right one afterwards', async ({ page }) => {
  const number = nextNumber();
  await register(page, number);
  await page.click('form[action="/api/auth/logout"] button[type="submit"]');

  await page.goto('/login/mobile');
  await page.fill('input[name="destination"]', number);
  await page.click('form[action="/api/auth/mobile/login"] button[type="submit"]');
  await expect(page).toHaveURL(/\/login\/mobile\?sent=1/);

  // The same six wrong digits every time: they are not the fixed code, so every one of
  // these is a failed attempt and the fifth is the one that spends the request.
  const wrong = CODE === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const form = page.locator('form[action="/api/auth/mobile/login/verify"]');
    await form.locator('input[name="code"]').fill(wrong);
    await confirmButton(page, '/api/auth/mobile/login/verify').click();
    await expect(page.getByText(/not valid/i)).toBeVisible();
  }

  const form = page.locator('form[action="/api/auth/mobile/login/verify"]');
  await form.locator('input[name="code"]').fill(CODE);
  await confirmButton(page, '/api/auth/mobile/login/verify').click();
  await expect(page.getByText(/not valid/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login\/mobile\?/);
});

test('answers a number nobody has exactly as it answers one that has an account', async ({ page }) => {
  const registered = nextNumber();
  await register(page, registered);
  await page.click('form[action="/api/auth/logout"] button[type="submit"]');

  async function noticeFor(destination: string): Promise<string> {
    await page.goto('/login/mobile');
    await page.fill('input[name="destination"]', destination);
    await page.click('form[action="/api/auth/mobile/login"] button[type="submit"]');
    await expect(page).toHaveURL(/\/login\/mobile\?sent=1/);
    return page.getByText(/We sent a six-digit code to/).innerText();
  }

  const known = await noticeFor(registered);
  const unknown = await noticeFor(nextNumber());

  // The two pages say the same thing about two different numbers: nothing in the answer
  // tells a stranger whether an account exists behind a number.
  expect(known).toContain(registered);
  expect(unknown).toContain('+91');
  expect(known.replace(registered, '<number>')).toBe(unknown.replace(/\+91\d+/, '<number>'));
});
