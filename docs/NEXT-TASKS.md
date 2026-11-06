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

[ ] P2 Editor/Admin test-builder API: create a draft, edit it, add, remove and reorder questions from the bank (validated: own or admin question, published, same exam), set duration, marks and negative marking, submit; Admin publish and archive. Strict query and body validation. Permission tests: an Editor with `manage_tests` builds and submits; an Editor without it gets 403; an Editor with `publish_tests` is no longer possible, and an Editor or Student calling publish or archive gets **403** (route-access sweep plus per-route tests); a Student is refused on every builder route. Answer keys are never in a student response. Create on a published test opens a new version and leaves an open enrollment's snapshot untouched. Tests: `apps/api/test/tests-builder.test.ts` in the database job.

[ ] P3 Test-builder web pages for Editor and Admin, server-checked with `loadPermissionSession`, mobile responsive, linked from the editor and admin navigation: draft list, builder form (pattern, question picker, ordering), submit; Admin view with publish and archive. The publish and archive controls do not render for an Editor, and the navigation link follows the permission. Playwright in the existing `e2e` job: an editor builds a test, adds questions, sets the pattern and submits; an admin publishes it; the editor's page has no publish button; an editor posting to the publish route gets the API's 403; a student cannot reach the pages or the APIs. Specs pin every setting they read with the upsert-and-verify fixture and use unique emails. The spec's editor holds `manage_tests` only, because `publish_tests` no longer exists.

[ ] P4 Enrollment API: `GET /v1/tests`, `GET /v1/tests/:id`, `POST /v1/tests/:id/enroll`, `GET /v1/enrollments/me`. Self-only — no `userId` anywhere, the account is the session's. Enrollment is one transaction: lock the wallet row, read the cost from `default_enrollment_cost`, write the `ENROLLMENT` ledger row with the request's Idempotency-Key and `reference_type = 'enrollment'`, `reference_id = <enrollment id>`, then the enrollment row. Refusals: insufficient balance, an open enrollment for that test, the test's maximum attempts reached, a suspended account, an unpublished or archived test. Database-job tests: two simultaneous submits write one debit and one enrollment; two students racing for the last 100 coins give one success and one refusal with a correct balance; retakes pay again and the old attempt stays untouched.

[ ] P5 Student catalog and enroll web pages: `/tests` and `/tests/<id>`, server-checked, with title, duration, question count, total marks, cost and the student's own state; enroll is a form post; `/wallet` shows the ENROLLMENT row afterwards. Playwright: a student browses, enrolls, the balance drops by 100, the wallet history shows the ENROLLMENT row, a second enroll is refused, an insufficient-balance message is shown, and an anonymous visitor is redirected. Settings pinned with the upsert-and-verify fixture, unique emails.

[ ] P6 Docs and merge: `docs/permissions.md` (the new routes and the Admin-only publish rule), `docs/decisions.md` (the assumptions confirmed or corrected), Known gaps, `docs/ROADMAP.md`, `README.md`, the `PROGRESS.md` claim table with run links, the PR description, then mark ready and merge **only** when all nine jobs are green in both runs; then confirm main CI. Never push to `main`.

[ ] P7 STOP and report. The attempt engine (starting and taking a test) is the next phase and starts only on the owner's prompt.

## Reporting

Report in at most 8 lines: what was pushed, which queue item, which test proves it, what is
not done. Never claim a pass that was not seen in a finished CI run.
