import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { closeEnrollment, expireAttempt, readAttemptsForEnrollment } from './attempts-fixture';
import { setCoinSetting } from './coin-settings';
import { publishSeededPaper, seedAuthor, seedBuilderFixture } from './tests-fixture';

/**
 * Phase 7, A4: the student's taking page over the real stack.
 *
 * The paper is seeded in SQL beside its bank (`./tests-fixture`) and the students are registered
 * through the real form, so the coin grant, the enrollment and the attempt are the stack's own.
 * The e2e run is one worker on one shared database: every setting this file reads is pinned with
 * the upsert-and-verify fixture and restored in `afterAll`, which runs even when a test fails;
 * every email and title carries a marker unique to the run, and no test leaves an expired
 * `IN_PROGRESS` attempt behind — the worker's sweeper finalises any it finds.
 *
 * Every locator action is bounded by `actionTimeout`, so an element that never appears is a
 * fifteen-second failure that names it, rather than a step that quietly eats the test's budget.
 *
 * The paper has two questions, so every expected number below is arithmetic anyone can check:
 * each question is worth 2.00 and a wrong answer costs 0.50.
 */

const PASSWORD = 'correct-horse-9battery';
const CLIENT_IP = '198.18.0.51';

test.use({
  extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP },
  // A locator action that never finds its element fails with its name, not with the test timeout.
  actionTimeout: 15_000,
});

const marker = randomUUID().slice(0, 8);

const longTitle = `Taking paper ${marker}`;
const shortTitle = `Taking minute paper ${marker}`;
const alphaText = `Taking alpha question ${marker}`;
const betaText = `Taking beta question ${marker}`;

let longTest = '';
let shortTest = '';

let enrollmentA = '';
let attemptA = '';

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
  await expect(page).toHaveURL(/\/account/);
}

/**
 * Registers, signs in, enrolls through the real form and follows the enrollment list's own
 * "Open attempt" link, so the entry point this unit adds is what the rest of the file proves.
 */
async function enrollAndOpen(
  page: Page,
  email: string,
  fullName: string,
  paper: { readonly testId: string; readonly title: string },
): Promise<string> {
  await test.step('register and verify', async () => {
    await registerStudent(page, email, fullName);
  });
  await test.step('sign in', async () => {
    await signIn(page, email);
  });
  await test.step('enroll', async () => {
    await page.goto(`/tests/${paper.testId}`);
    await expect(page.getByTestId('enroll-button'), 'the enroll form for a fresh student').toBeVisible();
    await page.getByTestId('enroll-button').click();
    await expect(page).toHaveURL(new RegExp(`/tests/${paper.testId}\\?enrolled=1`));
  });
  await test.step('open the attempt from the enrollment list', async () => {
    await page.goto('/tests');
    const row = page.getByTestId('enrollment-row').filter({ hasText: paper.title });
    await expect(row).toBeVisible();

    const link = row.getByTestId('enrollment-open-attempt');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/attempt\/[0-9a-f-]{36}$/);
  });

  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

