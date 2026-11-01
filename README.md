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

## Getting started

Requires Node 22, pnpm 9 and Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:migrate            # applies apps/api/prisma/migrations to DATABASE_URL
docker compose up --build  # web :3000, api :3001, worker, postgres, redis
```

The home page at http://localhost:3000 renders the API's `/health` result, and the API's
OpenAPI document is at http://localhost:3001/api/docs.

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

