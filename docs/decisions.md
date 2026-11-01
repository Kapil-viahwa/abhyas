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

**Consequence:** the lockfile cannot be produced anywhere that has no package manager. During phase 0 a temporary `lockfile-bootstrap` workflow (the only workflow ever granted `contents: write`, scoped to a single job) generated it in CI and committed it. That workflow has been deleted now that dependency changes are made with a local install; from phase 1 on, a dependency change is committed together with its lockfile and CI's frozen install is the check.

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

## 0010 — Prisma binary target pinned to Debian OpenSSL 3, and OpenSSL installed in the images

**Status:** accepted · **Phase:** 0

`apps/api/prisma/schema.prisma` declares `binaryTargets = ["native", "debian-openssl-3.0.x"]`, and both Docker stages of the API image install `openssl`.

**Why:** `node:22-bookworm-slim` ships no OpenSSL, so `prisma generate` guessed `openssl-1.1.x` and the API died at boot with `Details: libssl.so.1.1: cannot open shared object file: No such file or directory`. Guessing is the bug: the target is now declared instead of inferred, and the library the engine links against is installed rather than hoped for.

## 0011 — NestJS 11 with Fastify 5

**Status:** accepted · **Phase:** 0

`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify` and `@nestjs/swagger` move to their 11.x line, and `fastify` to 5.12.5 or newer, with `@fastify/static` on 10.x to match Fastify 5.

**Why:** the audit found blocking production advisories in the 10.x line — `fastify` header validation bypass (`<5.12.2`), `@nestjs/platform-fastify` (`<11.1.10`), `@nestjs/core` (`<=11.1.17`), and `fastify` again at 5.12.1 and 5.12.5. The 10.x line cannot be patched, because Nest 10 requires Fastify 4. Upgrading is the only fix that does not weaken the gate.

## 0012 — vitest 3.2.6 with an explicit vite 6.4.4 floor

**Status:** accepted · **Phase:** 0

`vitest` moves to `^3.2.6`, and `vite` is declared directly at `^6.4.4` so the resolution cannot land on a vulnerable 5.x or 6.4.x build.

**Why:** dev-only advisories listed a critical in `vitest` (`<3.2.6`) and well as a critical in `tinypool` and several highs in `vite` (`<=6.4.3`) pulled in through vitest. Declaring `vite` explicitly is the only way to guarantee the patched build under pnpm's resolution.

## 0013 — pnpm overrides for postcss, js-yaml and lodash

**Status:** accepted · **Phase:** 0

`pnpm.overrides` forces `postcss` to `^8.5.18`, `js-yaml` to `^4.3.2` and `lodash` to `^4.17.24`.

**Why:** these three arrive transitively from packages that pin exact versions — `next@15` pins `postcss@8.4.31`, and `@nestjs/swagger@7` pinned `js-yaml@4.1.0` and `lodash@4.17.21` — so no direct upgrade removes them. Each override moves only a patch/minor within the same major, with an upstream advisory confirming the target version is patched. Overrides are reviewed when the parent package catches up, and removed then.

## 0014 — pnpm override for fastify

**Status:** accepted · **Phase:** 0

`pnpm.overrides` forces `fastify` to `^5.12.5`.

**Why:** `apps/api` declares `fastify@^5.12.5` directly, but `@nestjs/platform-fastify@11.2.8` keeps its own nested `fastify@5.11.3`, and the audit attributes four high advisories to that copy (header validation bypasses, all fixed in `<5.12.2`). An override is the only way to move a copy the parent package pins itself.

## 0014 — UUID primary keys and UTC `timestamptz` everywhere

**Status:** accepted · **Phase:** 1

Every table added from phase 1 on uses `uuid` primary keys defaulting to `gen_random_uuid()`, and every timestamp is `timestamptz` written in UTC. Business dates (the daily login bonus) are computed in Asia/Kolkata and stored as a `date`.

**Why:** sequential integer ids leak volume and invite enumeration; UUIDs can be generated before insert, which keeps multi-statement writes simple. UTC storage plus an explicit business-date column means "first login of the day" is a property of the database, not of whichever server answered the request.

## 0015 — Identity fields are normalised by the database, not by callers

**Status:** accepted · **Phase:** 1

A `BEFORE INSERT OR UPDATE` trigger sets `users.email` to `lower(btrim(...))` and rewrites `users.mobile` to digits with a leading `91` or `0` stripped. Uniqueness is then a plain unique index on the normalised column, and the mobile column is additionally constrained to exactly ten digits.

