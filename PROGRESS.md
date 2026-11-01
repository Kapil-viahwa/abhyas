# Progress

Honest status. "Verified by" names a CI run and the job in it that actually executed; nothing else counts. A row that has never executed in CI says so.

| Phase | Scope | Built | Verified by | Known gaps |
| --- | --- | --- | --- | --- |
| F0 | Working rules acknowledged, repository created | README, working rules, decision log, progress table, Node 22 pin | Documentation only — no CI job proves documentation | No code, no CI |
| 0 | Walking skeleton: pnpm monorepo, API `/health` + `/api/docs`, web health page, worker example job, Prisma with one migration, dev and production compose, nine CI jobs, Playwright flow | See the mapping table below | Run [41312437972](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972) on commit `0f96b9d` (pull request #1): all nine jobs green — lint, typecheck, unit, database, docker, compose-smoke, e2e, gitleaks, audit | No Nginx in front of the stack; no S3-compatible storage; images copy the whole workspace instead of a pruned deploy, so they are larger than necessary; containers run as root; one Playwright flow only; dev-only advisories remain and are listed in `docs/security-exceptions.md` |

## What CI proves, and the job + run that proves it

Every link below is a job in run [41312437972](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972) on commit `0f96b9d`, the latest run in which all nine jobs passed.

| Claim | Job | Evidence | Proof |
| --- | --- | --- | --- |
| Every package lints clean | lint | `pnpm lint` exited 0 | [job 124865446662](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446662) |
| Every package typechecks against the built shared package | typecheck | `pnpm typecheck` exited 0 | [job 124865446684](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446684) |
| Environment validation refuses production shortcuts | unit | `env.spec.ts` and `config.spec.ts`: Turnstile test key, fake SMS, dev login, short or default auth secret, missing variables | [job 124865446618](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446618) |
| Health logic reports ok and degraded correctly | unit | `health.service.spec.ts` | [job 124865446618](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446618) |
| Web health client maps 200, 503-with-body and transport failures | unit | `api.spec.ts` | [job 124865446618](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446618) |
| The worker job validates its payload | unit | `ping.spec.ts` | [job 124865446618](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446618) |
| Migrations apply to an empty schema and constraints are enforced by Postgres | database | `migrations.test.ts` against Postgres 16: migration recorded, table created, blank key and over-long value rejected | [job 124865446612](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446612) |
| All three images build from the repository | docker | `docker compose build` | [job 124865446611](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446611) |
| Production compose has no dev shortcuts, no data ports and no default secrets | docker | `scripts/validate-compose-prod.mjs` | [job 124865446611](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446611) |
| The stack comes up from a clean checkout and serves health and docs | compose-smoke | `docker compose up --wait`, `curl /health`, `curl /api/docs-json`, `curl /` | [job 124865446426](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446426) |
| A user can open the home page and see a healthy API | e2e | `home.spec.ts`: `data-status="ok"`, database `ok`, redis `ok`, `/health` present in the OpenAPI document | [job 124865446801](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446801) |
| No secret is committed | gitleaks | full-history scan, "no leaks found" | [job 124865446569](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446569) |
| No high or critical advisory in a production dependency | audit | `pnpm audit:ci`: 2 production advisories, both moderate, 0 blocking; 6 dev-only findings reported as warnings and listed in `docs/security-exceptions.md` | [job 124865446644](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972/job/124865446644) |

Every job writes the last 80 lines of its captured logs to the job summary on failure and uploads the full logs as an artifact. The `compose-smoke` and `e2e` jobs additionally print the API container's last 150 lines to the job log and the job summary when the stack fails to come up.

## How the phase 0 failures were found and fixed

| Failure | First real error line | Fix |
| --- | --- | --- |
| API container exited (1), failing `compose-smoke` and `e2e` | `Error loading shared library libssl.so.1.1: No such file or directory` from the Prisma query engine inside `node:22-bookworm-slim` | `binaryTargets = ["native", "debian-openssl-3.0.x"]` in `schema.prisma` and `openssl` installed in both image stages |
| API refused to boot once the engine loaded | `The "@fastify/static" package is missing. Please install it.` from `@nestjs/swagger` under the Fastify adapter | `@fastify/static` added as an API dependency, with the reason in `docs/decisions.md` |
| Audit blocked on 60 advisories | `high fastify ... Vulnerable versions <5.12.2 ... @nestjs/platform-fastify@10.4.22 > fastify@4.28.1` | NestJS 11 + Fastify 5, vitest/vite upgrades, and four pnpm overrides with recorded reasons |
| gitleaks failed on the pull request | `RequestError [HttpError]: Resource not accessible by integration ... url: 'https://api.github.com/repos/Kapil-viahwa/abhyas/pulls/1/commits'` (`x-accepted-github-permissions: pull_requests=read`) | `pull-requests: read` granted on the gitleaks job only |
