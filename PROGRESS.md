# Progress

Honest status. "Verified by" names a CI run and the job in it that actually executed; nothing else counts. A row that has never executed in CI says so.

| Phase | Scope | Built | Verified by | Known gaps |
| --- | --- | --- | --- | --- |
| F0 | Working rules acknowledged, repository created | README, working rules, decision log, progress table, Node 22 pin | Documentation only — no CI job proves documentation | No code, no CI |
| 0 | Walking skeleton: pnpm monorepo, API `/health` + `/api/docs`, web health page, worker example job, Prisma with one migration, dev and production compose, nine CI jobs, Playwright flow | See the mapping table below | Run [41312145907](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907) on commit `e108d7d` (pull request #1): all nine jobs green. The `api-boot` diagnostic job that produced the short API log during the container fix passed in that run too and was then removed as redundant | No Nginx in front of the stack; no S3-compatible storage; images copy the whole workspace instead of a pruned deploy, so they are larger than necessary; containers run as root; one Playwright flow only; dev-only advisories remain and are listed in `docs/security-exceptions.md` |

## What CI proves, and the job + run that proves it

Every link below is the job in run [41312145907](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907) on commit `e108d7d`.

| Claim | Job | Evidence | Proof |
| --- | --- | --- | --- |
| Every package lints clean | lint | `pnpm lint` exited 0 | [job 124864566039](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566039) |
| Every package typechecks against the built shared package | typecheck | `pnpm typecheck` exited 0 | [job 124864566006](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566006) |
| Environment validation refuses production shortcuts | unit | `env.spec.ts` and `config.spec.ts`: Turnstile test key, fake SMS, dev login, short or default auth secret, missing variables | [job 124864566072](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566072) |
| Health logic reports ok and degraded correctly | unit | `health.service.spec.ts` | [job 124864566072](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566072) |
| Web health client maps 200, 503-with-body and transport failures | unit | `api.spec.ts` | [job 124864566072](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566072) |
| The worker job validates its payload | unit | `ping.spec.ts` | [job 124864566072](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566072) |
| Migrations apply to an empty schema and constraints are enforced by Postgres | database | `migrations.test.ts` against Postgres 16: migration recorded, table created, blank key and over-long value rejected | [job 124864565781](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864565781) |
| All three images build from the repository | docker | `docker compose build` | [job 124864565927](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864565927) |
| Production compose has no dev shortcuts, no data ports and no default secrets | docker | `scripts/validate-compose-prod.mjs` | [job 124864565927](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864565927) |
| The stack comes up from a clean checkout and serves health and docs | compose-smoke | `docker compose up --wait`, `curl /health`, `curl /api/docs-json`, `curl /` | [job 124864566047](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566047) |
| A user can open the home page and see a healthy API | e2e | `home.spec.ts`: `data-status="ok"`, database `ok`, redis `ok`, `/health` present in the OpenAPI document | [job 124864565996](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864565996) |
| No secret is committed | gitleaks | full-history scan, "no leaks found", 21 commits | [job 124864566053](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864566053) |
| No high or critical advisory in a production dependency | audit | `pnpm audit:ci`: fails on production high/critical, reports dev-only findings as warnings listed in `docs/security-exceptions.md` | [job 124864565951](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312145907/job/124864565951) |

Every job writes the last 80 lines of its captured logs to the job summary on failure and uploads the full logs as an artifact. The `compose-smoke` and `e2e` jobs additionally print the API container's last 150 lines to the job log and the job summary when the stack fails to come up.

## How the two phase 0 failures were found and fixed

| Failure | First real error line | Fix |
| --- | --- | --- |
| API container exited (1), failing `compose-smoke` and `e2e` | `Error loading shared library libssl.so.1.1: No such file or directory` from the Prisma query engine inside `node:22-bookworm-slim` | `binaryTargets = ["native", "debian-openssl-3.0.x"]` in `schema.prisma` and `openssl` installed in both image stages |
| API refused to boot once the engine loaded | `The "@fastify/static" package is missing. Please install it.` from `@nestjs/swagger` under the Fastify adapter | `@fastify/static` added as an API dependency, with the reason in `docs/decisions.md` |
| Audit blocked on 60 advisories | `high fastify ... Vulnerable versions <5.12.2 ... @nestjs/platform-fastify@10.4.22 > fastify@4.28.1` | NestJS 11 + Fastify 5, vitest/vite upgrades, and three pnpm overrides with recorded reasons |
| gitleaks failed on the pull request | `RequestError [HttpError]: Resource not accessible by integration ... url: 'https://api.github.com/repos/Kapil-viahwa/abhyas/pulls/1/commits'` (`x-accepted-github-permissions: pull_requests=read`) | `pull-requests: read` granted on the gitleaks job only |
