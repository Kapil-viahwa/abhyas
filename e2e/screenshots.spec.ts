import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, type BrowserContext, type Page } from '@playwright/test';

import { closeEnrollment } from './attempts-fixture';
import { galleryMarker, registerAccount, setRole, seedDraftPaper, submitPaper, userIdByEmail } from './screenshots-fixture';
import { publishSeededPaper, seedBuilderFixture } from './tests-fixture';

/**
 * The screenshot gallery.
 *
 * This spec photographs the running app; it asserts almost nothing about it, on purpose. Every
 * screen runs inside `step()` so a run reads like a tour, every shot is taken at two viewports and
 * named so the zip sorts the way the tour runs, and a screen that cannot be reached is recorded as
 * skipped with its reason instead of failing the job — the gallery is observation, and a missing
 * picture must not hide the rest.
 *
 * It runs in the `gallery` Playwright project only, which exists only when `E2E_SCREENSHOTS=1`
 * (see `playwright.config.ts`), and the `chromium` project ignores this file. The normal e2e job
 * therefore never touches it.
 *
 * Everything photographed is fixture data created here: `gallery-*-<marker>@example.com` accounts,
 * an exam of its own, questions of its own and papers of its own. Nothing real is read or printed.
 */

const PASSWORD = 'gallery-horse-9battery';
const CLIENT_IP = '198.18.0.91';
const CLIENT = { extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP } };
const OUT = 'screenshots';

interface Viewport {
  readonly name: 'phone' | 'desktop';
  readonly width: number;
  readonly height: number;
}

const VIEWPORTS: readonly Viewport[] = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

interface Metrics {
  readonly title: string;
  readonly imagesWithoutAlt: number;
  readonly inputsWithoutLabel: number;
  readonly horizontalOverflow: boolean;
  readonly smallestTap: { readonly width: number; readonly height: number; readonly label: string } | null;
  // F2: the structural checks the review now tracks, all measured in the rendered page.
  readonly h1Count: number;
  readonly mainCount: number;
  readonly below44: number;
  readonly below44Labels: readonly string[];
  readonly inlineExempt: number;
  readonly focusChecked: number;
  readonly focusWithoutStyle: number;
  readonly focusSample: readonly string[];
  readonly alerts: number;
  readonly errorFields: number;
  readonly errorFieldsWithoutDescription: number;
}

interface Row extends Metrics {
  readonly index: number;
  readonly area: string;
  readonly screen: string;
  readonly viewport: string;
  readonly file: string;
  readonly consoleErrors: readonly string[];
}

interface Skipped {
  readonly screen: string;
  readonly reason: string;
}

interface ErrorState {
  readonly where: string;
  readonly alerts: number;
  readonly fields: number;
  readonly withoutDescription: number;
}

const rows: Row[] = [];
const skipped: Skipped[] = [];
const errorStates: ErrorState[] = [];

test.describe.configure({ mode: 'serial' });

test.skip(process.env.E2E_SCREENSHOTS !== '1', 'the gallery runs only in the screenshots workflow');