test.describe.serial('taking an attempt', () => {
  test.beforeAll(() => {
    const author = seedAuthor(marker);
    const bank = seedBuilderFixture({
      editorId: author.authorId,
      marker,
      alphaText,
      betaText,
    });

    longTest = publishSeededPaper({
      authorId: author.authorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: longTitle,
      durationMinutes: 45,
      maxAttempts: 5,
    }).testId;

    shortTest = publishSeededPaper({
      authorId: author.authorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: shortTitle,
      durationMinutes: 1,
      maxAttempts: 5,
    }).testId;

    setCoinSetting('signup_coins', 1_000);
    setCoinSetting('daily_reward_coins', 0);
    setCoinSetting('default_enrollment_cost', 100);
    setCoinSetting('attempt_submit_grace_seconds', 5);
  });

  test.afterAll(() => {
    setCoinSetting('signup_coins', 1_000);
    setCoinSetting('daily_reward_coins', 10);
    setCoinSetting('default_enrollment_cost', 100);
    setCoinSetting('attempt_submit_grace_seconds', 5);
  });

  test('a student starts once, answers and submits, and the result is exact', async ({ page }) => {
    test.setTimeout(120_000);

    const email = `e2e-attempt-take-${marker}@example.com`;
    enrollmentA = await enrollAndOpen(page, email, 'Attempt E2E Student', {
      testId: longTest,
      title: longTitle,
    });
    expect(enrollmentA).not.toBe('');

    await expect(page.getByTestId('attempt-instructions')).toBeVisible();
    await expect(page.getByTestId('attempt-instructions')).toContainText('45 minutes');
    await expect(page.getByTestId('attempt-instructions')).toContainText('4.00 in total');

    // Every call this screen makes is kept — registered before the click that makes them — so
    // the bodies can be checked for an answer key and the calls proved to have happened.
    const seen: string[] = [];
    const bodies: Array<Promise<string>> = [];
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/attempts/') || path.startsWith('/api/enrollments/')) {
        seen.push(`${path} ${String(response.status())}`);
        bodies.push(response.text().catch(() => ''));
      }
    });

    // Two clicks in the same task: the first sets the ref guard, the second must do nothing.
    //
    // This is a plain page evaluation, not a locator evaluation: the Start button is replaced by
    // the paper as soon as the start response lands, and `locator.evaluate` retries while its
    // element is detached — so it waits forever for a button that can never come back, which is
    // a hang until the test timeout, not an assertion error.
    await expect(page.getByTestId('start-attempt')).toBeVisible();
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="start-attempt"]');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('the Start button is not on screen');
      }
      button.click();
      button.click();
    });

    await expect(page.getByTestId('attempt-question')).toBeVisible();
    await expect(page.getByTestId('attempt-countdown')).toHaveText(/^\d{2}:\d{2}$/);
    expect(readAttemptsForEnrollment(enrollmentA)).toBe(1);

    // The paper is on screen and no answer key or explanation came with it.
    await expect(page.locator('body')).not.toContainText('Alpha has no divisors');
    expect(await page.content()).not.toContain('Alpha has no divisors');

    // Question 1: the second option is the right one ("7"). Question 2 stays unanswered.
    await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
    await page.getByTestId('attempt-option').nth(1).click();
    await expect(page.getByTestId('answered-count')).toContainText('1 answered');

    await expect(page.getByTestId('next-question')).toBeEnabled();
    await page.getByTestId('next-question').click();
    await expect(page.getByTestId('attempt-question')).toHaveText('Question 2');
    await expect(page.getByTestId('previous-question')).toBeEnabled();
    await page.getByTestId('previous-question').click();
    await expect(page.getByTestId('attempt-question')).toHaveText('Question 1');

    await expect(page.getByTestId('submit-attempt')).toBeVisible();
    await page.getByTestId('submit-attempt').click();
    await expect(page.getByTestId('submit-confirm')).toContainText('left 1 question unanswered');
    await page.getByTestId('confirm-submit').click();

    await expect(page.getByTestId('attempt-result')).toBeVisible();
    await expect(page).toHaveURL(/\/attempt\/result\/[0-9a-f-]{36}$/);

    // 2.00 of 4.00 marks, one right, none wrong, one unattempted, 1 ÷ 1 accuracy.
    await expect(page.getByTestId('result-score')).toHaveText('2.00 of 4.00');
    await expect(page.getByTestId('result-accuracy')).toHaveText('100.00%');
    await expect(page.getByTestId('result-correct')).toHaveText('1');
    await expect(page.getByTestId('result-wrong')).toHaveText('0');
    await expect(page.getByTestId('result-unattempted')).toHaveText('1');
    await expect(page.getByTestId('result-attempted')).toHaveText('1 of 2');
    await expect(page.getByTestId('result-status')).toContainText('Submitted by you');

    // A4's result page is minimal: no question, no key, no explanation.
    await expect(page.locator('body')).not.toContainText(alphaText);
    await expect(page.locator('body')).not.toContainText('Alpha has no divisors');

    attemptA = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    expect(attemptA).not.toBe('');

    // The capture is real: the start, the state re-sync and the submit were all seen.
    expect(seen.some((entry) => entry.startsWith('/api/attempts/start 201'))).toBe(true);
    expect(seen.some((entry) => entry.endsWith('/state 200'))).toBe(true);
    expect(seen.some((entry) => entry.includes('/submit 200'))).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(3);

    for (const body of bodies) {
      const text = await body;
      expect(text).not.toMatch(/isCorrect|is_correct|correctOptionId|explanation|solution/i);
      expect(text).not.toContain('Alpha has no divisors');
    }
  });

  test('a reload cannot show the paper again and says so, with a countdown', async ({ page }) => {
    test.setTimeout(120_000);

    const email = `e2e-attempt-resume-${marker}@example.com`;
    const enrollmentId = await enrollAndOpen(page, email, 'Attempt Resume Student', {
      testId: longTest,
      title: longTitle,
    });
    expect(enrollmentId).not.toBe('');

    await expect(page.getByTestId('start-attempt')).toBeVisible();
    await page.getByTestId('start-attempt').click();
    await expect(page.getByTestId('attempt-question')).toBeVisible();
    await expect(page.locator('body')).toContainText(alphaText);

    await page.reload();

    // The cannot-resume screen is present — so this is not an empty or error page — and it
    // carries none of the paper.
    await expect(page.getByTestId('attempt-cannot-resume')).toBeVisible();
    await expect(page.getByTestId('attempt-cannot-resume')).toContainText('cannot be resumed');
    await expect(page.getByTestId('attempt-countdown')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.getByTestId('start-attempt')).toHaveCount(0);
    await expect(page.getByTestId('attempt-question')).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);

    await expect(page.locator('body')).not.toContainText(alphaText);
    await expect(page.locator('body')).not.toContainText(betaText);

    const html = await page.content();
    expect(html).not.toContain(alphaText);
    expect(html).not.toContain(betaText);
    expect(html).not.toContain('Alpha has no divisors');
  });

  test('at the deadline the page auto-submits and lands on the result with its answers', async ({ page }) => {
    test.setTimeout(180_000);

    const email = `e2e-attempt-deadline-${marker}@example.com`;
    await enrollAndOpen(page, email, 'Attempt Deadline Student', { testId: shortTest, title: shortTitle });

    await expect(page.getByTestId('start-attempt')).toBeVisible();
    await page.getByTestId('start-attempt').click();
    await expect(page.getByTestId('attempt-question')).toBeVisible();
    await expect(page.getByTestId('attempt-countdown')).toHaveText(/^\d{2}:\d{2}$/);

    // Question 1: the first option is wrong ("4"). Question 2: the second option is right ("6").
    await expect(page.getByTestId('attempt-option').nth(0)).toBeVisible();
    await page.getByTestId('attempt-option').nth(0).click();
    await expect(page.getByTestId('next-question')).toBeEnabled();
    await page.getByTestId('next-question').click();
    await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
    await page.getByTestId('attempt-option').nth(1).click();
    await expect(page.getByTestId('answered-count')).toContainText('2 answered');

    // 2.00 for the right one − 0.50 for the wrong one = 1.50 of 4.00; accuracy 1 ÷ 2 = 0.5000.
    await expect(page.getByTestId('attempt-result')).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId('result-score')).toHaveText('1.50 of 4.00');
    await expect(page.getByTestId('result-accuracy')).toHaveText('50.00%');
    await expect(page.getByTestId('result-correct')).toHaveText('1');
    await expect(page.getByTestId('result-wrong')).toHaveText('1');
    await expect(page.getByTestId('result-unattempted')).toHaveText('0');
    await expect(page.getByTestId('result-attempted')).toHaveText('2 of 2');
    await expect(page.getByTestId('result-status')).toContainText('Submitted by you');
  });

  test('a submit that arrives after the deadline is refused and the result says so', async ({ page }) => {
    test.setTimeout(120_000);

    const email = `e2e-attempt-late-${marker}@example.com`;
    await enrollAndOpen(page, email, 'Attempt Late Student', { testId: longTest, title: longTitle });

    await expect(page.getByTestId('start-attempt')).toBeVisible();
    await page.getByTestId('start-attempt').click();
    await expect(page.getByTestId('attempt-question')).toBeVisible();
    await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
    await page.getByTestId('attempt-option').nth(1).click();

    // The request is held until the server's own clock has passed the deadline, then released.
    // The window in which the worker's sweeper could finalise the attempt first is the gap
    // between the commit below and the request reaching the API: a few milliseconds. If the
    // sweeper did win, the student's late answers are still never scored — but the page would
    // then land on the plain result, so the spec asserts the message it must show.
    await page.route('**/api/attempts/*/submit', async (route) => {
      const match = /\/api\/attempts\/([0-9a-f-]{36})\/submit$/.exec(new URL(route.request().url()).pathname);
      const id = match?.[1] ?? '';
      expect(id).not.toBe('');

      expireAttempt(id);
      await route.continue();
    });

    await expect(page.getByTestId('submit-attempt')).toBeVisible();
    await page.getByTestId('submit-attempt').click();
    await expect(page.getByTestId('confirm-submit')).toBeVisible();
    await page.getByTestId('confirm-submit').click();

    await expect(page.getByTestId('attempt-result')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/attempt\/result\/[0-9a-f-]{36}\?late=1$/);
    await expect(page.getByTestId('result-late')).toContainText('Time ran out before your answers arrived');
    await expect(page.getByTestId('result-score')).toHaveText('0.00 of 4.00');
    await expect(page.getByTestId('result-status')).toContainText('Ended automatically at the deadline');
  });

  test('another student’s attempt, an unknown one and a closed one are all not available', async ({ page, browser }) => {
    test.setTimeout(90_000);

    // A second student, so the ids below are somebody else's and must answer like unknown ones.
    const email = `e2e-attempt-access-${marker}@example.com`;
    await registerStudent(page, email, 'Attempt Access Student');
    await signIn(page, email);

    await page.goto(`/attempt/${enrollmentA}`);
    await expect(page.getByTestId('attempt-missing')).toBeVisible();

    await page.goto(`/attempt/result/${attemptA}`);
    await expect(page.getByTestId('result-missing')).toBeVisible();

    await page.goto(`/attempt/${randomUUID()}`);
    await expect(page.getByTestId('attempt-missing')).toBeVisible();

    await page.goto(`/attempt/result/${randomUUID()}`);
    await expect(page.getByTestId('result-missing')).toBeVisible();

    // The same student enrolls, and the enrollment is closed before it is ever started.
    await page.goto(`/tests/${longTest}`);
    await expect(page.getByTestId('enroll-button'), 'the enroll form for a fresh student').toBeVisible();
    await page.getByTestId('enroll-button').click();
    await expect(page).toHaveURL(new RegExp(`/tests/${longTest}\\?enrolled=1`));

    await page.goto('/tests');
    const row = page.getByTestId('enrollment-row').filter({ hasText: longTitle });
    await expect(row).toBeVisible();
    const href = await row.getByTestId('enrollment-open-attempt').getAttribute('href');
    const closedEnrollment = (href ?? '').split('/').at(-1) ?? '';
    expect(closedEnrollment).not.toBe('');

    closeEnrollment(closedEnrollment);

    await page.goto(`/attempt/${closedEnrollment}`);
    await expect(page.getByTestId('attempt-missing')).toBeVisible();

    // An anonymous visitor is sent to sign in, on the entry and on the result.
    const anonymousContext = await browser.newContext();
    const anonymous = await anonymousContext.newPage();

    await anonymous.goto(`/attempt/${enrollmentA}`);
    await expect(anonymous).toHaveURL(/\/login\?next=%2Fattempt%2F[0-9a-f-]{36}$/);

    await anonymous.goto(`/attempt/result/${attemptA}`);
    await expect(anonymous).toHaveURL(/\/login\?next=%2Fattempt%2Fresult%2F[0-9a-f-]{36}$/);

    await anonymousContext.close();
  });
});
