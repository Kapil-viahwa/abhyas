# Decision log

One entry per decision that changes how the system is built or operated, and one line per dependency saying why it is here. Entries are appended, never rewritten; if a decision is reversed, a new entry supersedes it.

Status values: `accepted`, `superseded by NNNN`.

---

## 0001 — Fixed stack, no vendor lock-in

**Status:** accepted · **Phase:** F0

pnpm monorepo; `apps/web` (Next.js App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query, KaTeX, TipTap, Recharts), `apps/api` (NestJS on Fastify, REST, OpenAPI), `apps/worker` (BullMQ), PostgreSQL 16 via Prisma with raw SQL migrations for constraints, triggers and partitions, Redis 7, S3-compatible storage with presigned URLs, Docker Compose + Nginx, Node 22.

**Why:** the platform must run on any machine or host from this repository alone — no managed database, no builder-specific hosting. Prisma covers typed ordinary access; hand-written SQL migrations are where CHECK constraints, triggers, partial indexes and partitioning live, because the ORM cannot express them and money-adjacent rules (coin ledger) must be enforced by the database.

## 0002 — Node 22 pinned everywhere

**Status:** accepted · **Phase:** F0

Node 22 is pinned in `.nvmrc`, in every `package.json` `engines` field, in CI, and in every Docker image, all with the same major. Installs are frozen (`--frozen-lockfile`) and the lockfile is committed.

**Why:** a single runtime version removes an entire class of "works on my machine" failures and keeps CI, local development and production identical.

## 0003 — GitHub Actions pinned by commit SHA, read-only by default

**Status:** accepted · **Phase:** F0

Third-party actions are referenced by full commit SHA, not by tag. The default workflow token permission is read-only, raised per job only where required.

**Why:** a mutable tag can be repointed at malicious code; a default-writable token turns any compromised step into a push. Both are supply-chain risks that cost nothing to avoid up front.

---

## 0004 — pnpm workspaces, one lockfile, frozen installs

**Status:** accepted · **Phase:** 0

One pnpm workspace (`apps/*`, `packages/*`), one committed `pnpm-lock.yaml`, and `pnpm install --frozen-lockfile` in CI and in every Dockerfile.

**Why:** a single resolution of the dependency graph means CI, local development and every image run the same tree. `--frozen-lockfile` turns an accidental dependency edit into a loud failure instead of a silent upgrade.

**Consequence:** the lockfile cannot be produced anywhere that has no package manager. `.github/workflows/lockfile-bootstrap.yml` (manual trigger) generates it in CI and commits it to the branch, so the frozen installs can run. It is the only workflow granted `contents: write`, and only for that job.

## 0005 — Hand-validated environment instead of a validation library

**Status:** accepted · **Phase:** 0

`packages/shared/src/env.ts` validates the environment by hand and is the only gate; the API and the worker both call it before booting.

**Why:** the rules that matter here (refuse Turnstile test keys, fake SMS, dev login and default secrets in production) are business rules, not schema validation, and the messages must name the offending variable. Hand-writing it keeps the boot gate dependency-free and trivially testable, which is what the boot-refusal test needs.

## 0006 — Prisma for access, hand-written SQL for constraints

**Status:** accepted · **Phase:** 0

Prisma Client is the ordinary data-access layer. Migrations are hand-written SQL applied with `prisma migrate deploy`, and every constraint lives in SQL.

**Why:** the ORM cannot express CHECK constraints, partial indexes, triggers or partitioning, and the coin ledger will depend on all four. Migrations are the contract with the database, so they are readable SQL in review, and the database test proves they apply to an empty schema and that the constraints actually reject bad rows.

## 0007 — Health endpoint reports dependencies, not just liveness

**Status:** accepted · **Phase:** 0

`GET /health` answers 200 only when Postgres and Redis both respond; otherwise 503 with the same body, naming which dependency is down.

**Why:** compose healthchecks, the CI smoke test and the home page all need the same answer, and a 503 with a body lets the UI explain what broke instead of showing a generic error.

## 0008 — The web app calls the API server-side only

**Status:** accepted · **Phase:** 0

The home page is a server component that reads `API_INTERNAL_URL`; no API base URL is inlined into the browser bundle.

**Why:** authorization is deny-by-default and object-level, and the backend is the only authority. Keeping the browser out of direct API traffic until there is an authenticated, same-origin proxy keeps that boundary enforceable as screens are added.

## 0009 — Production compose requires every secret and publishes no data ports

**Status:** accepted · **Phase:** 0

`docker-compose.prod.yml` requires `AUTH_SECRET`, `TURNSTILE_SECRET_KEY`, `SMS_PROVIDER` and the database credentials with `${VAR:?message}`, publishes no ports for Postgres, Redis or the API, uses named volumes only, and runs every service with `NODE_ENV=production`.

**Why:** a default secret is the most common way a staging stack becomes a production incident. Compose itself refusing to render without them, plus `scripts/validate-compose-prod.mjs` asserting the rest in CI, makes the production topology testable rather than aspirational.

---

## Dependency reasons

Added with the phase that introduced them; a dependency without a line here is a review failure.

**Runtime**

- `next`, `react`, `react-dom` — the web app (Next.js App Router, the fixed stack).
- `tailwindcss`, `postcss`, `autoprefixer` — Tailwind v3 with the standard PostCSS pipeline; v4 would require a different config surface for no gain in phase 0.
- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify` — the API framework on the fixed Fastify adapter.
- `@nestjs/swagger` — generates the OpenAPI document served at `/api/docs` from the same decorators as the routes, so the document cannot drift from the code.
- `fastify` — declared explicitly rather than relied on transitively, so `FastifyReply` types resolve under pnpm's strict node_modules layout.
- `@abhyas/shared` (workspace) — environment validation shared by API and worker, so neither can forget the production gate.
- `@prisma/client`, `prisma` — typed data access plus the migration runner.
- `ioredis` — Redis client used by the health check and by BullMQ's connection.
- `bullmq` — the fixed queue for background work.
- `reflect-metadata`, `rxjs` — required by Nest's decorator metadata and DI.

**Tooling**

- `typescript` — the language; pinned by the workspace root.
- `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` — one flat lint pass over every package. `eslint-config-next` is deliberately not used yet: it adds lint plugins for Next-specific rules without adding type safety, and phase 0's web surface is one page.
- `vitest` — unit tests in every package; it shares the workspace root so each package can run `vitest` without its own copy.
- `@playwright/test` — the fixed browser test runner, used for the user flow against the running compose stack.
- `@types/node`, `@types/react`, `@types/react-dom` — type definitions only.