/** Reads the accessibility and layout numbers the review is written from. */
async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return box.width > 1 && box.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };

    const imagesWithoutAlt = Array.from(document.querySelectorAll('img')).filter(
      (image) => (image.getAttribute('alt') ?? '') === '',
    ).length;

    const fields = Array.from(document.querySelectorAll('input, select, textarea'))
      .filter((field) => field.getAttribute('type') !== 'hidden')
      .filter(visible);

    const labelled = fields.filter((field) => {
      const id = field.getAttribute('id') ?? '';
      const hasFor = id !== '' && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null;
      return (
        hasFor ||
        field.closest('label') !== null ||
        (field.getAttribute('aria-label') ?? '') !== '' ||
        (field.getAttribute('aria-labelledby') ?? '') !== ''
      );
    }).length;

    const root = document.documentElement;
    const interactive = Array.from(document.querySelectorAll('a[href], button, [role="button"]')).filter(visible);

    let smallestWidth = 0;
    let smallestHeight = 0;
    let smallestLabel = '';
    for (const element of interactive) {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        continue;
      }
      if (smallestWidth === 0 || box.width * box.height < smallestWidth * smallestHeight) {
        smallestWidth = Math.round(box.width);
        smallestHeight = Math.round(box.height);
        smallestLabel = (element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 40);
      }
    }

    // F2: stand-alone controls below 44x44. A link inside a paragraph is prose — the exemption the
    // review names — and is counted separately rather than as a target that failed.
    const targets = Array.from(document.querySelectorAll('a[href], button, [role="button"], select')).filter(visible);
    const below = targets.filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width < 44 || box.height < 44;
    });
    const inline = below.filter((element) => element.tagName === 'A' && element.closest('p') !== null);
    const standalone = below.filter((element) => !inline.includes(element));
    const describe = (element: Element): string => {
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      const box = element.getBoundingClientRect();
      return `${element.tagName.toLowerCase()} "${text}" ${String(Math.round(box.width))}x${String(Math.round(box.height))}`;
    };

    // F2: does every control draw something when it takes keyboard focus? The style is sampled
    // before and after `focus({ focusVisible: true })` — the state a Tab key produces — and the
    // element is blurred again so the screenshot is taken exactly as the tour found it.
    const focusable = Array.from(
      document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    )
      .filter(visible)
      .filter((element) => !(element as HTMLInputElement).disabled)
      .slice(0, 150);
    const styleOf = (element: Element): string => {
      const computed = window.getComputedStyle(element);
      return `${computed.outlineStyle}|${computed.outlineWidth}|${computed.outlineColor}|${computed.boxShadow}`;
    };
    const focusSample: string[] = [];
    let focusWithoutStyle = 0;
    for (const element of focusable) {
      const before = styleOf(element);
      (element as HTMLElement).focus({ focusVisible: true } as unknown as FocusOptions);
      const after = styleOf(element);
      if (before === after) {
        focusWithoutStyle += 1;
        if (focusSample.length < 10) {
          focusSample.push(describe(element));
        }
      }
    }
    for (const element of focusable) {
      (element as HTMLElement).blur();
    }
    // Focusing can scroll the page or a scrollable panel; put every scroller back so the screenshot
    // is taken exactly as the tour found the screen.
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      if (element.scrollLeft !== 0) {
        element.scrollLeft = 0;
      }
      if (element.scrollTop !== 0) {
        element.scrollTop = 0;
      }
    }

    // F2: is the error state programmatically attached to its field?
    const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"]'));
    const errorFieldsWithoutDescription = invalid.filter((field) => {
      const target = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '');
      return target.length === 0 || target.some((id) => document.getElementById(id) === null);
    }).length;

    return {
      title: document.title,
      imagesWithoutAlt,
      inputsWithoutLabel: fields.length - labelled,
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      smallestTap: smallestWidth === 0 ? null : { width: smallestWidth, height: smallestHeight, label: smallestLabel },
      h1Count: document.querySelectorAll('h1').length,
      mainCount: document.querySelectorAll('main').length,
      below44: standalone.length,
      below44Labels: standalone.slice(0, 10).map(describe),
      inlineExempt: inline.length,
      focusChecked: focusable.length,
      focusWithoutStyle,
      focusSample,
      alerts: document.querySelectorAll('[role="alert"]').length,
      errorFields: invalid.length,
      errorFieldsWithoutDescription,
    };
  });
}

/** The error association on a page that is showing an error, without a screenshot. */
async function measureErrorState(page: Page): Promise<{ alerts: number; fields: number; withoutDescription: number }> {
  return page.evaluate(() => {
    const invalid = Array.from(document.querySelectorAll('[aria-invalid="true"]'));
    const withoutDescription = invalid.filter((field) => {
      const target = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id !== '');
      return target.length === 0 || target.some((id) => document.getElementById(id) === null);
    }).length;
    return {
      alerts: document.querySelectorAll('[role="alert"]').length,
      fields: invalid.length,
      withoutDescription,
    };
  });
}

/** The console errors seen while a page loads, drained between screens. */
class ConsoleLog {
  private entries: string[] = [];

  constructor(page: Page) {
    page.on('console', (message) => {
      if (message.type() === 'error') {
        this.entries.push(message.text());
      }
    });
    page.on('pageerror', (error) => {
      this.entries.push(error.message);
    });
  }

  drain(): string[] {
    const found = this.entries;
    this.entries = [];
    return found;
  }
}

let index = 0;

/**
 * Screenshots one screen at both viewports.
 *
 * `waitFor` is a selector that only appears once the screen has really rendered — never a sleep.
 * A screen that does not render in time is recorded as skipped and the tour continues.
 */
