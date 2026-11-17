# Next tasks

The ordered queue for the rest of Phase 5, on branch `phase-5b` (draft pull request #21).
Work the first open item, then stop.

## How every session works

1. **One unit per session.** A session does one item, pushes once, and stops. It does not poll
   or wait for CI after pushing; it ends with "pushed `<sha>`, runs queued".
2. **CI first.** The next session begins by reading the finished runs for the latest commit of
   the branch. A red job is fixed before any new work, quoting the first real error line
   before changing anything.
3. **The pre-push checklist** in `docs/working-rules.md` is run on the session's own diff
   before every push. It is not optional.
4. **The session protocol** is in `docs/working-rules.md`, under "Session protocol".

## The queue

[x] Q1 Confirm CI on the latest phase-5b commit (1b5a659 or newer): all nine jobs green on both runs. — Done on `2fd741a`: eighteen passing checks (nine jobs in each run), listed on [PR #21's checks](https://github.com/Kapil-viahwa/abhyas/pull/21/checks).

[x] Q2 Student wallet API (self-only; NO userId parameter anywhere, the account comes from the session): GET /v1/coins/me (balance, total earned, total spent, today's daily reward status in Asia/Kolkata, amount, next reward date) and GET /v1/coins/me/history (paginated, filter by type and date range, newest first, page size capped at 100, strict query validation). @Authenticated, suspended accounts refused, response never exposes created_by, idempotency keys, fingerprints or other users' data (only type, signed amount, balance after, description, reference label, created_at). Database-job tests: a student reads only their own data, another user's id passed as a parameter is ignored or rejected, suspended refused, hostile values rejected, no leaked fields. Update docs/permissions.md. — Verified in both runs of `d28ab3d` (18/18 checks); repeated parameters and the page cap were added with Q3 in `wallet.test.ts`.

[x] Q3 Student wallet web page /wallet (server-checked, redirect to sign-in otherwise, mobile responsive, linked from account navigation; data via route handlers or server components with the upstream helper, tokens never in the browser) plus Playwright inside the existing e2e job: new verified student sees 1,000 coins; sign-in shows the daily reward once and a second sign-in does not change the balance; history lists the signup grant and the daily reward; type filter works; anonymous visitor redirected. — Verified in both runs of `0bdcfce` (18/18 checks: `database` and `e2e` green in each), listed on [PR #21's checks](https://github.com/Kapil-viahwa/abhyas/pull/21/checks). Note for later specs: the e2e project is one worker on one database, and `admin-operations.spec.ts` leaves `signup_coins` at 1,005, so a spec that reads a setting must pin it — `wallet.spec.ts` now upserts `signup_coins` and `daily_reward_coins` and fails if a value did not land. It is the only other consumer of either setting.

[x] Q4 Admin coin pages (coins.write, server-checked): search user, adjust with remark, bulk preview and confirm, job status with per-row results, report download, per-user ledger viewer and export. Forms send an Idempotency-Key generated once per render and handle reauth_required by asking for the password or code and retrying. Playwright: admin credits one user; admin bulk-credits several from a CSV including an unmatched row; double-click on adjust writes once; an editor and a student cannot reach the pages or their APIs. — Verified in both runs of `ea400ea` (18/18 checks: `e2e` green in each), listed on [PR #21's checks](https://github.com/Kapil-viahwa/abhyas/pull/21/checks). Two red runs on the way there: `491f73e` (the two bulk web routes imported `lib` one level too shallow) and `c3a6738` (the worker's 404 on the internal drain, because the dev network was a /16 and `INTERNAL_ALLOWED_ADDRESSES` listed only loopback; the network is now pinned to 10.213.0.0/24, and the bulk test's 180s timeout covers the thirty-second drain).

[x] Q5 Docs and merge: update docs/permissions.md, docs/decisions.md, Known gaps (email-only signup grant farming risk; admin coin writes need re-authentication; internal route allowed addresses; SECURITY DEFINER wallet design as a later improvement), docs/ROADMAP.md, README links, the PROGRESS.md claim table with run links and the PR description; mark PR #21 ready. You are authorized to merge PR #21 with a normal merge commit once all nine jobs are green on both runs; then confirm main CI. — Done: the docs are in `7396cd1`, whose two runs had 18 green checks after the push run's `e2e` was re-run once (Success, 3m12s; the pull-request run's `e2e` passed in 4m24s). PR #21 was marked ready and merged with a normal merge commit as [`a1ce3bc`](https://github.com/Kapil-viahwa/abhyas/commit/a1ce3bc); main CI on that merge commit is 9/9 green ([checks](https://github.com/Kapil-viahwa/abhyas/commit/a1ce3bc/checks), `e2e` 3m21s). Phase 6 waits for the owner's prompt.

[ ] Q6 STOP and report. Phase 6 (test builder and enrollment) starts only when the owner provides its prompt.

## Phase 6 — the test builder and enrollment

Branch `phase-6`, one pull request. The specification and the audit of what already exists is
`docs/PHASE-6.md`; the rules and the assumptions are `docs/decisions.md` 0068. Same protocol
as above: one unit per session, push once, stop. Every new row in this queue must enforce the
owner's publish rule — **only an Administrator publishes or archives a test; an editor builds
a draft and submits it** — and an editor calling either route must be refused with 403.

[x] P1 Data model. One migration: `tests` (exam, creator, status `DRAFT`/`SUBMITTED`/`PUBLISHED`/`ARCHIVED`, current version, optional `max_attempts`), `test_versions` (duration, marks per question, negative marks per question, frozen once published), `test_questions` (order, unique per version and position), `enrollments` (user, test, version, attempt number, status `OPEN`/`COMPLETED`/`EXPIRED`, unique `coin_transaction_id`, idempotency key). Indexes for the student catalog and the editor list, and a **partial unique index for one open enrollment per (user, test)**. Retire the `publish_tests` editor flag so `tests.publish` is Admin-only: the migration refuses the grant to an editor and `docs/permissions.md` says so. Proof: `apps/api/test/tests-model.test.ts` in the database job — CHECKs, the published freeze, the partial unique index under two concurrent inserts, the enrollment/ledger link, and the editor grant refusal. The Prisma schema models are part of this unit, because the database job runs the API against the same schema. — Verified in all nine jobs of `057bd0a` ([its checks](https://github.com/Kapil-viahwa/abhyas/commit/057bd0a/checks), [run 42226802128](https://github.com/Kapil-viahwa/abhyas/actions/runs/42226802128)) and in the nine jobs of the docs-only commit on top, `fba31e8` ([run 42228821627](https://github.com/Kapil-viahwa/abhyas/actions/runs/42228821627)): eighteen green check results, the database job running `apps/api/test/tests-model.test.ts` in full and green.

[x] P2 Editor/Admin test-builder API: create a draft, edit it, add, remove and reorder questions from the bank (validated: own or admin question, published, same exam), set duration, marks and negative marking, submit; Admin publish and archive. Strict query and body validation. Permission tests: an Editor with `manage_tests` builds and submits; an Editor without it gets 403; an Editor with `publish_tests` is no longer possible, and an Editor or Student calling publish or archive gets **403** (route-access sweep plus per-route tests); a Student is refused on every builder route. Answer keys are never in a student response. Create on a published test opens a new version and leaves an open enrollment's snapshot untouched. Tests: `apps/api/test/tests-builder.test.ts` in the database job. — Verified in all nine jobs of `cf7458d` ([its checks](https://github.com/Kapil-viahwa/abhyas/commit/cf7458d/checks), [run 42234741135](https://github.com/Kapil-viahwa/abhyas/actions/runs/42234741135)): the database job ran `apps/api/test/tests-builder.test.ts` green, the unit job passed the route-access sweep with both controllers registered, and typecheck and lint passed. The database run before it, on `763940a`, was red on one fixture mistake (a published `question_versions` row written with its options in the same statement), fixed in `cf7458d`.

[x] P3 Test-builder web pages for Editor and Admin, server-checked with `loadPermissionSession`, mobile responsive, linked from the editor and admin navigation: draft list, builder form (pattern, question picker, ordering), submit; Admin view with publish and archive. The publish and archive controls do not render for an Editor, and the navigation link follows the permission. Playwright in the existing `e2e` job: an editor builds a test, adds questions, sets the pattern and submits; an admin publishes it; the editor's page has no publish button; an editor posting to the publish route gets the API's 403; a student cannot reach the pages or the APIs. Specs pin every setting they read with the upsert-and-verify fixture and use unique emails. The spec's editor holds `manage_tests` only, because `publish_tests` no longer exists. — Verified in all nine jobs of `316423a` ([its checks](https://github.com/Kapil-viahwa/abhyas/commit/316423aa08b80a1befdc9a0d88ced00dec4ebeb5/checks), [run 42331153252](https://github.com/Kapil-viahwa/abhyas/actions/runs/42331153252), `e2e` 3m26s). The run before it, on `322aba1`, was red in one place: `/editor/tests/new` never painted its form because `catalogChoices` in `apps/web/src/lib/questions-api.ts` walked a nested `categories[].exams[]` that `GET /v1/catalog/tree` does not send, so the page threw and the spec waited out its timeout on `new-test-title`. The fix is in `316423a` and touched only that helper: no permission check, control or assertion changed.

[x] P3b One Playwright check that an editor holding the manage-questions flag can open `/editor/questions/new` and see its form, in the existing `e2e` job (a short test in `e2e/catalog.spec.ts`, whose editor already carries `content.write`). Deferred from P3's session on purpose: that session had to stay docs-only, and an unrun spec may not be claimed. Context for it: `catalogChoices` in `apps/web/src/lib/questions-api.ts` parsed a nested `categories[].exams[]` that `GET /v1/catalog/tree` has never returned — the endpoint has been flat (`categories` + `exams`, two lists) since the file was written in `f79a892` (phase 4, 2026-11-01), so `/editor/questions/new` and `/editor/questions/[id]` have been broken since phase 4 and no spec visited either page. `316423a` repaired the helper. — Implemented as "the question pages render for an editor" in `e2e/test-builder.spec.ts`, on that spec's own editor and seeded question (no product code changed; it waits on the editor's `question-preview` id, the only test id the form carries). — Verified in all nine jobs of `8342d93` ([its checks](https://github.com/Kapil-viahwa/abhyas/commit/8342d935be27be525222e37ccfbaf9cc644bf406/checks), [run 42335778524](https://github.com/Kapil-viahwa/abhyas/actions/runs/42335778524), `e2e` 4m20s). The `e2e` job's readable slice is container output, so the Playwright summary line is not re-quotable; the green `e2e` job, run under `set -o pipefail`, is what proves every test in the project passed, the new one included.


[x] P4 Enrollment API: `GET /v1/tests`, `GET /v1/tests/:id`, `POST /v1/tests/:id/enroll`, `GET /v1/enrollments/me`. Self-only — no `userId` anywhere, the account is the session's. Enrollment is one transaction: lock the wallet row, read the cost from `default_enrollment_cost`, write the `ENROLLMENT` ledger row with the request's Idempotency-Key and `reference_type = 'enrollment'`, `reference_id = <enrollment id>`, then the enrollment row. Refusals: insufficient balance, an open enrollment for that test, the test's maximum attempts reached, a suspended account, an unpublished or archived test. Database-job tests: two simultaneous submits write one debit and one enrollment; two students racing for the last 100 coins give one success and one refusal with a correct balance; retakes pay again and the old attempt stays untouched. — Implemented in `apps/api/src/tests/enrollments.service.ts` and `enrollments.controller.ts` (lock order wallet → test → enrollments, debit through the new `CoinService.spendWithin`), proved by `apps/api/test/enrollments.test.ts`, documented in `docs/permissions.md` and `docs/decisions.md` 0072. — Verified in all nine jobs of `8342d93` ([its checks](https://github.com/Kapil-viahwa/abhyas/commit/8342d935be27be525222e37ccfbaf9cc644bf406/checks), [run 42335778524](https://github.com/Kapil-viahwa/abhyas/actions/runs/42335778524)): the database job ran `apps/api/test/enrollments.test.ts` green, the unit job passed the route-access sweep with both new controllers, and typecheck and lint passed; the claim-by-claim table is in `PROGRESS.md`. The job logs' readable slices are Postgres noise and container output, so the vitest and Playwright summary lines are not re-quotable; the green jobs are the proof.

[x] P5 Student catalog and enroll web pages: `/tests` and `/tests/<id>`, server-checked, with title, duration, question count, total marks, cost and the student's own state; enroll is a form post; `/wallet` shows the ENROLLMENT row afterwards. Playwright: a student browses, enrolls, the balance drops by 100, the wallet history shows the ENROLLMENT row, a second enroll is refused, an insufficient-balance message is shown, and an anonymous visitor is redirected. Settings pinned with the upsert-and-verify fixture, unique emails. — Implemented in `apps/web/src/app/tests/` (`/tests` and `/tests/<id>`) with `apps/web/src/lib/student-tests-api.ts` and the `/api/enrollments/enroll` handler; the API's refusals now carry a `code` beside their unchanged messages. Proof is `e2e/tests-enroll.spec.ts`, on a paper seeded through `e2e/tests-fixture.ts`. — Verified in all nine jobs of `3607f5fbb544e37321f477c6401b5ec4be021145` ([run 42340527388](https://github.com/Kapil-viahwa/abhyas/actions/runs/42340527388), `e2e` 4m13s, `database` 1m43s; [the commit's checks](https://github.com/Kapil-viahwa/abhyas/commit/3607f5fbb544e37321f477c6401b5ec4be021145/checks)). The check list this session reads merges the push run and the pull-request run into one row per job name and names a single run id, so the two runs cannot be separated here: nine green jobs are claimed, not eighteen. The ten enrollment tests kept their message assertions after the refusal-code change, and one test was added beside them asserting each `code`; it travels in the docs-and-test push that carries this line, whose own CI has not been read.

[x] P6 Docs and merge — done. The conflict merge with `main` (`525fc5c808abe0bd5f9be1cf2d0f44457bc468e7`) and the docs commit `eb0eb54aa0f027a1b861a8b0e19ea0bf8c2ffb7c` were green in all nine jobs of **both** runs of that head: the push run [42378315444](https://github.com/Kapil-viahwa/abhyas/actions/runs/42378315444) and the pull-request run [42378320234](https://github.com/Kapil-viahwa/abhyas/actions/runs/42378320234), the latter testing GitHub's own merge ref of the head into `main`. `main` had not moved since the conflict merge, so PR #26 was marked ready and merged with a normal merge commit as [`5cfda8249caf55e3f4e2a78c43d58edc8fc6f5ba`](https://github.com/Kapil-viahwa/abhyas/commit/5cfda8249caf55e3f4e2a78c43d58edc8fc6f5ba); `main` CI on that merge commit is [run 42382334331](https://github.com/Kapil-viahwa/abhyas/actions/runs/42382334331), nine jobs green, `e2e` 4m34s with a Playwright browser cache hit, so the install step ran `install-deps` only. The docs it owes — `docs/permissions.md`, decision 0068's confirmations, the Known gaps, `docs/ROADMAP.md`, the README links, the Phase 6 claim table in `PROGRESS.md` and the PR description — are in `eb0eb54` and in the P6 post-merge commit.

[ ] P7 STOP and report. The attempt engine (starting and taking a test) is the next phase and starts only on the owner's prompt.

## Phase 7 — the attempt engine

Branch `phase-7`, one pull request. The specification and the audit of what already exists is
`docs/PHASE-7.md`; the rules and the assumptions are `docs/decisions.md` 0074. Same protocol as
above: one unit per session, push once, stop. Every row must keep the owner's rules — the server
owns the clock, answers are saved only on submit, one start per enrollment and no resume, and
answer keys never leave the server before the attempt has ended.

[x] A1 Data model. One migration: `attempts` (unique enrollment, `started_at`, `deadline_at`,
`submitted_at`, `status` `IN_PROGRESS`/`SUBMITTED`/`AUTO_SUBMITTED`, submit source), with CHECK
`deadline_at > started_at`; `attempt_answers` (attempt, question, chosen option) with
`UNIQUE (attempt, question)` and a guard that the question is in the attempt's version and the
option is that question's; `results` (score, correct, wrong, unattempted, attempted, accuracy,
marks) with `UNIQUE (attempt)` and a trigger that refuses `UPDATE`/`DELETE`; the
`attempt_submit_grace_seconds` setting (integer, default 5, 0–60). Prisma models in the same
unit, because the database job runs the API against the schema. Proof: a database-job test file
— the CHECKs, one attempt per enrollment, one answer per question, a foreign question or option
refused, a result immutable once written, and two simultaneous inserts of the same attempt
leaving exactly one. — Verified in both nine-job runs of `9ab5f08db7f6bccac50b0256a5185cab0d386c11`: [run 42437445709](https://github.com/Kapil-viahwa/abhyas/actions/runs/42437445709) and [run 42437449335](https://github.com/Kapil-viahwa/abhyas/actions/runs/42437449335), eighteen green check results between them. The tool that lists them merges the two runs into one row per job name, so the job ids are what separates them: `database` 128599236097 (2m04s) and 128599247640 (2m22s), both green, with the other eight jobs green in each run. The green job's readable log slice is Postgres and container output, so the vitest summary line is not re-quotable; the green `database` job, which runs `pnpm test:db` under `set -o pipefail`, is the proof that `apps/api/test/attempts-model.test.ts` ran in full and passed, and the same step applies the migrations, so `20270201000000_attempts` applied. Two red rounds on the way: `46fcc34` (the answer guard's join named `o.version_id`; the column is `question_version_id`), fixed in `60781c0`, and `60781c0` (a test regex required a space that Prisma 5.22's unique-violation message does not print), fixed in `9ab5f08`. The claim-by-claim table and both rounds are recorded in `PROGRESS.md`.

[x] A2 The scoring function. A pure function of (version, submitted answers): correct ×
marks per question − wrong × negative marks per question, unattempted zero, `accuracy =
correct ÷ attempted` with zero attempted giving zero, carrying marks as the version's decimals
rather than floats. Unit tests: all correct, all wrong with negative marking, all unattempted,
mixed, zero attempted, fractional marks, a question not in the version ignored or refused
(state which), duplicate answers refused, and a property-style check that score equals
`marks × correct − negative × wrong` over generated answer sets. No HTTP, no database: this is
the only place marks are computed. — Implemented in `apps/api/src/attempts/scoring.ts` (a refusal
is chosen over ignoring, and `NUMERICAL` questions are refused), proved by
`apps/api/src/attempts/scoring.spec.ts`, and recorded in decision 0076. — Verified in both
nine-job runs of `04f7fabd4cd7d64fde45c65295f8e9e00d9e33c7`: [run 42440488533](https://github.com/Kapil-viahwa/abhyas/actions/runs/42440488533) and [run 42440491591](https://github.com/Kapil-viahwa/abhyas/actions/runs/42440491591), eighteen green check results between them. The `unit` jobs read
`✓ src/attempts/scoring.spec.ts (23 tests)` and `Tests 220 passed (220)`, so all 23 scoring cases,
the property test included, passed; `lint` and `typecheck` were green in both runs too.

[x] A2b The builder refuses numerical questions (owner's decision, 0077). `apps/api/src/questions/single-correct.ts`
is the one definition of "single-correct" — the option-based single-answer type, at least two
options, exactly one marked correct — used when a paper's question list is set, on submit and
inside the publish transaction; a refusal carries `question_not_single_correct`, the question id
and a sentence that never names the key. The builder's picker offers only such questions and
says so. Proof: `apps/api/test/tests-builder.test.ts` (a numerical question refused on set,
submit and publish, with the previous list and the status left intact, and a valid paper still
building and publishing), `apps/api/src/questions/single-correct.spec.ts` for the four reasons,
and one Playwright check that the picker does not offer the fixture's numerical question. — Verified in both nine-job runs of `3fcbe4eb3756b48c197812f10552a7c0e54ebc43`: [run 43805423670](https://github.com/Kapil-viahwa/abhyas/actions/runs/43805423670) and [run 43805427751](https://github.com/Kapil-viahwa/abhyas/actions/runs/43805427751), eighteen green check results. Each `unit` job logs `✓ src/questions/single-correct.spec.ts (7 tests)` inside `Test Files 29 passed (29)` / `Tests 227 passed (227)`. The `database` jobs (2m25s and 1m53s) are green under `set -o pipefail`, which proves the whole `test/` suite, `apps/api/test/tests-builder.test.ts` included, ran and passed; their readable log slices are Postgres output, so the vitest summary is not re-quotable. The `e2e` jobs (4m01s and 4m02s) are green under pipefail, so the new picker check and every existing spec passed; their readable slices are container output, so the Playwright list is not re-quotable.

[x] A3a Attempt API and lazy expiry. `POST /v1/enrollments/:id/attempt` (self-only, no `userId`
anywhere, an `OPEN` enrollment required, one start only, the deadline computed on the server,
questions returned once in the version's order **without** `is_correct`, a numerical answer or an
explanation); `POST /v1/attempts/:id/submit` (idempotent, the grace window honoured, every answer
validated against the version's questions and their options, one result written in one
transaction); `GET /v1/attempts/:id` (status and remaining seconds, never the questions);
`GET /v1/attempts/:id/result` (own, only after the end, answer keys and explanations only then).
Expiry is lazy on any read or submit: a shared `finalizeExpiredAttempt` finalises an expired
attempt under the attempt row lock, with lock order attempt → enrollment → answers → status →
result. Proof: `apps/api/test/attempts-api.test.ts` — the exact deadline, the paper once, no key
in any pre-end response, a simultaneous start giving one attempt, one submit and its retry, two
parallel submits giving one result, the grace window, a late submit discarded, parallel reads
finalising once, a submit racing a read, and the result refused until the end. — Verified in both
nine-job runs of `2c543788972b905952e2277cb1ee72f416d9b1b9`: [run 43809120061](https://github.com/Kapil-viahwa/abhyas/actions/runs/43809120061) and [run 43809127073](https://github.com/Kapil-viahwa/abhyas/actions/runs/43809127073), eighteen green check results. Each `unit` job logs `✓ src/attempts/attempts.projection.spec.ts (4 tests)` and `✓ src/auth/route-access.spec.ts (1 test)` inside `Test Files 30 passed (30)` / `Tests 231 passed (231)`; `typecheck` is green with the `AttemptState` interface fixed; the `database` jobs are green under `set -o pipefail`, so `apps/api/test/attempts-api.test.ts` and its fourteen cases ran and passed after the decimal fix (their readable slices are Postgres output, so the vitest summary is not re-quotable); the `e2e` jobs are green, so every existing spec still passed.

[x] A3b The deadline sweeper. A repeatable job in `apps/worker` every 30 seconds (one constant)
that calls the API's internal `POST /v1/internal/attempts/expire-expired` — guarded by
`INTERNAL_API_SECRET` and `INTERNAL_ALLOWED_ADDRESSES` through the same `assertInternalRequest`
as the coin drain, and answering 404 to every wrong caller. The route claims up to 50 expired
attempts with `FOR UPDATE SKIP LOCKED` in a short transaction, then finalises each in its own
transaction through the same `finalizeExpiredAttempt(id, 'SWEEPER')` the lazy reads use, and
returns counts only. The worker treats an HTTP error or a timeout as a failed tick that is logged
and retried on the next one, and runs again immediately (bounded) while a full batch comes back.
Proof: `apps/api/test/attempts-sweeper.test.ts` (finalise once with `SWEEPER`, an empty result
and an `EXPIRED` enrollment; not-due, inside-grace and already-submitted attempts untouched; two
simultaneous sweeps finalising once between them; a sweep racing a submit giving one result;
capped batches; one injected failure not stopping the others; every refusal 404 with nothing
changed), `apps/worker/src/jobs/attempt-sweeper.spec.ts` (the loop, the cap, and an unreachable
API not throwing), and `e2e/attempt-sweeper.spec.ts` proving the REAL worker sweeps a seeded
expired attempt with source `SWEEPER`. — Verified in both nine-job runs of
`6f5579a96179378d4ffb58b0ff3475533b103227`: [run 43814445045](https://github.com/Kapil-viahwa/abhyas/actions/runs/43814445045) and [run 43814450079](https://github.com/Kapil-viahwa/abhyas/actions/runs/43814450079), eighteen green check results, gitleaks 8s and 15s. Each `unit` job logs `✓ src/jobs/attempt-sweeper.spec.ts (7 tests)`, `✓ src/queues/schedule.spec.ts (4 tests)` and `✓ src/auth/route-access.spec.ts (1 test)` inside `Test Files 6 passed (6)` / `Tests 25 passed (25)` for the worker and `Tests 231 passed (231)` for the API. The `database` jobs are green under `set -o pipefail`, so `apps/api/test/attempts-sweeper.test.ts` and the existing coin and bulk tests ran and passed; their readable slices are Postgres output, so the vitest summary is not re-quotable. The `e2e` jobs are green, so `e2e/attempt-sweeper.spec.ts` ran and passed (the run before, `1f07d3d`, reports `43 passed` with this spec the only failure); their readable slices show the worker's `repeatable jobs registered: …, attempt-expiry-sweep` line and only its early `0 expired swept` ticks — the later `1 expired swept` line is in the elided portion, so the spec's `AUTO_SUBMITTED|SWEEPER` assertion, not a quoted log line, is the proof. The red round on the way: `1f07d3d` was red in `e2e` in both runs with `Expected: "0" / Received: "0.00"` at `e2e/attempt-sweeper.spec.ts:60` — the spec compared `NUMERIC(8,2)` text, the test was wrong, and it was fixed in `6f5579a` without touching product code.

[x] A4 The taking page. `/attempt/<enrollmentId>`: the paper in the version's order, a countdown from the
server's remaining seconds that re-syncs on every read and never decides expiry, answer selection
for single-correct questions, a submit confirmation, a warning before leaving, and an automatic
redirect to the result when the attempt ends. Server-checked with `loadSession`. Playwright:
a student starts, answers, submits and sees the result; a slow page does not move the deadline
(the deadline shown after a delay is the server's); a submit after expiry is refused with the
message. — Verified in both nine-job runs of `e2f88959cb555610ed6a6d47f952de9d99d3d60c`:
[run 43841325606](https://github.com/Kapil-viahwa/abhyas/actions/runs/43841325606) (push, `e2e` 5m38s, `gitleaks` 10s) and [run 43841317370](https://github.com/Kapil-viahwa/abhyas/actions/runs/43841317370) (pull_request, `e2e` 5m35s, `gitleaks` 8s), eighteen green check results. The `e2e` jobs are green under `set -o pipefail`, so the whole `playwright test` run exited 0 and the five `attempt-take` tests ran and passed — no test in that file is skipped and the `describe.serial` suite stops at the first failure, so a passing run is all five. Their readable slices are container and Postgres output, so the Playwright summary line is not re-quotable; the green job is the proof. The claim table, the four defects found in the old tree and the red rounds on the way are in `PROGRESS.md`.

[x] A5 The result and review pages, with Playwright: score, accuracy, correct, wrong, unattempted,
and the per-question review (the student's answer, the correct answer, the explanation) only
after the attempt has ended; another student cannot open either page. The enrollment page stops
promising "taking it is the next phase" and links to the start. — Verified in both nine-job runs
of `0637d1477d612074af56a0a9994d5e5c57d6dbf7`: [run 43857637203](https://github.com/Kapil-viahwa/abhyas/actions/runs/43857637203)
(push, `e2e` 6m00s, `gitleaks` 10s) and [run 43857648539](https://github.com/Kapil-viahwa/abhyas/actions/runs/43857648539)
(pull_request, GitHub's merge of `0637d14` into `1133d76`, `e2e` 6m08s, `gitleaks` 11s), eighteen
green check results between them. Each `unit` job logs `✓ src/lib/security-headers.spec.ts (8 tests)`
inside `Test Files 9 passed (9)` / `Tests 57 passed (57)` for `apps/web`, so the new no-store rule for
`/attempt/result/:path*` passed. The `database` jobs are green under `set -o pipefail`, so the whole
`pnpm test:db` suite ran and passed, `apps/api/test/attempts-api.test.ts` and its five new review
cases (the frozen version, the auto-submitted review, the scan that finds a key only in the result, the
malformed id, the two parallel result reads) included; their readable slices are Postgres output, so the
vitest summary is not re-quotable. The `e2e` jobs are green under pipefail, so the whole
`playwright test` run exited 0 and the five `describe.serial` tests in `e2e/attempt-review.spec.ts` ran
and passed — none is skipped and a serial block stops at the first failure, so a passing run is all
five; their readable slices are container and Postgres output, so the Playwright list is not re-quotable.
The claim table and the red rounds are in `PROGRESS.md`. The review's question **content** is still read
from each question's current version, so it is not yet immutable beside the frozen result (decision
0082); A5b pins the question version and is queued **before** the merge.

[x] A5b Question versioning in attempts (decision 0082). Pin the question version at publish —
`test_questions` gains `question_version_id`, backfilled from each question's current version and
frozen with the paper, and the start response, the scoring function and the review all read that
pinned version instead of the question's `currentVersion` pointer. Tests: a published paper's content
and key survive an edit; a live attempt still submits and is scored against the paper it was given;
the review shows the pinned content. — Done. Verified in both runs of
`015bf33dabdb9745571209e53572e0570342e8bd`: the push run
[44002634499](https://github.com/Kapil-viahwa/abhyas/actions/runs/44002634499) (`e2e` 5m41s,
`gitleaks` 9s) and the pull_request run
[44002642601](https://github.com/Kapil-viahwa/abhyas/actions/runs/44002642601) (`e2e` 5m26s,
`gitleaks` 17s), eighteen green checks between them. The push run's `gitleaks` job hung
(`133770196668`, reported "running, 7s" for ~20 minutes); it was re-run once and passed in 9s as
`133867898247`. The `database` jobs (1m53s and 1m56s) ran `apps/api/test/attempts-pinning.test.ts`
with all seven cases plus every existing suite; the `e2e` jobs ran the sixth `attempt-review` case and
every existing spec. The claim table and the red rounds are in `PROGRESS.md`; the backfill rule stays
owner-to-confirm in decision 0082, and the deploy note (the migration must own `test_questions`) is
recorded there. The item was ticked in a docs-only commit, so its own runs are the pair above.

[x] A6 Docs and merge. Done: `docs/permissions.md` at the final state (every Phase 7 route,
screen, guard and no-store rule, plus the A5b pinning section), decision 0082's status and deploy
note, the owner-to-confirm list at the end of 0074–0082, the known gaps, `docs/ROADMAP.md`, the
README links, the `PROGRESS.md` phase-wide claim table with run links, the rewritten PR #28
description, and the CI hygiene change (the `gitleaks` job capped at five minutes). `main` was
unmoved at `1133d76`, so no merge commit and no migration rename were needed there. Verified head
`0a39795b57591501a0cb839aadfd3c77e41e6d5f`: push run
[44034502274](https://github.com/Kapil-viahwa/abhyas/actions/runs/44034502274) (`e2e` 5m31s,
`gitleaks` 6s) and pull_request run
[44034508093](https://github.com/Kapil-viahwa/abhyas/actions/runs/44034508093) (`e2e` 5m32s,
`gitleaks` 10s), eighteen green checks. PR #28 was marked ready and merged with a normal merge
commit as [`574fb346506b11a397a8128805ba8b1cd1467b5e`](https://github.com/Kapil-viahwa/abhyas/commit/574fb346506b11a397a8128805ba8b1cd1467b5e);
`main`'s CI on it is [44035329876](https://github.com/Kapil-viahwa/abhyas/actions/runs/44035329876),
nine jobs green, `e2e` 6m03s and `gitleaks` 7s — no re-run was made, the job simply finished well
inside its 20-minute cap. This queue close is merged back to `main` under the same normal-merge
rule.

[ ] A7 STOP and report. Results, analytics and dashboards (phase 8) start only on the owner's
prompt.

## Reporting

Report in at most 8 lines: what was pushed, which queue item, which test proves it, what is
not done. Never claim a pass that was not seen in a finished CI run.
