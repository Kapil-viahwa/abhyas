import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { expireAttempt } from './attempts-fixture';
import { setCoinSetting } from './coin-settings';
import { publishSeededPaper, seedAuthor, seedBuilderFixture } from './tests-fixture';

/**
 * Phase 7, A5: the result and the per-question review.
 *
 * This is the only page a student sees the answer key on, so the spec proves both halves: the
 * review of the caller's own ended attempt, and that no earlier response and no page before the
 * end carries it.
 *
 * Helpers and lessons are those of `attempt-take.spec.ts`: every await without a timeout of its
 * own runs through `step`, response bodies are read where they exist (a `waitForResponse` for the
 * start and the state re-sync, a `page.route` handler that fetches and fulfils for the submit),
 * and the failure dump prints the URL, the visible text and the response list — never a body.
 */

const PASSWORD = 'correct-horse-9battery';

test.use({
  actionTimeout: 15_000,
});

/** Each test registers from its own address, so a per-IP registration limit is never shared. */
async function useClientIp(page: Page, lastOctet: number): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.0.${String(lastOctet)}` });
}

const marker = randomUUID().slice(0, 8);

const longTitle = `Review paper ${marker}`;
const shortTitle = `Review minute paper ${marker}`;
const alphaText = `Review alpha question ${marker}`;
const betaText = `Review beta question ${marker}`;
const gammaText = `Review gamma question ${marker}`;

let longTest = '';
let shortTest = '';

const STEP_LOG = '[attempt-review]';
const DEFAULT_STEP_LIMIT_MS = 20_000;

/** The fixture's explanation texts: only the ended review may show them. */
const ALPHA_EXPLANATION = 'Alpha has no divisors';
const BETA_EXPLANATION = 'Beta is even';

/**
 * The fixture's option texts, unique per run so a scan for one can only find the paper's own.
 * The second option of each question is the correct one, as in the fixture's default.
 */
const ALPHA_OPTIONS = [
  `Review alpha option one ${marker}`,
  `Review alpha option two ${marker}`,
  `Review alpha option three ${marker}`,
] as const;
const BETA_OPTIONS = [
  `Review beta option one ${marker}`,
  `Review beta option two ${marker}`,
  `Review beta option three ${marker}`,
] as const;
const GAMMA_OPTIONS = [
  `Review gamma option one ${marker}`,
  `Review gamma option two ${marker}`,
  `Review gamma option three ${marker}`,
] as const;

/** The review's own words: the correct-answer marker. Only an ended attempt may show it. */
const CORRECT_MARKER = 'Correct answer';

/** Everything the result URL must not show while the attempt is still running. */
const FORBIDDEN_WHILE_IN_PROGRESS = [
  alphaText,
  betaText,
  gammaText,
  ...ALPHA_OPTIONS,
  ...BETA_OPTIONS,
  ...GAMMA_OPTIONS,
  CORRECT_MARKER,
  ALPHA_EXPLANATION,
  BETA_EXPLANATION,
];

/** Every forbidden phrase found in a page's text or HTML, in the list's own order. */
function leakedReview(body: string): string[] {
  return FORBIDDEN_WHILE_IN_PROGRESS.filter((phrase) => body.includes(phrase));
}

type Timer = ReturnType<typeof setTimeout>;

async function step<T>(name: string, run: () => Promise<T>, limitMs: number = DEFAULT_STEP_LIMIT_MS): Promise<T> {
  const started = Date.now();
  console.log(`${STEP_LOG} STEP ${name} start`);

  let timer: Timer | undefined;
  try {
    const result = await Promise.race<T>([
      run(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${STEP_LOG} STEP ${name} exceeded ${String(limitMs)}ms`));
        }, limitMs);
      }),
    ]);

    console.log(`${STEP_LOG} STEP ${name} done in ${String(Date.now() - started)}ms`);
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface PageCapture {
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  readonly failedRequests: string[];
  readonly responses: string[];
}

