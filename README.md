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

## Repository layout (planned)

```
apps/mobile?  no
apps/api      HTTP API, business rules, persistence
apps/web      student + editor + admin UI
apps/worker   BullMQ background jobs
packages/     shared types, config, UI kit, API client
infra/        Docker Compose, Nginx, local S3/Postgres/Redis
docs/         decisions, working rules, runbooks
.github/      CI (lint, typecheck, test, Playwright, build)
```

## Working rules

The rules this repository is built under are in [docs/working-rules.md](docs/working-rules.md). They are not advisory: nothing is claimed as done until it has run, each phase is one branch and one pull request with green CI, and every phase ships migrations, API, web screens and tests together.

Architecture decisions and the reason for every dependency: [docs/decisions.md](docs/decisions.md).
Honest per-phase status: [PROGRESS.md](PROGRESS.md).

## Getting started

The scaffold does not exist yet. Phase 0 creates the monorepo, pinned toolchain, Docker Compose stack and CI pipeline. Until then there is nothing to install.
