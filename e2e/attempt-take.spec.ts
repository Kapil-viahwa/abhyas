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
 * Two rounds of guessing at a silent "Test timeout of 120000ms exceeded" did not fix anything, so
 * every phase and every await that has no timeout of its own now runs through `step`, which logs
 * when it starts, when it ends and how long it took, and fails with "STEP <name> exceeded <ms>"
 * rather than leaving the test to time out with no message. On failure `afterEach` prints the URL,
 * the visible text, the page errors, the console errors, the failed requests and every response
 * it saw (method, path, status — never a body) into the job log.
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

const STEP_LOG = '[attempt-take]';
const DEFAULT_STEP_LIMIT_MS = 20_000;

let longTest = '';
let shortTest = '';

let enrollmentA = '';
let attemptA = '';

type Timer = ReturnType<typeof setTimeout>;

/**
 * Runs one phase under a ceiling, and says so in the job log.
 *
 * A test timeout arrives with no assertion message, so a phase that never settles is invisible.
 * This races the phase against a timer: the log names the phase that started and never finished
 * even when Playwright's own timeout is what eventually ends the run.
 */
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

/** What the failure dump prints; filled per test, one worker so there is one at a time. */
let capture: PageCapture = { pageErrors: [], consoleErrors: [], failedRequests: [], responses: [] };

function pathOf(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}

/**
 * Collects what the browser did, without any body, cookie or header: page errors, console errors
 * and warnings, failed requests, and each response's method, path and status.
 */
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
    seen.failedRequests.push(
      `${request.method()} ${pathOf(request.url())} ${request.failure()?.errorText ?? ''}`.trim(),
    );
  });
  page.on('response', (response) => {
    seen.responses.push(`${response.request().method()} ${pathOf(response.url())} ${String(response.status())}`);
  });

  return seen;
}

function head(lines: readonly string[], count: number): readonly string[] {
  return lines.length <= count ? lines : [...lines.slice(0, count), `... ${String(lines.length - count)} more`];
}

/** The fixture's explanation text: only an answer key or the review would carry it. */
const EXPLANATION_TEXT = 'Alpha has no divisors';

/**
 * The shapes of an answer key and of the review body.
 *
 * A response body is JSON, so a key name is a marker. The rendered page is prose, where the bare
 * word "correct" appears legitimately ("for a correct answer", the "Correct" result label), so the
 * page scan uses these shapes and the explanation text instead of that word; the body scan also
 * refuses a bare `"correct"` key.
 */
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

/** The markers a response body must not carry. */
function leakedKeys(body: string): string[] {
  const lower = body.toLowerCase();
  const found = LEAK_MARKERS.filter((marker) => lower.includes(marker));

  if (body.replace(/\s+/g, '').includes('"correct":')) {
    found.push('a "correct" key');
  }

  return found;
}

/** The fixture texts that only an answer key or a review would carry. */
function leakedText(body: string): string[] {
  return body.includes(EXPLANATION_TEXT) ? ['the explanation text'] : [];
}

/** The page as it is right now, read page-scoped and bounded like every other step. */
async function readPage(page: Page): Promise<{ readonly text: string; readonly html: string }> {
  return step('read the page', async () => ({
    text: await page.evaluate(() => document.body.innerText),
    html: await page.content(),
  }));
}

/** Prints what the page was doing when the test failed. Never a body, a cookie or a header. */
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

  console.log(`${STEP_LOG} page errors: ${JSON.stringify(head(capture.pageErrors, 20))}`);
  console.log(`${STEP_LOG} console errors: ${JSON.stringify(head(capture.consoleErrors, 20))}`);
  console.log(`${STEP_LOG} failed requests: ${JSON.stringify(head(capture.failedRequests, 40))}`);
  console.log(`${STEP_LOG} responses: ${JSON.stringify(head(capture.responses, 80))}`);
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

  const token = await step('wait for the verification link', async () => waitForLink(before, /verify-email\?token=([A-Za-z0-9_-]+)/));
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