let capture: PageCapture = { pageErrors: [], consoleErrors: [], failedRequests: [], responses: [] };

function pathOf(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

/** What the browser did: methods, paths and statuses only — never a body, a cookie or a header. */
function capturePage(page: Page): PageCapture {
  const seen: PageCapture = { pageErrors: [], consoleErrors: [], failedRequests: [], responses: [] };

  page.on('pageerror', (error) => {
    seen.pageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      seen.consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    seen.failedRequests.push(`${request.method()} ${pathOf(request.url())} ${request.failure()?.errorText ?? ''}`.trim());
  });
  page.on('response', (response) => {
    seen.responses.push(`${response.request().method()} ${pathOf(response.url())} ${String(response.status())}`);
  });

  return seen;
}

async function dumpPage(page: Page): Promise<void> {
  console.log(`${STEP_LOG} --- FAILURE DUMP ---`);
  console.log(`${STEP_LOG} url: ${page.url()}`);

  let text = 'main thread unresponsive';
  let timer: Timer | undefined;
  try {
    text = await Promise.race([
      page.evaluate(() => document.body.innerText.slice(0, 1500)),
      new Promise<string>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('main thread unresponsive'));
        }, 5000);
      }),
    ]);
  } catch {
    text = 'main thread unresponsive';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
  console.log(`${STEP_LOG} body: ${text}`);
  console.log(`${STEP_LOG} page errors: ${JSON.stringify(capture.pageErrors.slice(0, 20))}`);
  console.log(`${STEP_LOG} console errors: ${JSON.stringify(capture.consoleErrors.slice(0, 20))}`);
  console.log(`${STEP_LOG} failed requests: ${JSON.stringify(capture.failedRequests.slice(0, 40))}`);
  console.log(`${STEP_LOG} responses: ${JSON.stringify(capture.responses.slice(0, 80))}`);
}

const LEAK_MARKERS = [
  'iscorrect',
  'is_correct',
  'correctoptionid',
  'correct_option_id',
  'numericalanswer',
  'numerical_answer',
  'explanationhtml',
  'solution',
];

/** Key names as a response body would spell them. */
function leakedKeys(body: string): string[] {
  const lower = body.toLowerCase();
  return LEAK_MARKERS.filter((markerName) => lower.includes(markerName));
}

/** The fixture texts that only the ended review may show. */
function leakedText(body: string): string[] {
  const found: string[] = [];
  if (body.includes(ALPHA_EXPLANATION)) {
    found.push('the alpha explanation');
  }
  if (body.includes(BETA_EXPLANATION)) {
    found.push('the beta explanation');
  }

  return found;
}

async function readPage(page: Page): Promise<{ readonly text: string; readonly html: string }> {
  return step('read the page', async () => ({
    text: await page.evaluate(() => document.body.innerText),
    html: await page.content(),
  }));
}

async function readBody(label: string, response: { text: () => Promise<string> }, limitMs = 15_000): Promise<string> {
  return step(`read the ${label} body`, async () => response.text(), limitMs);
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

  const token = await step('wait for the verification link', async () =>
    waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/),
  );
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