async function capture(
  page: Page,
  logs: ConsoleLog,
  area: string,
  screen: string,
  waitFor: string,
  before?: (viewport: Viewport) => Promise<void>,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ reducedMotion: 'reduce' });

    try {
      if (before !== undefined) {
        await before(viewport);
      }
      await page.locator(waitFor).first().waitFor({ state: 'visible', timeout: 15_000 });
    } catch (error) {
      skipped.push({ screen: `${area}/${screen} (${viewport.name})`, reason: error instanceof Error ? error.message.split('\n')[0] : String(error) });
      continue;
    }

    index += 1;
    const file = `${String(index).padStart(2, '0')}-${area}-${screen}-${viewport.name}.png`;
    const metrics = await measure(page);

    await page.screenshot({
      path: join(OUT, file),
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });

    const row: Row = { index, area, screen, viewport: viewport.name, file, ...metrics, consoleErrors: logs.drain() };
    rows.push(row);
    // One line per picture, so the run's log is readable on its own: the numbers, the smallest
    // tap target by name, and the text of each console error (trimmed) — the review is written
    // from this line and from report.json, never from a guess.
    // eslint-disable-next-line no-console
    console.log(
      `GALLERY ${file} | title=${metrics.title} | overflow=${String(metrics.horizontalOverflow)} | tap=${String(metrics.smallestTap?.width ?? 0)}x${String(metrics.smallestTap?.height ?? 0)} "${metrics.smallestTap?.label ?? ''}" | alt=${String(metrics.imagesWithoutAlt)} | labels=${String(metrics.inputsWithoutLabel)} | below44=${String(metrics.below44)}(+${String(metrics.inlineExempt)} inline) | h1=${String(metrics.h1Count)} main=${String(metrics.mainCount)} | focus-gaps=${String(metrics.focusWithoutStyle)}/${String(metrics.focusChecked)} | errors=${String(row.consoleErrors.length)}: ${row.consoleErrors.map((entry) => entry.replace(/\s+/g, ' ').slice(0, 140)).join(' || ')}`,
    );
  }
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
}

