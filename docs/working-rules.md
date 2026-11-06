# Working rules

Acknowledged at Phase F0. These bind every phase of this repository.

## Session protocol

A session does **one unit of work**, pushes **once**, and **stops immediately**. It does not
poll or wait for CI after pushing; it ends by saying "pushed `<sha>`, runs queued". The next
session starts by reading the finished CI runs for the latest commit of the branch, fixes any
red job first (quoting the first real error before changing anything), and only then takes the
next unit. The ordered queue lives in `docs/NEXT-TASKS.md`; the pre-push checklist is below.
Never read files you do not need, never print large logs, and quote only the first real error.

## Execution first

1. **Nothing is done until it has run.** We never write "done", "works" or "tests pass" for anything not seen passing, either in a sandbox or in a CI run we have read. If code cannot be run, say so, rely on CI, and list exactly what stayed unverified.
2. **Small slices.** Never more than ~15 files or ~400 lines without a green CI run on the branch. After each slice: lint, typecheck, tests, push, read the CI result, fix, continue.
3. **Read real errors.** Quote the first actual error line from a failing log before changing anything. Never guess a cause.
4. **One phase = one branch = one pull request.** Merge to `main` only when every CI job is green on the latest commit. `main` is never left red. A test is never deleted or weakened to make it pass; if a test is wrong, say why it is wrong.

## Shape of a phase

5. **Vertical slices.** Every phase includes its own database migrations, API, web screens and automated tests (unit, database, and Playwright for user flows). A phase with only APIs is not done.
6. **Incremental schema.** Each phase adds only the tables it needs, in its own migration, with tests proving its constraints. The full schema is never written upfront.

## Toolchain and supply chain

7. **Pinned and reproducible.** Node 22 pinned everywhere (`.nvmrc`, `engines`, CI, Docker), committed lockfile, frozen installs, GitHub Actions pinned to commit SHAs, read-only default workflow permissions. Every new dependency gets its reason in `docs/decisions.md`.

## Security

8. **The backend is the only authority** for timers, scoring, answer keys, coins, roles and enrollment. Authorization is deny-by-default with object-level checks (no IDOR). Coins use an append-only ledger with DB transactions, row locks, idempotency keys and CHECK constraints. Answer keys and explanations never leave the server before submission. All times are stored UTC; business dates are Asia/Kolkata. Input is validated and rich text sanitized. No secrets in git (`.env.example` plus GitHub secrets only). Dev shortcuts (test Turnstile keys, fake SMS) must be impossible in production, proven by a boot-refusal test.

## Reporting

9. **`PROGRESS.md` stays honest**, with columns: Built, Verified by (CI run link or test name), Known gaps.
10. **End of every phase report:** CI run link, a table of job statuses, what changed, what is still unverified. Then stop for approval.



## Pre-push checklist

Run this on your own diff before every push. Each line is a failure that has already cost a
red run on this repository.

- Every indexed access (`array[0]`, `match[1]`, destructuring, `Record` lookups, regex
  groups) is handled as possibly undefined (`noUncheckedIndexedAccess`).
- Callback and arrow return types match the declared type (no `Promise<number>` where
  `Promise<void>` is required).
- Regexes that list control characters carry a single-line `eslint-disable-next-line` with a
  written reason; no lint config changes.
- Test assertions describe what the code now does, and do not depend on ordering or shared
  state between tests.
- Anything de-duplicated or compared is normalised first (lower-case, trim), then
  de-duplicated.
- New env variables are added to `.env.example`, both compose files, the per-service env
  test and the validator in the same push.
- No push while any run for the branch is in progress; no push to `main`.
