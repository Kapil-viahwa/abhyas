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

[ ] Q5 Docs and merge: update docs/permissions.md, docs/decisions.md, Known gaps (email-only signup grant farming risk; admin coin writes need re-authentication; internal route allowed addresses; SECURITY DEFINER wallet design as a later improvement), docs/ROADMAP.md, README links, the PROGRESS.md claim table with run links and the PR description; mark PR #21 ready. You are authorized to merge PR #21 with a normal merge commit once all nine jobs are green on both runs; then confirm main CI.

[ ] Q6 STOP and report. Phase 6 (test builder and enrollment) starts only when the owner provides its prompt.

## Reporting

Report in at most 8 lines: what was pushed, which queue item, which test proves it, what is
not done. Never claim a pass that was not seen in a finished CI run.
