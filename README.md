# Abhyas

A production-grade mock test platform for India's competitive exams (SSC, Banking, Railways, UPSC), built from scratch with original branding. Students take full-length and sectional mock tests, editors author question banks, admins run the platform.

## Roles

- **ADMIN** — everything: users, roles, coins, settings, content.
- **EDITOR** — content only. Created by an Admin. Cannot touch users, roles, coins or settings.
- **USER** — student.

## Coins

- 1,000 coins, once per person, at signup.
- +10 coins on the first login of each day (business date in Asia/Kolkata).
- −100 coins per mock test attempt; the amount is editable per test.
- Only an Admin can add or deduct coins outside the rules above.
- Coins live in an append-only ledger: DB transactions, row locks, idempotency keys, CHECK constraints.

The full rules are in [docs/PHASE5-SPEC.md](docs/PHASE5-SPEC.md), the routes and who may call
them in [docs/permissions.md](docs/permissions.md#phase-5-a-students-own-wallet), and the
decisions behind them (0060–0066) in [docs/decisions.md](docs/decisions.md). A student sees
their own wallet at `/wallet`; an Administrator runs the coin tools at `/admin/coins`, and both
are server-checked against the session rather than a token in the browser.

## Stack (fixed)

pnpm monorepo · Node 22

| Package | Tech |
| --- | --- |
| `apps/web` | Next.js (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Query, KaTeX, TanStack/React, OpenAPI client |
| `apps/api` | NestJS (Fastify adapter), REST, OpenAPI |
| `apps/web` editor | TipTap rich text |
| `apps/web` analytics | Recharts |
| `apps/api` data | PostgreSQL 16, Prisma + hand-written SQL migrations |
| `apps/api` jobs | Redis 7 + BullMQ (`apps/worker`) |
| Storage | S3-compatible object store, presigned URLs |
| Runtime | Docker Compose + Fastify behind Nginx |
| Tests | Vitest / node:test, Supertest, Playwright |

No dependency on any vendor's hosting or managed database: everything runs from this repo.

## Repository layout

```
apps/api      NestJS (Fastify) REST API, Prisma schema and migrations, tests
apps/web      Next.js App Router UI for students, editors and admins
apps/worker   BullMQ background jobs
packages/     shared environment validation and cross-cutting types
e2e           Playwright user flows against the running stack
scripts       CI helpers (failure summary, production compose validation)
docs/         architecture, decisions, working rules
.github/      CI (lint, typecheck, unit, database, docker, smoke, e2e, gitleaks, audit)
```

## Working rules

The rules this repository is built under are in [docs/working-rules.md](docs/working-rules.md). They are not advisory: nothing is claimed as done until it has run, each phase is one branch and one pull request with green CI, and every phase ships migrations, API, web screens and tests together.

Architecture: [docs/architecture.md](docs/architecture.md). Decisions and the reason for every dependency: [docs/decisions.md](docs/decisions.md). Accepted advisories and why: [docs/security-exceptions.md](docs/security-exceptions.md). Honest per-phase status: [PROGRESS.md](PROGRESS.md).

Where the work is going, and what each phase owes: [docs/ROADMAP.md](docs/ROADMAP.md). Per-phase records: [docs/PHASE4-CHECKLIST.md](docs/PHASE4-CHECKLIST.md) (what Phase 4 shipped and what Phase 4b still owes), [docs/PHASE2C-SPEC.md](docs/PHASE2C-SPEC.md) (the mobile OTP specification) and [docs/PHASE5-SPEC.md](docs/PHASE5-SPEC.md) (the coin specification), kept in the repository so a later session can resume from the repo alone.

## Getting started

Requires Node 22, pnpm 9 and Docker.

```bash
cp .env.example .env
pnpm install
docker compose up -d postgres redis   # creates both database roles on a fresh volume
pnpm db:migrate            # applies apps/api/prisma/migrations as the owner role
docker compose up --build  # web :3000, api :3001, worker, postgres, redis
```

Two database roles: migrations connect as the owner (`MIGRATION_DATABASE_URL`) and the API
and worker connect as `abhyas_app` (`DATABASE_URL`), which is not a superuser and cannot
rewrite `audit_logs`. `docker/postgres-init/01-app-role.sql` creates it in development and CI.

The first Administrator is created from environment variables, never from a default
password. Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (12+ characters, at least one
letter and one digit) in `.env`, then:

```bash
pnpm db:seed:admin         # idempotent: does nothing if an admin already exists
```

`NODE_ENV=production` additionally requires `SEED_ADMIN_CONFIRM=create-first-admin`, so the
seeder cannot create an admin in production by accident.

The home page at http://localhost:3000 renders the API's `/health` result, and the API's
OpenAPI document is at http://localhost:3001/api/docs in development and CI. It is not mounted
when `NODE_ENV=production`: in production both `/api/docs` and `/api/docs-json` answer 404.

## Accounts and sessions

Register at http://localhost:3000/register, then open the verification link the API prints
(the console outbox — `docker compose logs api`). Sign in at `/login`, and the account page
at `/account` shows the active sessions, lets you end one or all the others, change the
password and deactivate the account.

The browser never holds a token. The web app talks to the API server-side only, and the
two opaque tokens live in httpOnly `SameSite=Lax` cookies; every write is a form post
guarded by an `Origin` check and a double-submit CSRF value. An expired access cookie is
refreshed silently on the server. `TURNSTILE_SITE_KEY` is required in production and must
not be a Cloudflare test key; development and CI use the test key.

## Administration and the catalog

Administrators work from `/admin`: accounts (search, filters, editor creation, capability
editing, suspend and restore), the catalog, the settings the platform runs on, the audit
trail (filter, page, export), and a dashboard of real counts. Editors work from
`/editor/catalog`, where the API lets them change only the content they created.

The public catalog is server-rendered at `/exams`, `/exams/<category>` and
`/exams/<category>/<exam>`, with their own titles, descriptions, canonicals and
breadcrumbs. A catalog write asks the web tier to drop the cached pages through
`/api/revalidate`, which accepts only the shared `REVALIDATE_SECRET`.

```bash
pnpm db:seed:catalog       # a few example exam groups; idempotent by slug, never automatic
```

`NODE_ENV=production` refuses that seed without
`CATALOG_SEED_CONFIRM=seed-example-catalog`, and it needs an Administrator to own the rows:
run `pnpm db:seed:admin` first.

Local commands (each one is what CI runs):

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:db        # needs a reachable DATABASE_URL
pnpm test:e2e       # needs the compose stack up
pnpm compose:validate
```

Production topology is `docker-compose.prod.yml`: it publishes only the web port, requires
every secret from the environment by name, and is checked in CI by
`scripts/validate-compose-prod.mjs`.