async function enrollAndOpen(
  page: Page,
  email: string,
  fullName: string,
  paper: { readonly testId: string; readonly title: string },
): Promise<string> {
  await step('register and verify', async () => registerStudent(page, email, fullName));
  await step('sign in', async () => signIn(page, email));

  await step('enroll', async () => {
    await page.goto(`/tests/${paper.testId}`);
    await expect(page.getByTestId('enroll-button'), 'the enroll form for a fresh student').toBeVisible();
    await page.getByTestId('enroll-button').click();
    await expect(page).toHaveURL(new RegExp(`/tests/${paper.testId}\\?enrolled=1`));
  });

  await step('open the attempt from the enrollment list', async () => {
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

/** Starts the attempt and returns the attempt id from the start response. */
async function startAttempt(page: Page): Promise<string> {
  const startWait = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/attempts/start' && response.request().method() === 'POST',
    { timeout: 30_000 },
  );
  void startWait.catch(() => undefined);

  await step('press Start', async () => {
    await expect(page.getByTestId('start-attempt')).toBeVisible();
    await page.getByTestId('start-attempt').click();
    await expect(page.getByTestId('attempt-question')).toBeVisible();
  });

  const startResponse = await step('read the start response', async () => startWait, 30_000);
  const startBody = await readBody('start', startResponse);

  // No key in the start response, and the scan is proven able to find one.
  expect(leakedKeys('{"isCorrect":true}')).toContain('iscorrect');
  expect(leakedKeys(startBody)).toEqual([]);
  expect(leakedText(startBody)).toEqual([]);

  const parsed = JSON.parse(startBody) as { attemptId?: unknown };
  const attemptId = typeof parsed.attemptId === 'string' ? parsed.attemptId : '';
  expect(attemptId).not.toBe('');

  return attemptId;
}

test.beforeEach(({ page }) => {
  capture = capturePage(page);
  console.log(`${STEP_LOG} --- test start ---`);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await dumpPage(page);
  }
});

test.describe.serial('the result and the review', () => {
  test.beforeAll(() => {
    const author = seedAuthor(marker);
    // Two banks, so the paper has three single-correct questions: one right, one wrong, one left.
    const bankA = seedBuilderFixture({
      editorId: author.authorId,
      marker,
      alphaText,
      betaText,
      alphaOptions: ALPHA_OPTIONS,
      betaOptions: BETA_OPTIONS,
    });
    const bankB = seedBuilderFixture({
      editorId: author.authorId,
      marker: `${marker}b`,
      alphaText: gammaText,
      betaText: `Review unused question ${marker}`,
      alphaOptions: GAMMA_OPTIONS,
    });

    longTest = publishSeededPaper({
      authorId: author.authorId,
      examId: bankA.examId,
      questionIds: [bankA.alphaQuestionId, bankA.betaQuestionId, bankB.alphaQuestionId],
      title: longTitle,
      durationMinutes: 45,
      maxAttempts: 5,
    }).testId;

    shortTest = publishSeededPaper({
      authorId: author.authorId,
      examId: bankA.examId,
      questionIds: [bankA.alphaQuestionId, bankA.betaQuestionId],
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

  test('a submitted attempt shows the exact summary and the full review', async ({ page }) => {
    test.setTimeout(180_000);
    await useClientIp(page, 61);

    const email = `e2e-review-submitted-${marker}@example.com`;
    await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Review Submitted Student', { testId: longTest, title: longTitle }),
    );

    await startAttempt(page);

    await step('answer one right and one wrong', async () => {
      // Q1 alpha: option 2 ("7") is right. Q2 beta: option 1 ("2") is wrong. Q3 stays unanswered.
      await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
      await page.getByTestId('attempt-option').nth(1).click();
      await expect(page.getByTestId('next-question')).toBeEnabled();
      await page.getByTestId('next-question').click();
      await expect(page.getByTestId('attempt-option').nth(0)).toBeVisible();
      await page.getByTestId('attempt-option').nth(0).click();
      await expect(page.getByTestId('answered-count')).toContainText('2 answered');
    });

    const stateWait = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/state'),
      { timeout: 30_000 },
    );
    void stateWait.catch(() => undefined);

    let submitStatus = 0;
    let submitBody = '';
    await step('capture the submit response', async () => {
      await page.route('**/api/attempts/*/submit', async (route) => {
        try {
          const response = await route.fetch();
          submitStatus = response.status();
          submitBody = await response.text();
          await route.fulfill({ response, body: submitBody });
        } catch {
          await route.continue().catch(() => undefined);
        }
      });
    });

    try {
      await step('submit through the confirm step', async () => {
        await expect(page.getByTestId('submit-attempt')).toBeVisible();
        await page.getByTestId('submit-attempt').click();
        await expect(page.getByTestId('submit-confirm')).toContainText('left 1 question unanswered');
        await page.getByTestId('confirm-submit').click();
        await expect(page.getByTestId('attempt-result')).toBeVisible();
      });
    } finally {
      await page.unroute('**/api/attempts/*/submit');
    }

    const stateResponse = await step('read the state response', async () => stateWait, 30_000);
    const stateBody = await readBody('state', stateResponse);

    await step('the paper responses carry no key', async () => {
      expect(leakedKeys(stateBody)).toEqual([]);
      expect(leakedText(stateBody)).toEqual([]);

      expect(submitStatus).toBe(200);
      expect(submitBody).not.toBe('');
      expect(leakedKeys(submitBody)).toEqual([]);
      expect(leakedText(submitBody)).toEqual([]);
      expect(JSON.parse(submitBody) as unknown).toEqual({ ok: true });
    });

    await step('the summary is exact', async () => {
      // 2 − 0.5 = 1.50 of 6.00; 1 correct, 1 wrong, 1 unattempted; accuracy 1 ÷ 2 = 0.5000.
      await expect(page.getByTestId('result-test-title')).toHaveText(longTitle);
      await expect(page.getByTestId('result-score')).toHaveText('1.50 of 6.00');
      await expect(page.getByTestId('result-accuracy')).toHaveText('50.00%');
      await expect(page.getByTestId('result-correct')).toHaveText('1');
      await expect(page.getByTestId('result-wrong')).toHaveText('1');
      await expect(page.getByTestId('result-unattempted')).toHaveText('1');
      await expect(page.getByTestId('result-attempted')).toHaveText('2 of 3');
      await expect(page.getByTestId('result-status')).toContainText('Submitted by you');
    });

    await step('the review shows every question with its markers and explanation', async () => {
      const cards = page.getByTestId('review-question');
      await expect(cards).toHaveCount(3);

      const first = cards.nth(0);
      await expect(first).toHaveAttribute('data-outcome', 'correct');
      await expect(first.getByTestId('review-marks')).toHaveText('+2');
      await expect(first.getByTestId('review-your-answer')).toHaveCount(1);
      await expect(first.getByTestId('review-correct-answer')).toHaveCount(1);
      await expect(first.getByTestId('review-wrong-answer')).toHaveCount(0);
      await expect(first.getByTestId('review-explanation')).toContainText(ALPHA_EXPLANATION);

      const second = cards.nth(1);
      await expect(second).toHaveAttribute('data-outcome', 'wrong');
      await expect(second.getByTestId('review-marks')).toHaveText('−0.5');
      await expect(second.getByTestId('review-your-answer')).toHaveCount(1);
      await expect(second.getByTestId('review-correct-answer')).toHaveCount(1);
      await expect(second.getByTestId('review-wrong-answer')).toHaveCount(1);
      await expect(second.getByTestId('review-explanation')).toContainText(BETA_EXPLANATION);

      const third = cards.nth(2);
      await expect(third).toHaveAttribute('data-outcome', 'unattempted');
      await expect(third.getByTestId('review-marks')).toHaveText('0');
      await expect(third.getByTestId('review-your-answer')).toHaveCount(0);
      await expect(third.getByTestId('review-correct-answer')).toHaveCount(1);
      await expect(third.getByTestId('review-unattempted')).toBeVisible();
      await expect(third.getByTestId('review-explanation')).toContainText(ALPHA_EXPLANATION);
    });

    await step('the filters show only what they name', async () => {
      await page.getByTestId('review-filter-wrong').click();
      await expect(page).toHaveURL(/\?show=wrong$/);
      await expect(page.getByTestId('review-question')).toHaveCount(1);
      await expect(page.getByTestId('review-question').first()).toHaveAttribute('data-outcome', 'wrong');

      await page.getByTestId('review-filter-unattempted').click();
      await expect(page).toHaveURL(/\?show=unattempted$/);
      await expect(page.getByTestId('review-question')).toHaveCount(1);
      await expect(page.getByTestId('review-question').first()).toHaveAttribute('data-outcome', 'unattempted');

      await page.getByTestId('review-filter-all').click();
      await expect(page).toHaveURL(/\?show=all$/);
      await expect(page.getByTestId('review-question')).toHaveCount(3);
    });
  });

  test('before the end the result page shows in-progress and none of the paper', async ({ page }) => {
    test.setTimeout(120_000);
    await useClientIp(page, 62);

    const email = `e2e-review-progress-${marker}@example.com`;
    await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Review Progress Student', { testId: longTest, title: longTitle }),
    );

    const attemptId = await startAttempt(page);

    await step('the result page refuses while the attempt runs', async () => {
      await page.goto(`/attempt/result/${attemptId}`);
      await expect(page.getByTestId('result-in-progress')).toBeVisible();
      await expect(page.getByTestId('result-in-progress')).toContainText('has not ended yet');

      // Not an empty page that passes by showing nothing: the message is on it, and the
      // review's own container is not.
      await expect(page.getByTestId('review-question')).toHaveCount(0);

      const view = await readPage(page);

      // Both scanners are proven able to find what they look for before their emptiness is
      // trusted: the page-text scan, the whole-page scan and the key-name scan.
      expect(leakedReview('<p>a quiet result page</p>')).toEqual([]);
      expect(
        leakedReview(
          `<p>${alphaText}</p><p>${ALPHA_OPTIONS[1]}</p><span>${CORRECT_MARKER}</span><p>${ALPHA_EXPLANATION}</p>`,
        ),
      ).toEqual([alphaText, ALPHA_OPTIONS[1], CORRECT_MARKER, ALPHA_EXPLANATION]);
      expect(leakedText(`<p>${ALPHA_EXPLANATION}</p>`)).toEqual(['the alpha explanation']);

      // Every stem, every option text, the correct-answer marker and the explanations: the
      // option texts also appear on the taking screen, but this is the RESULT URL while the
      // attempt is still running.
      for (const phrase of FORBIDDEN_WHILE_IN_PROGRESS) {
        expect(view.text, 'the result page text while the attempt runs').not.toContain(phrase);
      }

      expect(leakedReview(view.text)).toEqual([]);
      expect(leakedReview(view.html)).toEqual([]);
      expect(leakedKeys(view.html)).toEqual([]);
    });
  });

  test('an auto-submitted attempt shows 0.00 and every question unattempted', async ({ page }) => {
    test.setTimeout(120_000);
    await useClientIp(page, 63);

    const email = `e2e-review-auto-${marker}@example.com`;
    await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Review Auto Student', { testId: longTest, title: longTitle }),
    );

    const attemptId = await startAttempt(page);

    // The time-travel helper, after the start response: the attempt is expired before it is read,
    // so the result read finalises it (LAZY) or the worker's sweeper does — both end it the same way.
    await step('expire the attempt', async () => {
      expireAttempt(attemptId);
    });

    await step('the result shows the auto-submission and the key', async () => {
      await page.goto(`/attempt/result/${attemptId}`);
      await expect(page.getByTestId('attempt-result')).toBeVisible();

      await expect(page.getByTestId('result-status')).toContainText('Ended automatically at the deadline');
      await expect(page.getByTestId('result-score')).toHaveText('0.00 of 6.00');
      await expect(page.getByTestId('result-correct')).toHaveText('0');
      await expect(page.getByTestId('result-wrong')).toHaveText('0');
      await expect(page.getByTestId('result-unattempted')).toHaveText('3');
      await expect(page.getByTestId('result-auto-note')).toContainText('No answers were received');

      const cards = page.getByTestId('review-question');
      await expect(cards).toHaveCount(3);
      for (const index of [0, 1, 2]) {
        await expect(cards.nth(index)).toHaveAttribute('data-outcome', 'unattempted');
        await expect(cards.nth(index).getByTestId('review-unattempted')).toBeVisible();
        await expect(cards.nth(index).getByTestId('review-correct-answer')).toHaveCount(1);
      }
    });
  });

  test('the back button after the result does not show the paper again', async ({ page }) => {
    test.setTimeout(180_000);
    await useClientIp(page, 64);

    const email = `e2e-review-back-${marker}@example.com`;
    const enrollmentId = await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Review Back Student', { testId: shortTest, title: shortTitle }),
    );
    expect(enrollmentId).not.toBe('');

    await startAttempt(page);

    await step('submit the paper', async () => {
      await expect(page.getByTestId('submit-attempt')).toBeVisible();
      await page.getByTestId('submit-attempt').click();
      await expect(page.getByTestId('submit-confirm')).toBeVisible();
      await page.getByTestId('confirm-submit').click();
      await expect(page.getByTestId('attempt-result')).toBeVisible();
    });

    await step('going back never shows the paper', async () => {
      await page.goBack();

      // Whatever the browser restores, the paper must not be on screen and no stem may be in it.
      await expect(page.getByTestId('attempt-question')).toHaveCount(0);

      const view = await readPage(page);
      expect(view.text).not.toContain(alphaText);
      expect(view.text).not.toContain(betaText);
    });

    await step('the entry URL of an ended attempt sends the student to its result', async () => {
      await page.goto(`/attempt/${enrollmentId}`);

      await expect(page).toHaveURL(/\/attempt\/result\/[0-9a-f-]{36}/);
      await expect(page.getByTestId('attempt-result')).toBeVisible();

      const view = await readPage(page);
      expect(view.html).toContain('attempt-result');
    });
  });

  test('another student, an anonymous visitor and a malformed id', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await useClientIp(page, 65);

    // A first student with an ended attempt on the short paper, for the ids someone else will use.
    const ownerEmail = `e2e-review-owner-${marker}@example.com`;
    await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, ownerEmail, 'Review Owner Student', { testId: shortTest, title: shortTitle }),
    );
    const attemptId = await startAttempt(page);

    await step('submit the paper', async () => {
      await expect(page.getByTestId('submit-attempt')).toBeVisible();
      await page.getByTestId('submit-attempt').click();
      await expect(page.getByTestId('submit-confirm')).toBeVisible();
      await page.getByTestId('confirm-submit').click();
      await expect(page.getByTestId('attempt-result')).toBeVisible();
    });

    // The second student gets a context of its own: the owner above is still signed in, and
    // middleware sends a signed-in visitor from /register to /account.
    const otherEmail = `e2e-review-other-${marker}@example.com`;
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await other.context().setExtraHTTPHeaders({ 'x-forwarded-for': '198.18.0.66' });

    try {
      await step('register a second student', async () => registerStudent(other, otherEmail, 'Review Other Student'));
      await step('sign in as the second student', async () => signIn(other, otherEmail));

      await step('another student’s result is not available, and shows no review', async () => {
        await other.goto(`/attempt/result/${attemptId}`);
        await expect(other.getByTestId('result-missing')).toBeVisible();

        const view = await readPage(other);
        expect(view.text).not.toContain(alphaText);
        expect(leakedText(view.html)).toEqual([]);
      });

      await step('a malformed id is not available', async () => {
        await other.goto('/attempt/result/not-a-uuid');
        await expect(other.getByTestId('result-missing')).toBeVisible();
      });
    } finally {
      await otherContext.close();
    }

    await step('an anonymous visitor is sent to sign in', async () => {
      const anonymousContext = await browser.newContext();
      const anonymous = await anonymousContext.newPage();

      await anonymous.goto(`/attempt/result/${attemptId}`);
      await expect(anonymous).toHaveURL(/\/login\?next=%2Fattempt%2Fresult%2F[0-9a-f-]{36}$/);

      await anonymousContext.close();
    });
  });
});
