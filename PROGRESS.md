# Progress

Honest status. "Verified by" names a CI run or a test that actually ran; nothing else counts. A row that has never executed in CI says so.

| Phase | Scope | Built | Verified by | Known gaps |
| --- | --- | --- | --- | --- |
| F0 | Working rules acknowledged, repository created | README, working rules, decision log, progress table, Node 22 pin | Nothing — documentation only | No code, no CI |
| 0 | Walking skeleton: pnpm monorepo, API `/health` + `/api/docs`, web health page, worker example job, Prisma with one migration, dev and production compose, ten CI jobs, Playwright flow | See the mapping table below | **In progress.** Two causes were found from CI logs and fixed: Prisma could not load its engine (`libssl.so.1.1` missing in the slim image) and the audit gate blocked on the Nest 10 line. Lockfile is committed; verification of the current commit is pending | No Nginx in front of the stack; no S3-compatible storage; images copy the whole workspace instead of a pruned deploy, so they are larger than necessary; containers run as root; one Playwright flow only |

## What CI is built to prove, and which job proves it

Nothing in this table has run yet. Each row is the claim its job must satisfy on the first green run.

| Claim | Job | Evidence |
| --- | --- | --- |
| Every package lints clean | lint | `pnpm lint` exits 0 |
| Every package typechecks against the built shared package | typecheck | `pnpm typecheck` exits 0 |
| Environment validation refuses production shortcuts | unit | `env.spec.ts` and `config.spec.ts`: Turnstile test key, fake SMS, dev login, short or default auth secret, missing variables |
| Health logic reports ok and degraded correctly | unit | `health.service.spec.ts` |
| Web health client maps 200, 503-with-body and transport failures | unit | `api.spec.ts` |
| The worker job validates its payload | unit | `ping.spec.ts` |
| Migrations apply to an empty schema and constraints are enforced by Postgres | database | `migrations.test.ts` against Postgres 16: migration recorded, table created, blank key and over-long value rejected |
| All three images build from the repository | docker | `docker compose build` |
| Production compose has no dev shortcuts, no data ports and no default secrets | docker | `scripts/validate-compose-prod.mjs` |
| The stack comes up and serves health and docs | compose-smoke | `docker compose up --wait`, `curl /health`, `curl /api/docs-json`, `curl /` |
| A user can open the home page and see a healthy API | e2e | `home.spec.ts`: `data-status="ok"`, database `ok`, redis `ok`, `/health` present in the OpenAPI document |
| No secret is committed | gitleaks | full-history scan |
| No high or critical advisory in a production dependency | audit | `pnpm audit:ci`: parses `pnpm audit --prod --json`, fails on production high/critical, reports dev-only findings as warnings listed in `docs/security-exceptions.md` |

Every job writes the last 80 lines of its captured logs to the job summary on failure and uploads the full logs as an artifact.
