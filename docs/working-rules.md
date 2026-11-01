# Working rules

Acknowledged at Phase F0. These bind every phase of this repository.

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
