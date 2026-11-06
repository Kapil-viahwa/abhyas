# Phase 6 — the test builder and enrollment

The specification and the setup record for phase 6, kept in the repository so a later
session can resume from the repository alone. This document, `docs/decisions.md` 0068 and
the phase 6 queue in `docs/NEXT-TASKS.md` are the whole of the setup; this session builds
no feature.

Phase 6 makes a mock test a sellable product: an editor assembles a paper from the question
bank with its own pattern, an Administrator publishes it, and a student pays coins to
enroll. Taking the attempt (timers, autosave, submission) is phase 7 and is not in scope.

## Rules the owner has decided

1. **The pattern is per test, custom and editor-editable.** The editor who builds a test
   chooses its questions, its duration, its marks per question and its negative marking.
   It is not derived from the exam, and it is editable until the test is submitted.
2. **Single-correct questions only.** No multiple-correct questions and no partial
   marking, in this phase and in the attempt engine after it. The question bank already
   models `MCQ` (exactly one correct option, enforced by a deferred constraint trigger)
   and `NUMERICAL`; phase 6 tests may use `MCQ` questions, and the paper's negative marking
   is one number, not a per-option weighting.
3. **Editors upload and edit content only, and may see answer keys.** An editor may read
   the answer key and explanation of the questions in their own bank while building a
   paper. Answer keys still never leave the server to a student before submission
   (`docs/permissions.md`, "Rules that are enforced, not documented").
4. **Only an Administrator adds or deducts coins.** Unchanged from phase 5: `coins.write`,
   and the only automatic debit is enrollment.
5. **Enrollment costs 100 coins per attempt,** from the existing `default_enrollment_cost`
   setting (default 100), which the e2e specifications pin before they read it. There is no
   refund once enrolled, and a retake pays again.
6. **One open enrollment per test at a time.** A student may hold at most one enrollment
   that is still open for a given test. A test may also carry an optional maximum number of
   attempts, enforced by the server.
7. **Accuracy is correct ÷ attempted.** It is defined here because enrollment and attempts
   feed it later; it is computed in the results phase (8), not in this one.
8. **Only an Administrator publishes and archives a test** (confirmed by the owner). An
   editor builds a draft and **submits** it for the Administrator. An editor calling
   publish or archive is refused with **403** by the API, the publish and archive buttons
   do not render for an editor, and a Playwright test proves both.

## Assumptions recorded for the owner to confirm

These are written down in `docs/decisions.md` 0068 as "assumed, owner to confirm". Work
does not block on them; each is reversible without touching the ledger or the data model's
shape.

- **Lifecycle:** a test is `DRAFT`, `SUBMITTED` (an editor has handed it over),
  `PUBLISHED` or `ARCHIVED`. Editors work in `DRAFT` and `SUBMITTED`; only an
  Administrator moves one to `PUBLISHED` or `ARCHIVED`.
- **Freezing:** publishing freezes the test's questions, marks, duration and negative
  marking for existing enrollments. Editing a published test creates a new version and
  never changes an open attempt's paper.
- **The debit:** enrollment writes an `ENROLLMENT` ledger row through `CoinService.spend`
  with an idempotency key, so a double click or a retry writes one debit.
- **The student catalog** lists published tests with title, duration, question count,
  total marks, cost and the student's own enrollment state, and never an answer key.

## Audit: what already exists

Read from the code, not only from the docs. Phase 6 builds on these; it does not repeat
them.

**Roles and permissions.** Three roles, `ADMIN`, `EDITOR` and `USER`
(`20250101000000_init`, `20250201000000_identity_foundation`). The permission catalog
already carries `tests.read`, `tests.write`, `tests.publish`, `attempts.take`,
`attempts.read.all` and `coins.write` (`docs/permissions.md`, the matrix). Authorization is
deny-by-default: every route declares `@Public`, `@Authenticated` or
`@RequirePermissions`, and `apps/api/src/auth/route-access.spec.ts` enumerates every
handler and fails on an undeclared one. An editor's write capability is an explicit grant,
one `user_permissions` row per flag (`manage_questions`, `manage_tests`, `publish_tests`),
with two database triggers — one refuses these codes on a non-editor, one clears them on
demotion (`apps/api/src/admin/editor-flags.ts`, `20250601000000_user_management`).