**Why:** every caller (API, seed, future import) would otherwise have to remember to normalise first, and one forgotten path silently creates a duplicate account. Putting it in the database means "unique case-insensitively" and "unique after normalisation" are properties of the data that a test can prove by attempting the duplicate and watching it fail.

**Trade-off:** a trigger is invisible in the ORM's model, so it is documented in `docs/data-model.md` and proven by `apps/api/test/identity.test.ts`.

## 0016 — The audit log is append-only by trigger *and* by revoked privileges

**Status:** accepted · **Phase:** 1

`audit_logs` has a `BEFORE UPDATE`, a `BEFORE DELETE` and a `BEFORE TRUNCATE` trigger that raise, and a non-login role `abhyas_app` that is granted `SELECT` and `INSERT` and has `UPDATE`, `DELETE` and `TRUNCATE` revoked.

**Why:** a trigger protects against application bugs, including a superuser's mistake; revoked privileges protect against a future application role being over-granted and quietly rewriting history. Both are tested: the trigger path as the owner, the privilege path with `SET ROLE abhyas_app`. The role is created idempotently inside the migration so a fresh database and an existing one converge.

## 0017 — Settings store their type and their bounds in the row

**Status:** accepted · **Phase:** 1

`settings` carries `value_type` (`string` | `integer` | `boolean`), typed value columns, and optional `min_int`/`max_int`. One CHECK constraint requires the value to match its declared type, keeps unused columns null, and rejects an integer outside its bounds or a blank/over-long string.

**Why:** the coin rules are settings (signup bonus, daily bonus, per-attempt cost), and "the admin can edit the attempt cost" must not become "the platform can be configured into an invalid state". Bounds live next to the value they bound so the API can read them back and the database refuses a bad write regardless of the code path.

## 0018 — Role→permission mapping is designed now, implemented in phase 2

**Status:** accepted · **Phase:** 1

`docs/data-model.md` designs `role_permissions`, but phase 1 ships only the permission catalog and per-user overrides; the join table arrives with the enforcement layer in phase 2.

**Why:** the phase brief fixes the phase 1 table set. Shipping a join table that no guard reads would be untested surface area; the matrix in `docs/permissions.md` is the contract that phase 2 implements.

## 0019 — The admin seed has no default password and refuses production without explicit opt-in

**Status:** accepted · **Phase:** 1

`apps/api/src/seed/cli.ts` (invoked as `pnpm db:seed:admin`) requires `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`, rejects passwords shorter than 12 characters, well-known defaults and passwords equal to the email local part, and in production additionally requires `SEED_ADMIN_CONFIRM=create-first-admin`.

**Why:** a seed with a default password is how "temporary" admin accounts become permanent back doors. Requiring the confirmation flag in production means the seeder cannot create an admin by accident there, while development still works with two obvious variables. The run is idempotent: it does nothing if any admin already exists, and it writes an `IDENTITY_ADMIN_SEEDED` audit row when it does create one.

## 0020 — Database test files run sequentially

**Status:** accepted · **Phase:** 1

The `test:db` script passes `--no-file-parallelism` to Vitest.

**Why:** each database test creates its own schema and applies migrations to it, and the phase 1 migration creates the `abhyas_app` role idempotently. Two of those transactions racing on `CREATE ROLE` would occasionally fail for a reason unrelated to the code under test. Serialising the database suite removes that flake without slowing the unit suite, which keeps its parallelism.

---

## Dependency reasons

Added with the phase that introduced them; a dependency without a line here is a review failure.

**Runtime**

- `next`, `react`, `react-dom` — the web app (Next.js App Router, the fixed stack).
- `tailwindcss`, `postcss`, `autoprefixer` — Tailwind v3 with the standard PostCSS pipeline; v4 would require a different config surface for no gain in phase 0.
- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify` — the API framework on the fixed Fastify adapter.
- `@nestjs/swagger` — generates the OpenAPI document served at `/api/docs` from the same decorators as the routes, so the document cannot drift from the code.
- `fastify` — declared explicitly rather than relied on transitively, so `FastifyReply` types resolve under pnpm's strict node_modules layout.
- `@fastify/static` — Swagger serves its UI from here when the adapter is Fastify; without it the API refuses to boot with `The "@fastify/static" package is missing`.
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