/** The ids the tour needs, filled as the restrictions the app has force them. */
test('captures every screen the fixtures can reach', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });

  const marker = galleryMarker();
  const studentEmail = `gallery-student-${marker}@example.com`;
  const editorEmail = `gallery-editor-${marker}@example.com`;
  const adminEmail = `gallery-admin-${marker}@example.com`;

  const contexts: BrowserContext[] = [];
  const openContext = async (): Promise<{ context: BrowserContext; page: Page; logs: ConsoleLog }> => {
    const context = await browser.newContext({ ...CLIENT, viewport: { width: 1280, height: 800 } });
    contexts.push(context);
    const page = await context.newPage();
    return { context, page, logs: new ConsoleLog(page) };
  };

  try {
    // ----------------------------------------------------------------------
    // Public screens, signed out
    // ----------------------------------------------------------------------
    const visitor = await openContext();

    await test.step('public: home', async () => {
      await visitor.page.goto('/');
      await capture(visitor.page, visitor.logs, '01-public', 'home', '[data-testid="api-status"]');
    });

    await test.step('public: exams', async () => {
      await visitor.page.goto('/exams');
      await capture(visitor.page, visitor.logs, '01-public', 'exams', 'h1');
    });

    await test.step('public: sign in', async () => {
      await visitor.page.goto('/login');
      await capture(visitor.page, visitor.logs, '01-public', 'login', 'input[name="email"]');
    });

    await test.step('public: register', async () => {
      await visitor.page.goto('/register');
      await capture(visitor.page, visitor.logs, '01-public', 'register', 'input[name="fullName"]');
    });

    await test.step('public: forgot password', async () => {
      await visitor.page.goto('/forgot-password');
      await capture(visitor.page, visitor.logs, '01-public', 'forgot-password', 'input[name="email"]');
    });

    await test.step('public: 404', async () => {
      await visitor.page.goto('/this-page-does-not-exist');
      await capture(visitor.page, visitor.logs, '01-public', 'not-found', 'h1');
    });

    // The error state of each auth form, reached without a screenshot: these pages read `?error=`
    // and render it, so the tour can see what the association looks like without inventing a
    // different screen or a new picture. Observation only, like everything else here.
    await test.step('public: the auth forms say what went wrong, and say it to a screen reader', async () => {
      const states = [
        { where: '/login', url: '/login?error=Wrong+email+or+password.' },
        { where: '/register', url: '/register?error=Choose+a+longer+password.' },
        { where: '/forgot-password', url: '/forgot-password?error=That+request+could+not+be+accepted.' },
      ];
      for (const state of states) {
        await visitor.page.goto(state.url);
        await visitor.page.locator('[role="alert"]').first().waitFor({ state: 'visible', timeout: 15_000 });
        errorStates.push({ where: state.where, ...(await measureErrorState(visitor.page)) });
      }
    });

    // ----------------------------------------------------------------------
    // Accounts: three roles, registered and verified through the real forms
    // ----------------------------------------------------------------------
    const student = await openContext();
    const editor = await openContext();
    const admin = await openContext();

    await test.step('accounts: student registers and verifies', async () => {
      await registerAccount(student.page, { fullName: 'Gallery Student', email: studentEmail, password: PASSWORD });
      await capture(student.page, student.logs, '02-account', 'verify-email-sent', '[data-testid="resend-code"], h1');
    });

    await test.step('accounts: editor and admin register and verify', async () => {
      await registerAccount(editor.page, { fullName: 'Gallery Editor', email: editorEmail, password: PASSWORD });
      await registerAccount(admin.page, { fullName: 'Gallery Administrator', email: adminEmail, password: PASSWORD });
      setRole(editorEmail, 'EDITOR');
      setRole(adminEmail, 'ADMIN');
    });

    const studentId = userIdByEmail(studentEmail);
    const editorId = userIdByEmail(editorEmail);

    // ----------------------------------------------------------------------
    // Fixture data: an exam of its own, three published papers and two drafts
    // ----------------------------------------------------------------------
    const bank = seedBuilderFixture({
      editorId,
      marker,
      alphaText: `Gallery alpha question ${marker}: what is <span class="katex">7</span> plus <span class="katex">2</span>?`,
      betaText: `Gallery beta question ${marker}: which number is even?`,
      numericalText: `Gallery numerical question ${marker}`,
    });

    const paperOne = publishSeededPaper({
      authorId: editorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: `Gallery Paper One ${marker}`,
      maxAttempts: null,
    });
    const paperTwo = publishSeededPaper({
      authorId: editorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: `Gallery Paper Two ${marker}`,
      maxAttempts: null,
    });
    const paperThree = publishSeededPaper({
      authorId: editorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId],
      title: `Gallery Paper Three ${marker}`,
      maxAttempts: null,
    });
    const draft = seedDraftPaper({
      authorId: editorId,
      examId: bank.examId,
      questionIds: [bank.alphaQuestionId, bank.betaQuestionId],
      title: `Gallery Draft ${marker}`,
    });
    const submitted = seedDraftPaper({
      authorId: editorId,
      examId: bank.examId,
      questionIds: [bank.betaQuestionId],
      title: `Gallery Submitted ${marker}`,
    });
    submitPaper(submitted.testId);

    // ----------------------------------------------------------------------
    // Student screens
    // ----------------------------------------------------------------------
    await test.step('student signs in', async () => {
      await signIn(student.page, studentEmail);
      await student.page.waitForURL(/\/account/);
    });

    await test.step('student: account', async () => {
      await capture(student.page, student.logs, '03-student', 'account', '[data-testid="session-list"]');
    });

    let firstEnrollmentId = '';
    let thirdEnrollmentId = '';

    await test.step('student: test catalog', async () => {
      await student.page.goto('/tests');
      await capture(student.page, student.logs, '03-student', 'catalog', '[data-testid="student-test-list"]');
    });

    await test.step('student: test detail before enrolling', async () => {
      await student.page.goto(`/tests/${paperOne.testId}`);
      await capture(student.page, student.logs, '03-student', 'test-detail', '[data-testid="test-detail"]');
    });

    await test.step('student: enrolls on paper one', async () => {
      await student.page.getByTestId('enroll-button').click();
      await student.page.getByTestId('open-enrollment').waitFor({ state: 'visible' });
      await capture(student.page, student.logs, '03-student', 'test-detail-enrolled', '[data-testid="open-enrollment"]');
      const href = await student.page.getByTestId('open-attempt-link').getAttribute('href');
      firstEnrollmentId = (href ?? '').split('/').pop() ?? '';
    });

    await test.step('student: wallet after the enrollment', async () => {
      await student.page.goto('/wallet');
      await capture(student.page, student.logs, '03-student', 'wallet', '[data-testid="wallet-history"]');
    });

    await test.step('student: attempt instructions', async () => {
      await student.page.goto(`/attempt/${firstEnrollmentId}`);
      await capture(student.page, student.logs, '03-student', 'attempt-instructions', '[data-testid="attempt-instructions"]');
    });

    await test.step('student: taking the paper', async () => {
      await student.page.getByTestId('start-attempt').click();
      await capture(student.page, student.logs, '03-student', 'attempt-taking', '[data-testid="question-palette"]');
    });

    await test.step('student: a reload cannot resume', async () => {
      await student.page.reload();
      await capture(student.page, student.logs, '03-student', 'attempt-cannot-resume', '[data-testid="attempt-cannot-resume"]');
    });

    let resultUrl = '';

    await test.step('student: second paper, submit and result', async () => {
      await student.page.goto(`/tests/${paperTwo.testId}`);
      await student.page.getByTestId('enroll-button').click();
      await student.page.getByTestId('open-enrollment').waitFor({ state: 'visible' });
      await student.page.getByTestId('open-attempt-link').click();
      await student.page.getByTestId('start-attempt').waitFor({ state: 'visible' });
      await student.page.getByTestId('start-attempt').click();
      await student.page.getByTestId('submit-attempt').waitFor({ state: 'visible' });
      await student.page.getByTestId('submit-attempt').click();
      await capture(student.page, student.logs, '03-student', 'submit-confirm', '[data-testid="submit-confirm"]');
      await student.page.getByTestId('confirm-submit').click();
      await student.page.waitForURL(/\/attempt\/result\//);
      resultUrl = student.page.url();
      await capture(student.page, student.logs, '03-student', 'result', '[data-testid="attempt-result"]');
    });

    await test.step('student: review with the Wrong filter', async () => {
      const base = resultUrl.split('?')[0] ?? resultUrl;
      await student.page.goto(`${base}?show=wrong`);
      await capture(student.page, student.logs, '03-student', 'review-wrong', '[data-testid="review-filter-wrong"]');
    });

    await test.step('student: an enrollment that is no longer available', async () => {
      await student.page.goto(`/tests/${paperThree.testId}`);
      await student.page.getByTestId('enroll-button').click();
      await student.page.getByTestId('open-enrollment').waitFor({ state: 'visible' });
      const href = await student.page.getByTestId('open-attempt-link').getAttribute('href');
      thirdEnrollmentId = (href ?? '').split('/').pop() ?? '';
      closeEnrollment(thirdEnrollmentId);
      await student.page.goto(`/attempt/${thirdEnrollmentId}`);
      await capture(student.page, student.logs, '03-student', 'attempt-unavailable', '[data-testid="attempt-missing"]');
    });

    // ----------------------------------------------------------------------
    // Editor screens
    // ----------------------------------------------------------------------
    await test.step('editor signs in', async () => {
      await signIn(editor.page, editorEmail);
      await editor.page.waitForURL(/\/editor/);
    });

    await test.step('editor: home', async () => {
      await capture(editor.page, editor.logs, '04-editor', 'home', 'h1');
    });

    await test.step('editor: question list', async () => {
      await editor.page.goto('/editor/questions');
      await capture(editor.page, editor.logs, '04-editor', 'question-list', '[data-testid="question-list"]');
    });

    await test.step('editor: question editor', async () => {
      await editor.page.goto(`/editor/questions/${bank.alphaQuestionId}`);
      await capture(editor.page, editor.logs, '04-editor', 'question-editor', '[data-testid="question-preview"]');
    });

    await test.step('editor: test builder, draft', async () => {
      await editor.page.goto(`/editor/tests/${draft.testId}`);
      await capture(editor.page, editor.logs, '04-editor', 'test-builder', '[data-testid="question-order"]');
    });

    await test.step('editor: test builder, submitted', async () => {
      await editor.page.goto(`/editor/tests/${submitted.testId}`);
      await capture(editor.page, editor.logs, '04-editor', 'test-submitted', '[data-testid="test-status"]');
    });

    await test.step('editor: the admin area is refused', async () => {
      await editor.page.goto('/admin');
      await editor.page.waitForURL(/denied=1/);
      await capture(editor.page, editor.logs, '04-editor', 'denied', 'text=You do not have access to that page.');
    });

    // ----------------------------------------------------------------------
    // Administrator screens
    // ----------------------------------------------------------------------
    await test.step('admin signs in', async () => {
      await signIn(admin.page, adminEmail);
      await admin.page.waitForURL(/\/admin/);
    });

    await test.step('admin: dashboard', async () => {
      await capture(admin.page, admin.logs, '05-admin', 'dashboard', 'h1');
    });

    await test.step('admin: users', async () => {
      await admin.page.goto('/admin/users');
      await capture(admin.page, admin.logs, '05-admin', 'users', '[data-testid="user-list"]');
    });

    await test.step('admin: a user', async () => {
      await admin.page.goto(`/admin/users/${studentId}`);
      await capture(admin.page, admin.logs, '05-admin', 'user-detail', 'h1');
    });

    await test.step('admin: create editor', async () => {
      await admin.page.goto('/admin/users/new');
      await capture(admin.page, admin.logs, '05-admin', 'create-editor', 'h1');
    });

    await test.step('admin: exam catalog', async () => {
      await admin.page.goto('/admin/catalog');
      await capture(admin.page, admin.logs, '05-admin', 'catalog', '[data-testid="catalog-tree"]');
    });

    await test.step('admin: settings', async () => {
      await admin.page.goto('/admin/settings');
      await capture(admin.page, admin.logs, '05-admin', 'settings', '[data-testid="settings-list"]');
    });

    await test.step('admin: audit trail', async () => {
      await admin.page.goto('/admin/audit');
      await capture(admin.page, admin.logs, '05-admin', 'audit', '[data-testid="audit-table"]');
    });

    await test.step('admin: coins search', async () => {
      await admin.page.goto('/admin/coins');
      await capture(admin.page, admin.logs, '05-admin', 'coins', '[data-testid="coin-recipients"]');
    });

    await test.step('admin: a wallet and its ledger', async () => {
      await admin.page.goto(`/admin/coins/${studentId}`);
      await capture(admin.page, admin.logs, '05-admin', 'coins-user', '[data-testid="coin-ledger"]');
    });

    await test.step('admin: tests and the publish control', async () => {
      await admin.page.goto('/admin/tests');
      await capture(admin.page, admin.logs, '05-admin', 'tests', '[data-testid="admin-test-list"]');
    });
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => undefined);
    }
  }
});