**The question bank.** `20251001000000_questions` creates `questions`,
`question_versions` and `question_options`. A version carries `question_type`
(`MCQ`/`NUMERICAL`), `marks` and `negative_marks` per question, content, explanation,
LaTeX, language and difficulty; a published version is frozen by trigger, its options with
it, and a deferred trigger enforces exactly one correct option for an `MCQ` and no options
for a `NUMERICAL`. Questions hang off the catalog (`questions.exam_id`, `subject_id`,
`topic_id`) with an alignment trigger. The editor UI and API are
`apps/web/src/app/editor/questions` and `apps/api/src/questions/*`, with the sanitiser in
`apps/api/src/questions/sanitize.ts` and the API's answer-key rules.

**The exam catalog.** `20250701000000_exam_catalog` creates categories, exams, subjects and
topics, with `created_by` ownership and object-level rules; the public pages are
`/exams`, `/exams/<category>`, `/exams/<category>/<exam>` (`apps/web/src/app/exams`), and
`apps/api/src/catalog/*` holds the API. **There is no `tests` table and nothing that looks
like a paper, a version of one, or a question placement in it.**

**The coin ledger and `CoinService`.** `20260601000000_coins` creates `coin_wallets` and
the append-only `coin_transactions`, whose `type` CHECK already lists `ENROLLMENT`. The
ledger is written only by `CoinService` (`apps/api/src/coins/coin.service.ts`): `credit`
and `spend` run in a transaction that locks the wallet row, take an idempotency key, store a
request fingerprint, replay the original row on a matching key, refuse a reused key with a
different intent (409), and refuse to take the balance below zero. `20260801000000` adds
`coin_transactions_one_enrollment_per_reference`, a partial unique index on
`(reference_type, reference_id)` where `type = 'ENROLLMENT'` — so one charge per reference,
which is what makes a retake safe: each enrollment is its own reference. `CoinService.spend`
already accepts `type: 'ENROLLMENT'`; **nothing in the application calls it with that type
yet.** The student wallet (`apps/api/src/coins/wallet.service.ts`, `/wallet`) already lists
`ENROLLMENT` as a history type, and the ledger tests exercise the type against the index.

**Settings.** The `settings` table stores a type and bounds in the row (`20250201000000`,
renamed in `20250801000000`). `default_enrollment_cost` already exists with a default of
100, is editable through `/admin/settings` behind `settings.write`, and is audited
(`apps/api/test/operations.test.ts` asserts the default). The e2e fixture
`e2e/coin-settings.ts` upserts a setting and raises if the value did not land; every phase
6 spec that reads a setting must use it.

**The rules that will carry over.** Answer keys never serialise to a student before
submission; object-level checks are mandatory (no IDOR); the browser holds no token; every
write is a form post behind the CSRF + `Origin` guard; server-side permission checks gate
every screen.

## Audit: what is missing

- **No test, version, placement or enrollment tables**, no migrations for them, and no
  Prisma models: `schema.prisma` has nothing beyond the question and coin models. Phase 6
  starts the schema from zero here.
- **No builder API or pages**: an editor can author questions but cannot assemble a paper,
  set a duration, or submit anything to an Administrator.
- **Publishing is currently an editor capability.** `tests.publish` is reachable through
  the `publish_tests` editor flag, and `apps/web/src/app/admin/users/*` renders that
  checkbox. The owner's decision is the opposite, so phase 6 must retire the flag for
  editors (a migration that refuses the grant and a UI that stops offering it) and keep
  `tests.publish` for `ADMIN` only. Until it is retired, "an editor cannot publish" is not
  true of this repository.
- **No enrollment path at all**: no route, no service call, no cost read from
  `default_enrollment_cost`, no one-open-enrollment rule, no maximum attempts, no student
  catalog page, and no place where the coin debit and the enrollment commit together.
- **No `max_attempts` style setting** and no per-test attempt cap.
- **Nothing computes accuracy** or reads an attempt: phase 7 and 8 own that.

## The data model phase 6 adds

One migration (P1), in the style of the existing ones: hand-written SQL, CHECKs, triggers,
partial indexes, and grants to `abhyas_app` in a `DO` block.

- `tests` — `id`, `exam_id` (FK `exams`, `ON DELETE RESTRICT`), `created_by`, `title`,
  `description`, `status` (`DRAFT`, `SUBMITTED`, `PUBLISHED`, `ARCHIVED`), `current_version`,
  `max_attempts` (nullable integer, `>= 1`), `submitted_at`, `published_at`, `archived_at`,
  timestamps. Indexes on `exam_id`, `created_by` and `status`.
- `test_versions` — `id`, `test_id`, `version`, `duration_minutes`, `marks_per_question`
  (`NUMERIC(6,2)`), `negative_marks_per_question` (`NUMERIC(6,2)`, `>= 0`),
  `question_count`, `created_by`, `published_at`. `UNIQUE (test_id, version)`. A published
  version is frozen by trigger, like `question_versions`.