test.beforeEach(({ page }) => {
  capture = capturePage(page);
  console.log(`${STEP_LOG} --- test start ---`);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await dumpPage(page);
  }
});

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
    enrollmentA = await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Attempt E2E Student', { testId: longTest, title: longTitle }),
    );
    expect(enrollmentA).not.toBe('');

    await step('instructions shown', async () => {
      await expect(page.getByTestId('attempt-instructions')).toBeVisible();
      await expect(page.getByTestId('attempt-instructions')).toContainText('45 minutes');
      await expect(page.getByTestId('attempt-instructions')).toContainText('4.00 in total');
    });

    // The scan has to be capable of failing: plant a key name and the fixture's explanation and
    // require the very scanners the checks below use to find them.
    await step('the key scan can fail', async () => {
      expect(leakedKeys('{"isCorrect":true}')).toContain('iscorrect');
      expect(leakedKeys('{"correct":0}')).toContain('a "correct" key');
      expect(leakedText(`<p>${EXPLANATION_TEXT}</p>`)).toContain('the explanation text');
    });

    await step('the instructions carry no key', async () => {
      const view = await readPage(page);
      expect(leakedKeys(view.html)).toEqual([]);
      expect(leakedText(view.html)).toEqual([]);
    });

    // The wait is created before the click that triggers it, and the body is read immediately
    // after: a body read later, once the page has navigated away from that response, never
    // settles — which is what made this spec hang silently for three rounds.
    const startWait = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/attempts/start' &&
        response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    // Handled even if the test fails before reaching the await, so its timeout cannot surface as
    // an unhandled rejection in the worker.
    void startWait.catch(() => undefined);

    // Two clicks in the same task: the first sets the ref guard, the second must do nothing.
    //
    // This is a plain page evaluation, not a locator evaluation: the Start button is replaced by
    // the paper as soon as the start response lands, and `locator.evaluate` retries while its
    // element is detached.
    await step('press Start twice', async () => {
      await expect(page.getByTestId('start-attempt')).toBeVisible();
      await page.evaluate(() => {
        const button = document.querySelector('[data-testid="start-attempt"]');
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('the Start button is not on screen');
        }
        button.click();
        button.click();
      });
    });

    const startResponse = await step('read the start response', async () => startWait, 30_000);
    const startBody = await step('read the start body', async () => startResponse.text(), 15_000);

    await step('paper shown', async () => {
      await expect(page.getByTestId('attempt-question')).toBeVisible();
      await expect(page.getByTestId('attempt-countdown')).toHaveText(/^\d{2}:\d{2}$/);
    });

    await step('exactly one attempt exists', async () =>
      expect(await step('read the attempt count', async () => readAttemptsForEnrollment(enrollmentA))).toBe(1),
    );

    // The stem is on the paper, as it must be, so this checks the key and the explanation only.
    await step('the paper carries no key', async () => {
      const view = await readPage(page);
      expect(leakedKeys(view.html)).toEqual([]);
      expect(leakedText(view.html)).toEqual([]);
    });

    await step('answer the first question', async () => {
      // Question 1: the second option is the right one ("7"). Question 2 stays unanswered.
      await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
      await page.getByTestId('attempt-option').nth(1).click();
      await expect(page.getByTestId('answered-count')).toContainText('1 answered');
    });

    await step('move between questions', async () => {
      await expect(page.getByTestId('next-question')).toBeEnabled();
      await page.getByTestId('next-question').click();
      await expect(page.getByTestId('attempt-question')).toHaveText('Question 2');
      await expect(page.getByTestId('previous-question')).toBeEnabled();
      await page.getByTestId('previous-question').click();
      await expect(page.getByTestId('attempt-question')).toHaveText('Question 1');
    });

    // The page re-syncs the state right before it submits, so both waits are created before the
    // confirm click that lets them happen, and both bodies are read immediately after.
    const stateWait = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/state'),
      { timeout: 30_000 },
    );
    const submitWait = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/submit') && response.request().method() === 'POST',
      { timeout: 30_000 },
    );
    void stateWait.catch(() => undefined);
    void submitWait.catch(() => undefined);

    await step('submit through the confirm step', async () => {
      await expect(page.getByTestId('submit-attempt')).toBeVisible();
      await page.getByTestId('submit-attempt').click();
      await expect(page.getByTestId('submit-confirm')).toContainText('left 1 question unanswered');
      await page.getByTestId('confirm-submit').click();
      await expect(page.getByTestId('attempt-result')).toBeVisible();
      await expect(page).toHaveURL(/\/attempt\/result\/[0-9a-f-]{36}$/);
    });

    const stateResponse = await step('read the state response', async () => stateWait, 30_000);
    const stateBody = await step('read the state body', async () => stateResponse.text(), 15_000);
    const submitResponse = await step('read the submit response', async () => submitWait, 30_000);
    const submitBody = await step('read the submit body', async () => submitResponse.text(), 15_000);

    await step('result is exact', async () => {
      // 2.00 of 4.00 marks, one right, none wrong, one unattempted, 1 ÷ 1 accuracy.
      await expect(page.getByTestId('result-score')).toHaveText('2.00 of 4.00');
      await expect(page.getByTestId('result-accuracy')).toHaveText('100.00%');
      await expect(page.getByTestId('result-correct')).toHaveText('1');
      await expect(page.getByTestId('result-wrong')).toHaveText('0');
      await expect(page.getByTestId('result-unattempted')).toHaveText('1');
      await expect(page.getByTestId('result-attempted')).toHaveText('1 of 2');
      await expect(page.getByTestId('result-status')).toContainText('Submitted by you');
    });

    // A4's result page is minimal: no question, no key, no explanation.
    await step('result page is minimal', async () => {
      const view = await readPage(page);
      expect(view.text).not.toContain(alphaText);
      expect(view.text).not.toContain(betaText);
      expect(view.html).not.toContain(alphaText);
      expect(view.html).not.toContain(betaText);
      expect(leakedKeys(view.html)).toEqual([]);
      expect(leakedText(view.html)).toEqual([]);
    });

    attemptA = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    expect(attemptA).not.toBe('');

    await step('the capture is real and carries no key', async () => {
      // An empty or unexpected capture must never pass: every endpoint is asserted by its status.
      expect([200, 201]).toContain(startResponse.status());
      expect(stateResponse.status()).toBe(200);
      expect(submitResponse.status()).toBe(200);

      const captured = [
        { endpoint: 'POST /api/attempts/start', body: startBody },
        { endpoint: 'GET /api/attempts/:id/state', body: stateBody },
        { endpoint: 'POST /api/attempts/:id/submit', body: submitBody },
      ];

      for (const entry of captured) {
        // Only the endpoint and the marker names are ever printed, never the body.
        expect({ endpoint: entry.endpoint, leaked: leakedKeys(entry.body) }).toEqual({
          endpoint: entry.endpoint,
          leaked: [],
        });
        expect({ endpoint: entry.endpoint, leaked: leakedText(entry.body) }).toEqual({
          endpoint: entry.endpoint,
          leaked: [],
        });
      }
    });
  });

  test('a reload cannot show the paper again and says so, with a countdown', async ({ page }) => {
    test.setTimeout(120_000);

    const email = `e2e-attempt-resume-${marker}@example.com`;
    const enrollmentId = await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Attempt Resume Student', { testId: longTest, title: longTitle }),
    );
    expect(enrollmentId).not.toBe('');

    await step('start the attempt', async () => {
      await expect(page.getByTestId('start-attempt')).toBeVisible();
      await page.getByTestId('start-attempt').click();
      await expect(page.getByTestId('attempt-question')).toBeVisible();
      await expect(page.locator('body')).toContainText(alphaText);
    });

    // The runner arms a beforeunload warning while the paper is on screen. Accept the dialog
    // explicitly, so a reload can never wait on a dialog nobody answers.
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });

    await step('reload', async () => {
      await page.reload();
    });

    await step('cannot resume, and none of the paper is on the page', async () => {
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

      const view = await readPage(page);
      expect(view.text).not.toContain(alphaText);
      expect(view.text).not.toContain(betaText);
      expect(view.html).not.toContain(alphaText);
      expect(view.html).not.toContain(betaText);
      expect(leakedKeys(view.html)).toEqual([]);
      expect(leakedText(view.html)).toEqual([]);
    });
  });

  test('at the deadline the page auto-submits and lands on the result with its answers', async ({ page }) => {
    test.setTimeout(180_000);

    const email = `e2e-attempt-deadline-${marker}@example.com`;
    await step('enroll and open the entry page', async () =>
      enrollAndOpen(page, email, 'Attempt Deadline Student', { testId: shortTest, title: shortTitle }),
    );

    await step('start and show the paper', async () => {
      await expect(page.getByTestId('start-attempt')).toBeVisible();
      await page.getByTestId('start-attempt').click();
      await expect(page.getByTestId('attempt-question')).toBeVisible();
      await expect(page.getByTestId('attempt-countdown')).toHaveText(/^\d{2}:\d{2}$/);
    });

    await step('answer both questions', async () => {
      // Question 1: the first option is wrong ("4"). Question 2: the second option is right ("6").
      await expect(page.getByTestId('attempt-option').nth(0)).toBeVisible();
      await page.getByTestId('attempt-option').nth(0).click();
      await expect(page.getByTestId('next-question')).toBeEnabled();
      await page.getByTestId('next-question').click();
      await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
      await page.getByTestId('attempt-option').nth(1).click();
      await expect(page.getByTestId('answered-count')).toContainText('2 answered');
    });

    await step(
      'the page auto-submits at the deadline',
      async () => {
        // The attempt lasts one minute; the page's own submit lands at the deadline and the grace
        // window (5 s) is what keeps the sweeper out of it, so this must end as the student's own
        // submission with the answers it held.
        await expect(page.getByTestId('attempt-result')).toBeVisible({ timeout: 85_000 });
      },
      90_000,
    );

    await step('result carries the auto-submitted answers', async () => {
      // 2.00 for the right one − 0.50 for the wrong one = 1.50 of 4.00; accuracy 1 ÷ 2 = 0.5000.
      await expect(page.getByTestId('result-score')).toHaveText('1.50 of 4.00');
      await expect(page.getByTestId('result-accuracy')).toHaveText('50.00%');
      await expect(page.getByTestId('result-correct')).toHaveText('1');
      await expect(page.getByTestId('result-wrong')).toHaveText('1');
      await expect(page.getByTestId('result-unattempted')).toHaveText('0');
      await expect(page.getByTestId('result-attempted')).toHaveText('2 of 2');
      await expect(page.getByTestId('result-status')).toContainText('Submitted by you');
    });
  });

  test('a submit that arrives after the deadline is refused and the result says so', async ({ page }) => {
    test.setTimeout(120_000);

    // Grace is pinned to zero for this test, and restored whatever happens, so a failure here
    // cannot shorten another spec's window in the shared database.
    setCoinSetting('attempt_submit_grace_seconds', 0);

    try {
      const email = `e2e-attempt-late-${marker}@example.com`;
      await step('enroll and open the entry page', async () =>
        enrollAndOpen(page, email, 'Attempt Late Student', { testId: longTest, title: longTitle }),
      );

      await step('start and answer', async () => {
        await expect(page.getByTestId('start-attempt')).toBeVisible();
        await page.getByTestId('start-attempt').click();
        await expect(page.getByTestId('attempt-question')).toBeVisible();
        await expect(page.getByTestId('attempt-option').nth(1)).toBeVisible();
        await page.getByTestId('attempt-option').nth(1).click();
      });

      // The request is held until the server's own clock has passed the deadline, then released.
      // The window in which the worker's sweeper could finalise the attempt first is the gap
      // between the commit below and the request reaching the API: a few milliseconds. If the
      // sweeper did win, the student's late answers are still never scored — but the page would
      // then land on the plain result, so the spec asserts the message it must show.
      await step('hold the submit until the deadline has passed', async () => {
        await page.route('**/api/attempts/*/submit', async (route) => {
          try {
            const match = /\/api\/attempts\/([0-9a-f-]{36})\/submit$/.exec(new URL(route.request().url()).pathname);
            const id = match?.[1] ?? '';
            expect(id).not.toBe('');

            await step('expire the attempt in the database', async () => {
              expireAttempt(id);
            });
          } finally {
            // A held route that is never released hangs the page, so it is always released.
            await route.continue();
          }
        });
      });

      await step('submit after the deadline', async () => {
        await expect(page.getByTestId('submit-attempt')).toBeVisible();
        await page.getByTestId('submit-attempt').click();
        await expect(page.getByTestId('confirm-submit')).toBeVisible();
        await page.getByTestId('confirm-submit').click();
        await expect(page.getByTestId('attempt-result')).toBeVisible({ timeout: 30_000 });
        await expect(page).toHaveURL(/\/attempt\/result\/[0-9a-f-]{36}\?late=1$/);
      });

      await step('result says the time ran out and nothing was scored', async () => {
        await expect(page.getByTestId('result-late')).toContainText('Time ran out before your answers arrived');
        await expect(page.getByTestId('result-score')).toHaveText('0.00 of 4.00');
        await expect(page.getByTestId('result-status')).toContainText('Ended automatically at the deadline');
      });
    } finally {
      setCoinSetting('attempt_submit_grace_seconds', 5);
    }
  });

  test('another student’s attempt, an unknown one and a closed one are all not available', async ({ page, browser }) => {
    test.setTimeout(90_000);

    // A second student, so the ids below are somebody else's and must answer like unknown ones.
    const email = `e2e-attempt-access-${marker}@example.com`;
    await step('register a second student', async () => registerStudent(page, email, 'Attempt Access Student'));
    await step('sign in as the second student', async () => signIn(page, email));

    await step('another student’s ids are not available', async () => {
      await page.goto(`/attempt/${enrollmentA}`);
      await expect(page.getByTestId('attempt-missing')).toBeVisible();

      await page.goto(`/attempt/result/${attemptA}`);
      await expect(page.getByTestId('result-missing')).toBeVisible();

      await page.goto(`/attempt/${randomUUID()}`);
      await expect(page.getByTestId('attempt-missing')).toBeVisible();

      await page.goto(`/attempt/result/${randomUUID()}`);
      await expect(page.getByTestId('result-missing')).toBeVisible();
    });

    let closedEnrollment = '';
    await step('a closed enrollment is not available', async () => {
      // The same student enrolls, and the enrollment is closed before it is ever started.
      await page.goto(`/tests/${longTest}`);
      await expect(page.getByTestId('enroll-button'), 'the enroll form for a fresh student').toBeVisible();
      await page.getByTestId('enroll-button').click();
      await expect(page).toHaveURL(new RegExp(`/tests/${longTest}\\?enrolled=1`));

      await page.goto('/tests');
      const row = page.getByTestId('enrollment-row').filter({ hasText: longTitle });
      await expect(row).toBeVisible();
      const href = await row.getByTestId('enrollment-open-attempt').getAttribute('href');
      closedEnrollment = (href ?? '').split('/').at(-1) ?? '';
      expect(closedEnrollment).not.toBe('');

      closeEnrollment(closedEnrollment);

      await page.goto(`/attempt/${closedEnrollment}`);
      await expect(page.getByTestId('attempt-missing')).toBeVisible();
    });

    await step('an anonymous visitor is sent to sign in', async () => {
      const anonymousContext = await browser.newContext();
      const anonymous = await anonymousContext.newPage();

      await anonymous.goto(`/attempt/${enrollmentA}`);
      await expect(anonymous).toHaveURL(/\/login\?next=%2Fattempt%2F[0-9a-f-]{36}$/);

      await anonymous.goto(`/attempt/result/${attemptA}`);
      await expect(anonymous).toHaveURL(/\/login\?next=%2Fattempt%2Fresult%2F[0-9a-f-]{36}$/);

      await anonymousContext.close();
    });
  });
});