/** The report and the job summary, written once after the tour. */
test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ rows, skipped, errorStates }, null, 2)}\n`);

  const header =
    '| # | screen | viewport | overflow | smallest tap | below 44 | no alt | unlabeled inputs | h1/main | focus gaps | console errors |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
  const body = rows
    .map(
      (row) =>
        `| ${String(row.index)} | ${row.area}/${row.screen} | ${row.viewport} | ${row.horizontalOverflow ? '**yes**' : 'no'} | ${String(row.smallestTap?.width ?? 0)}×${String(row.smallestTap?.height ?? 0)} | ${String(row.below44)} (+${String(row.inlineExempt)} inline) | ${String(row.imagesWithoutAlt)} | ${String(row.inputsWithoutLabel)} | ${String(row.h1Count)}/${String(row.mainCount)} | ${String(row.focusWithoutStyle)}/${String(row.focusChecked)} | ${String(row.consoleErrors.length)} |`,
    )
    .join('\n');
  const missing = skipped.map((entry) => `- ${entry.screen}: ${entry.reason}`).join('\n');

  const summary = `## Screenshot gallery\n\n${String(rows.length)} screenshots, ${String(skipped.length)} skipped.\n\n${header}${body}\n\n${skipped.length === 0 ? '' : `### Skipped\n\n${missing}\n`}`;

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile !== undefined && summaryFile !== '') {
    appendFileSync(summaryFile, `${summary}\n`);
  }

  // eslint-disable-next-line no-console
  console.log(`GALLERY-SUMMARY ${String(rows.length)} shots, ${String(skipped.length)} skipped`);
  // Observation only, never an assertion: the accessibility counts the review tracks, across the
  // whole tour, plus the phone screens whose smallest tap target is under 44x44.
  const unlabeled = rows.reduce((sum, row) => sum + row.inputsWithoutLabel, 0);
  const noAlt = rows.reduce((sum, row) => sum + row.imagesWithoutAlt, 0);
  const overflow = rows.filter((row) => row.horizontalOverflow).length;
  const phone = rows.filter((row) => row.viewport === 'phone');
  const smallTaps = phone.filter(
    (row) => row.smallestTap !== null && (row.smallestTap.width < 44 || row.smallestTap.height < 44),
  );
  const a11y = `GALLERY-A11Y captures=${String(rows.length)}, unlabeled inputs=${String(unlabeled)}, images without alt=${String(noAlt)}, overflow=${String(overflow)}, phone screens under 44x44=${String(smallTaps.length)}`;
  // eslint-disable-next-line no-console
  console.log(a11y);
  if (summaryFile !== undefined && summaryFile !== '') {
    appendFileSync(summaryFile, `${a11y}\n`);
    if (smallTaps.length > 0) {
      appendFileSync(
        summaryFile,
        `\nUnder 44x44 on the phone: ${smallTaps.map((row) => `${row.area}/${row.screen}`).join(', ')}\n`,
      );
    }
  }

  // F2's numbers: every stand-alone control on the phone, its focus style, the error association
  // and one h1/one main per page. Still observation — a count of zero here never fails the job.
  const below44 = phone.reduce((sum, row) => sum + row.below44, 0);
  const inlineExempt = phone.reduce((sum, row) => sum + row.inlineExempt, 0);
  const focusChecked = phone.reduce((sum, row) => sum + row.focusChecked, 0);
  const focusWithout = phone.reduce((sum, row) => sum + row.focusWithoutStyle, 0);
  const h1Pages = rows.filter((row) => row.h1Count !== 1);
  const mainPages = rows.filter((row) => row.mainCount !== 1);
  const errorTotals = errorStates.reduce(
    (totals, entry) => ({ fields: totals.fields + entry.fields, without: totals.without + entry.withoutDescription }),
    { fields: 0, without: 0 },
  );
  const below44List = phone.filter((row) => row.below44 > 0);
  const focusList = phone.filter((row) => row.focusWithoutStyle > 0);
  const a11y2 = `GALLERY-A11Y2 phone: stand-alone below 44x44=${String(below44)}, inline exempt=${String(inlineExempt)}, controls without a focus style=${String(focusWithout)} of ${String(focusChecked)}, error fields without aria-describedby=${String(errorTotals.without)} of ${String(errorTotals.fields)}; pages: not exactly one h1=${String(h1Pages.length)}, not exactly one main=${String(mainPages.length)}`;
  // eslint-disable-next-line no-console
  console.log(a11y2);
  if (summaryFile !== undefined && summaryFile !== '') {
    appendFileSync(summaryFile, `\n${a11y2}\n`);
    if (below44List.length > 0) {
      appendFileSync(
        summaryFile,
        `\nStand-alone controls under 44x44 (phone): ${below44List
          .map((row) => `${row.area}/${row.screen}: ${row.below44Labels.join('; ')}`)
          .join(' | ')}\n`,
      );
    }
    if (focusList.length > 0) {
      appendFileSync(
        summaryFile,
        `\nControls with no visible focus style (phone): ${focusList
          .map((row) => `${row.area}/${row.screen}: ${row.focusSample.join('; ')}`)
          .join(' | ')}\n`,
      );
    }
    if (h1Pages.length > 0 || mainPages.length > 0) {
      appendFileSync(
        summaryFile,
        `\nPages without exactly one h1 or one main: ${[...h1Pages, ...mainPages]
          .map((row) => `${row.area}/${row.screen} (${row.viewport})`)
          .join(', ')}\n`,
      );
    }
    appendFileSync(
      summaryFile,
      `\nError states reached: ${errorStates
        .map(
          (entry) =>
            `${entry.where} alerts=${String(entry.alerts)} fields=${String(entry.fields)} without aria-describedby=${String(entry.withoutDescription)}`,
        )
        .join('; ')}\n`,
    );
  }
  for (const entry of skipped) {
    // eslint-disable-next-line no-console
    console.log(`GALLERY-SKIPPED ${entry.screen}: ${entry.reason}`);
  }
});