- `test_questions` — `id`, `test_version_id`, `question_id`, `position`, with
  `UNIQUE (test_version_id, position)`. Placement is frozen with its version. The marks and
  negative marks live on the version (one number each for the whole paper), and the
  question's own `marks` supply a default the editor can override per paper.
- `enrollments` — `id`, `test_id`, `test_version_id`, `user_id`, `attempt_number`
  (starting at 1), `status` (`OPEN`, `COMPLETED`, `EXPIRED`), `coin_transaction_id`
  (`UNIQUE`, `ON DELETE RESTRICT`), `idempotency_key`, timestamps.
- A **partial unique index** `enrollments_one_open_per_test` on `(user_id, test_id)` where
  `status = 'OPEN'` — the database, not the handler, is what makes "one open enrollment per
  test" true under two simultaneous requests.
- The `ENROLLMENT` ledger row uses `reference_type = 'enrollment'` and
  `reference_id = <enrollment id>`, so the existing partial unique index stays meaningful
  and a retake (a new enrollment) is a new charge.

## The API phase 6 adds

Authoring, behind `tests.write` for an editor holding `manage_tests`, and `ADMIN` always:

- `POST /v1/editor/tests` — create a draft for an exam the caller may write content for.
- `GET /v1/editor/tests` — the caller's drafts and submitted tests (an `ADMIN` sees all).
- `GET /v1/editor/tests/:id`, `PATCH /v1/editor/tests/:id` — read and edit a draft;
  editing a published test creates a new version.
- `PUT /v1/editor/tests/:id/questions` — set the paper's question list and order from the
  bank, with server-side checks that every question is the caller's own or an
  administrator's, is published, and matches the test's exam.
- `POST /v1/editor/tests/:id/submit` — hand the draft to the Administrator.
- `POST /v1/admin/tests/:id/publish` and `POST /v1/admin/tests/:id/archive` — `ADMIN` only,
  `tests.publish`. **An editor calling either gets 403**, from the guard before the handler
  runs, and a permission test sweeps both routes for `EDITOR` and `USER`.

Student, behind `attempts.take` and self-only:

- `GET /v1/tests` — published tests with title, exam, duration, question count, total marks,
  cost and the caller's own enrollment state. Never an answer key, never a draft.
- `GET /v1/tests/:id` — one published test's summary, same rules.
- `POST /v1/tests/:id/enroll` — the caller's enrollment: one transaction that locks the
  wallet row and writes both the `ENROLLMENT` ledger row (cost from
  `default_enrollment_cost`) and the `enrollments` row, with an `Idempotency-Key`. Refusals:
  insufficient balance (400 with a clear message), an already-open enrollment for that test
  (409), the maximum attempts reached (409), a suspended account (403), an unpublished or
  archived test (404/409). There is no `userId` anywhere in the request.
- `GET /v1/enrollments/me` — the caller's enrollments with test summary and state.

## The web screens phase 6 adds

- `/editor/tests` and `/editor/tests/<id>` — server-checked with `loadPermissionSession` and
  `tests.write`: create a draft, set title, duration, marks and negative marking, add and
  reorder questions from the bank, and submit. **No publish or archive control renders
  unless the account holds `tests.publish`**, which in practice means only an
  Administrator sees it.
- `/admin/tests` and `/admin/tests/<id>` — the Administrator's review list, with publish and
  archive on a submitted test.
- `/tests` and `/tests/<id>` — the student catalog with cost and the student's own state,
  and the enroll action as a form post; `/tests/<id>` after enrolling shows the enrollment.
- Navigation links appear only for an account that holds the permission behind them, as the
  coin screens already do (`apps/web/src/components/admin-shell.tsx`).

## The queue

The phase 6 unit order is in `docs/NEXT-TASKS.md`, below the phase 5 items: P1 data model,
P2 builder API (including the editor 403 on publish and archive), P3 builder pages and their
Playwright proof, P4 enrollment API with its concurrency tests, P5 the student catalog and
enroll screens, P6 docs and merge, P7 stop. Each names the test that proves it.

## Out of scope

- The attempt engine: starting an attempt, the timer, autosave, submission, snapshot-scoped
  media. That is phase 7, and the enrollment this phase writes is what it will read.
- Results, accuracy and analytics: phase 8. Accuracy is defined here (correct ÷ attempted)
  only so the enrollment and attempt shape supports it.
- Multiple-correct questions, partial marking and per-section patterns are out of scope for
  this phase by the owner's rule above.
