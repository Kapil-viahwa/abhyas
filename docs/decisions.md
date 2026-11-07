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

## 0015 — UUID primary keys and UTC `timestamptz` everywhere

**Status:** accepted · **Phase:** 1

Every table added from phase 1 on uses `uuid` primary keys defaulting to `gen_random_uuid()`, and every timestamp is `timestamptz` written in UTC. Business dates (the daily login bonus) are computed in Asia/Kolkata and stored as a `date`.

**Why:** sequential integer ids leak volume and invite enumeration; UUIDs can be generated before insert, which keeps multi-statement writes simple. UTC storage plus an explicit business-date column means "first login of the day" is a property of the database, not of whichever server answered the request.

## 0016 — Identity fields are normalised by the database, not by callers

**Status:** accepted · **Phase:** 1

A `BEFORE INSERT OR UPDATE` trigger sets `users.email` to `lower(btrim(...))` and rewrites `users.mobile` to digits with a leading `91` or `0` stripped. Uniqueness is then a plain unique index on the normalised column, and the mobile column is additionally constrained to exactly ten digits.

**Why:** every caller (API, seed, future import) would otherwise have to remember to normalise first, and one forgotten path silently creates a duplicate account. Putting it in the database means "unique case-insensitively" and "unique after normalisation" are properties of the data that a test can prove by attempting the duplicate and watching it fail.

**Trade-off:** a trigger is invisible in the ORM's model, so it is documented in `docs/data-model.md` and proven by `apps/api/test/identity.test.ts`.

## 0017 — The audit log is append-only by trigger *and* by revoked privileges

**Status:** accepted · **Phase:** 1

`audit_logs` has a `BEFORE UPDATE`, a `BEFORE DELETE` and a `BEFORE TRUNCATE` trigger that raise, and a non-login role `abhyas_app` that is granted `SELECT` and `INSERT` and has `UPDATE`, `DELETE` and `TRUNCATE` revoked.

**Why:** a trigger protects against application bugs, including a superuser's mistake; revoked privileges protect against a future application role being over-granted and quietly rewriting history. Both are tested: the trigger path as the owner, the privilege path with `SET ROLE abhyas_app`. The role is created idempotently inside the migration so a fresh database and an existing one converge.

## 0018 — Settings store their type and their bounds in the row

**Status:** accepted · **Phase:** 1

`settings` carries `value_type` (`string` | `integer` | `boolean`), typed value columns, and optional `min_int`/`max_int`. One CHECK constraint requires the value to match its declared type, keeps unused columns null, and rejects an integer outside its bounds or a blank/over-long string.

**Why:** the coin rules are settings (signup bonus, daily bonus, per-attempt cost), and "the admin can edit the attempt cost" must not become "the platform can be configured into an invalid state". Bounds live next to the value they bound so the API can read them back and the database refuses a bad write regardless of the code path.

## 0019 — Role→permission mapping is designed now, implemented in phase 2

**Status:** accepted · **Phase:** 1

`docs/data-model.md` designs `role_permissions`, but phase 1 ships only the permission catalog and per-user overrides; the join table arrives with the enforcement layer in phase 2.

**Why:** the phase brief fixes the phase 1 table set. Shipping a join table that no guard reads would be untested surface area; the matrix in `docs/permissions.md` is the contract that phase 2 implements.

## 0020 — The admin seed has no default password and refuses production without explicit opt-in

**Status:** accepted · **Phase:** 1

`apps/api/src/seed/cli.ts` (invoked as `pnpm db:seed:admin`) requires `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`, rejects passwords shorter than 12 characters, well-known defaults and passwords equal to the email local part, and in production additionally requires `SEED_ADMIN_CONFIRM=create-first-admin`.

**Why:** a seed with a default password is how "temporary" admin accounts become permanent back doors. Requiring the confirmation flag in production means the seeder cannot create an admin by accident there, while development still works with two obvious variables. The run is idempotent: it does nothing if any admin already exists, and it writes an `IDENTITY_ADMIN_SEEDED` audit row when it does create one.

The account it creates is marked verified in the same transaction. Sign-in refuses an unverified address for everyone else, so a seeded administrator left unverified would be an account the platform created and then would not admit to; holding the deployment's environment is stronger proof of ownership than an emailed link. `seed-admin.test.ts` asserts the role, the hash, the `ACTIVE` status and the verification together.

## 0021 — Database test files run sequentially

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


---

## 0022 — Argon2id through `@node-rs/argon2`, one module for the API and the seed

**Status:** accepted · **Phase:** 2a

`apps/api/src/auth/password.ts` is the only password implementation in the repository: the API's
auth service and the admin seed both import it. It uses `@node-rs/argon2` (Argon2id, 19 MiB, 2
iterations, 1 lane, 32-byte output) and replaces the scrypt helper the phase 1 seed used.

**Why Argon2id:** it is the current OWASP first choice for password storage and the parameters are
encoded in the hash, so raising cost later does not invalidate existing hashes.

**Why `@node-rs/argon2` rather than `argon2` or `node:crypto.scrypt`:** `argon2` is a node-gyp
package and needs a compiler and Python in every image; the Rust implementation ships prebuilt
binaries for the platforms this project builds on (linux-x64-gnu, darwin-arm64), so the Docker build
and CI need no toolchain. scrypt is acceptable but weaker against GPU attack for the same cost, and
the phase 1 seed already had to hand-roll its parameter encoding.

## 0023 — Two database roles: owner for migrations, `abhyas_app` for the API

**Status:** accepted · **Phase:** 2a

Migrations run as the owner role (`MIGRATION_DATABASE_URL`). The API, the worker and the tests that
assert runtime privileges connect as `abhyas_app` (`DATABASE_URL`), which owns nothing and is not a
superuser. Each migration grants the application role what it needs and revokes what it must never
have — `UPDATE`, `DELETE` and `TRUNCATE` on `audit_logs`.

**Why:** a superuser connection turns any SQL injection into total control, including the ability to
rewrite the audit trail that is supposed to be tamper-proof. Separate roles make the append-only
guarantee a privilege boundary rather than a convention, and `auth-foundation.test.ts` proves both
halves: `pg_roles.rolsuper` is false for `abhyas_app`, and UPDATE/DELETE on `audit_logs` raise
permission denied while INSERT succeeds.

**Consequence:** `docker/postgres-init/01-app-role.sql` provisions the role for development and CI.
Production creates the role out of band with its own secret (see `docs/deployment.md`), and
`docker compose config` refuses to render without `MIGRATION_DATABASE_URL`, so the two connections
cannot silently collapse into one.

## 0024 — A lockfile bootstrap that exists only while a dependency changes

**Status:** superseded by 0025 · **Phase:** 2a (temporary)

Adding a dependency changes `pnpm-lock.yaml`, which can only be regenerated by a package manager.
While a branch adds one and no tool can run here, `.github/workflows/lockfile-bootstrap.yml`
regenerates the lockfile on push to that branch and commits it, and is deleted again in the same
pull request once the lockfile is committed.

**Why this is acceptable:** the alternative is `--no-frozen-lockfile` in CI, which is exactly the
guarantee the working rules forbid weakening. The workflow is the only one granted `contents: write`,
it is scoped to one branch, and its lifetime is one commit.


## 0025 — A permanent, manual, non-main lockfile sync workflow

**Status:** accepted · **Phase:** 2a · supersedes 0024

`.github/workflows/lockfile-sync.yml` replaces the throwaway bootstrap. It runs only on
`workflow_dispatch`, its job refuses to run on `main`, it holds `contents: write` on that job alone
(the workflow default stays read-only), and it commits `pnpm-lock.yaml` and nothing else to the
branch it was dispatched for.

**Why:** a dependency change needs a lockfile change, and a lockfile can only be regenerated by a
package manager. The alternative — `--no-frozen-lockfile` in CI — removes the guarantee that CI
builds exactly the tree that was reviewed. Keeping it manual and off `main` means no dependency can
drift into the release branch without a reviewable commit.


## 0026 — Opaque access tokens, not JWTs

**Status:** accepted · **Phase:** 2a

An access token is 32 random bytes, returned once, stored only as a SHA-256 hash in
`sessions.access_token_hash`, and valid for 15 minutes. The guard looks the hash up on every
request and rejects the token as soon as the session row is revoked, rotated or expired.

**Why not a JWT:** a signed token is valid until it expires, wherever it is presented. Every rule in
this phase — logout, password change, password reset, deactivation, role change — must kill access
*immediately*, and a stateless token cannot do that without a revocation list, which is a session
lookup with extra steps. A hand-rolled HMAC signer would also be exactly the kind of crypto this
repository should not invent.

**Consequence:** one indexed lookup per request. No permission is cached in a token: role and
permissions come from `role_permissions` plus `user_permissions` on every request, so a revoked role
or a suspended account takes effect on the next call.


## 0027 — Email, bot protection and rate limiting behind interfaces, with no new dependencies

**Status:** accepted · **Phase:** 2a

Three seams, each an interface with an injection token, so no provider SDK enters the API:

- `EMAIL_SENDER` — `ConsoleEmailSender` prints the message to the log (development, test and CI
  only; its constructor throws under `NODE_ENV=production`), and `SmtpEmailSender` refuses to be
  constructed without `SMTP_URL` and fails loudly at send time instead of pretending to deliver.
  `SMTP_URL` is validated by the transport rather than by `validateEnv`: the shared schema's job is
  to refuse development shortcuts, and the transport is the thing that knows what it needs.
- `TURNSTILE_VERIFIER` — production always verifies against Cloudflare's `siteverify` with
  `node:https` and a timeout (no SDK); development and CI use `TestTurnstileVerifier`, which accepts
  only the fixed test token and refuses to be constructed in production. `validateEnv` already
  refuses Cloudflare test secrets in production, so the two gates cannot disagree.
- `RateLimiter` — fixed-window `INCR` + `EXPIRE` on keys built from the client IP and, separately,
  from a SHA-256 of the account identifier, so neither an address nor an email sits in Redis in
  clear text. A key found without a TTL is repaired on the spot, so a crash between `INCR` and
  `EXPIRE` cannot block a key for ever. The store is a three-method interface, so the window logic
  is unit tested against a fake with a controllable clock.

**Why:** a bot-protection or mail SDK is a large dependency for one HTTP call, and the limiter is
forty lines of Redis. Keeping all three behind interfaces means the tests exercise the real seams,
and a provider can be replaced without touching the auth service.

**Consequence:** a production boot with `EMAIL_PROVIDER=smtp` refuses to start without `SMTP_URL`,
but delivery is not implemented yet — `PROGRESS.md` lists SMTP transport as a known gap, and the
sender throws rather than dropping a message silently.

## 0028 — The OpenAPI document is not mounted in production

**Status:** accepted · **Phase:** 2a

`/api/docs` and `/api/docs-json` are mounted only when `NODE_ENV` is not `production`
(`apps/api/src/config/api-docs.ts`). In production both paths are absent, not merely guarded.

**Why:** the document enumerates every route, payload and error shape the API has. A documentation
surface that is only protected by a guard still ships the whole map to anyone who gets past it, and
"disable it in production" is one line that a test can pin. Development and CI keep it, because
`compose-smoke` curls `/api/docs-json` to prove the API serves what it advertises.

**Consequence:** if a future phase needs a machine-readable contract in production, it gets its own
authenticated, admin-only route rather than re-enabling this one.


## 0029 — `WEB_URL` comes from the environment, never from a request header

**Status:** accepted · **Phase:** 2a

The API builds the verification link from `WEB_URL`, read once when the auth service is
constructed. In production the value is required and must be `https`; in development it defaults to
`http://localhost:3000`. The console outbox keeps the last twenty messages in memory as well, so a
development run and the HTTP test can follow the link the mail contained without a mail server and
without a test-only bypass of the real path.

**Why:** the alternative — deriving the base URL from the incoming `Host` or `X-Forwarded-Host`
header — hands an attacker control of the domain in a mail that also carries a bearer token.
Building the link from configuration keeps the token pointed at a host the operator chose. Requiring
`https` in production keeps the token off plaintext links, and requiring the variable at all means a
deployment cannot silently mail `localhost` links to students.

**Consequence:** a production boot without `WEB_URL`, or with an `http` one, fails before the first
request, and `docker-compose.prod.yml` refuses to render without it.


## 0030 — Sign-in throttling that cannot lock the owner out

**Status:** accepted · **Phase:** 2b

Three counters, and none of them is a lock:

1. **Per address and account** (`ratelimit:login:pair:<sha256(email)>:<ip>`): a
   progressive delay of 100 ms, 200 ms, 400 ms, 800 ms after the first failures, and a
   refusal at 10 failures in 15 minutes. Only that address pays; another address for the
   same account is a different key, so a shared office connection cannot be used to lock
   a person out.
2. **Per account** (`ratelimit:login:account:<sha256(email)>`), deliberately higher (5
   in 15 minutes): past it the sign-in must carry a Turnstile token that verifies. The
   answer is the ordinary 401 body plus `challengeRequired: true`, so a client knows to
   ask for the human check.
3. **Per IP**: the existing 20 in 5 minutes, kept only to stop one host spraying many
   accounts. It never touches an account.

**Why:** the phase 2a rule put a hard 429 on the account counter, which is a denial of
service waiting to happen: five wrong guesses from anybody locked the real student out.
The account-wide counter no longer refuses anybody — it asks for a human check, which
the owner can pass and a bot cannot — and the refusal lives on the address + account
pair, where it only affects the address that is guessing. `auth-throttle.test.ts` proves
the abuse case end to end: an attacker is refused on its own address, the owner is
challenged and still signs in.

**Consequence:** the sign-in form always sends a Turnstile token, so the challenge is
satisfied in the normal case; an API client that skips it is asked for one after five
failures. A successful sign-in clears both counters, so a mistyped password followed by
the right one leaves no residue.

## 0031 — Session lifecycle: one place for every revocation reason

**Status:** accepted · **Phase:** 2b

`revokeReason` is a closed set in the database (`sessions_revoke_reason_valid`), and each
way a session can end has its own value: `LOGOUT`, `USER_REVOKED` (the person ended one
of their own sessions from the account page), `ROTATED`, `REUSE_DETECTED`,
`PASSWORD_CHANGED`, `PASSWORD_RESET`, `ACCOUNT_DEACTIVATED`, `ROLE_CHANGED`,
`ADMIN_REVOKED`. The migration adds `USER_REVOKED` and `sessions.last_used_at`, which the
guard stamps on every authenticated request in the same `UPDATE` that validates the
token.

Every write that changes a credential ends the sessions it must inside the transaction
that changes it, and writes both the specific audit row and an `IDENTITY_SESSIONS_REVOKED`
row carrying the reason and the count:

- **change password** keeps the session that asked and ends the others (`PASSWORD_CHANGED`);
- **reset password** ends every session (`PASSWORD_RESET`) and the token is single use, so
  a replayed link is refused;
- **deactivate** needs the password, disables the account and ends every session
  (`ACCOUNT_DEACTIVATED`), and the guard already refuses a non-`ACTIVE` user;
- **role change** (ADMIN only, `roles.write`) ends every session of that user
  (`ROLE_CHANGED`), so no token outlives the permissions it was issued under.

**Why:** a token that survives the event that should have killed it is the whole risk of
staying signed in. Doing the revocation in the same transaction as the change means there
is no window in which the new password and the old session exist together, and the closed
set of reasons makes the audit trail readable instead of a free-text column nobody trusts.


## 0032 — The browser never holds a token: cookies, server-side refresh and a double-submit CSRF check

**Status:** accepted · **Phase:** 2b

The web app never calls the API from the browser and never receives a token as data:

- Every call goes from a Next.js route handler or server component to
  `API_INTERNAL_URL`. The API URL is not exposed, and the API's CORS surface stays closed.
- The two opaque tokens live in httpOnly, `SameSite=Lax`, `Secure`-in-production cookies
  (`abhyas_access`, `abhyas_refresh`). Nothing is stored in `localStorage` or
  `sessionStorage`, and no page renders a token into its HTML.
- An expired access cookie is refreshed silently: a route handler that gets a 401
  exchanges the refresh cookie, sets the new pair on the response it was already
  returning, and retries once; a page that finds no usable access token is sent through
  `/api/auth/refresh-and-return`, which can write cookies before rendering.
- Every write is a form post to a route handler, guarded by an `Origin` check against
  the configured web origin **and** a double-submit value: middleware sets a random,
  httpOnly `abhyas_csrf` cookie (`Secure` in production) and injects the same value as a
  request header, so the first render's form carries a token the browser already holds.
- The API's per-IP limits follow the person: the route handlers forward
  `X-Forwarded-For`, and the API runs with `trustProxy`.

**Why:** a token in JavaScript is a token one XSS away from being stolen, and an
Access-Control-Allow-Origin for a cookie-authenticated API is an invitation to
confused-deputy bugs. Keeping the exchange server-side means the browser only ever holds
opaque cookies that page scripts cannot read, and CSRF is answered by the double submit
rather than by a CORS policy nobody tests.

**Consequence:** the web is a BFF (backend for frontend) and its route handlers are part
of the security surface. The write guard is unit tested (`route-handler.spec.ts` covers a
foreign origin, a missing origin, a missing or wrong form value, a missing cookie and a
non-form body) and the whole path is covered by the Playwright flows. `TURNSTILE_SITE_KEY`
is required in production and refuses Cloudflare test keys, and in development/CI the
widget is rendered with the test key while the form carries the token the API's test
verifier accepts, so the flow does not depend on Cloudflare being reachable from a CI
runner.

**CSP note:** the policy allows `'unsafe-inline'` for scripts because Next's bootstrap is
inline; moving to a nonce-based policy belongs with the edge proxy work in the hardening
phase and is listed as a known gap.


## 0033 — Editor capability is a grant, not a role

**Status:** accepted · **Phase:** 3

An editor's ability to write is not part of the `EDITOR` role any more. The role carries
the read side (`content.read`, `tests.read`); the three write codes — `content.write`,
`tests.write`, `tests.publish` — are granted one row at a time in `user_permissions`, one
per ticked flag, by the Administrator who creates or edits the editor. A flag that was not
ticked grants nothing.

**Why:** "editor" is a job title, not a capability. The phase 1 matrix gave every editor
the whole content surface, and the product needs an editor who may draft questions but not
publish a test. Making the grant explicit also means the audit trail says exactly who was
given what, instead of a role code standing in for a decision nobody recorded.

**Consequence:** two triggers keep the model from drifting. `user_permissions_editor_flags_only`
refuses any of the three codes on an account that is not an `EDITOR`, so a student cannot be
handed write capability by mistake; `users_clear_editor_flags` deletes them when an editor is
demoted, so a demotion cannot leave a stale grant behind. Changing an editor's flags ends that
editor's sessions in the same transaction. The phase 1 matrix test was updated to the new
truth and the old expectation is replaced by stronger per-account assertions in
`user-management.test.ts`.

## 0034 — Content ownership is stored on the row that matters

**Status:** accepted · **Phase:** 3

Categories and exams record `created_by`. Subjects and topics do too, for the trail, but the
ownership rule reads the *exam*: a subject or topic belongs to whoever created its exam. The
catalog service checks that on every write, and an Administrator is exempt.

**Why:** an editor's boundary is "what I made". Writing it down on the exam means creating a
subject underneath somebody else's exam is refused for the same reason editing the exam is —
there is no second code path to keep in step. Deriving it from a parent rather than copying it
also means a transfer of an exam would move its whole subtree in one update.

**Consequence:** the API exposes no way to change `created_by`. `catalog.test.ts` proves the
negative cases explicitly: a foreign exam cannot be updated, deleted, or have a subject created
under it, and the same for a foreign subject's topics.

## 0035 — Settings carry their bounds, and related settings are validated together

**Status:** accepted · **Phase:** 3

Every setting row already carried its type and its integer bounds (decision 0017). The phase 3
settings keep that and add one thing a `CHECK` cannot express alone: the three topic band values
(`topic_band_weak_below` ≤ `topic_band_average_below` ≤ `topic_band_good_below`) are validated
by a trigger that reads all three rows together, with the incoming row standing in for itself.

**Why:** a scale whose bands are out of order is never a valid configuration, and an API check
alone would be one `psql` session away from being bypassed. The trigger means the invariant is a
property of the data.

**Consequence:** the settings screen shows each value's bounds beside the field, and saving a
value outside them is a 400 with the API's message. Every change is audited with the old and new
value.

## 0036 — The public catalog is cached under one tag and dropped by a secret-protected route

**Status:** accepted · **Phase:** 3

The public `/exams` pages are server-rendered and cached. The catalog fetch is cached under the
`catalog` tag, and after every catalog write the API POSTs to the web tier's `/api/revalidate`
with the shared `REVALIDATE_SECRET` from the environment; the web tier compares it and calls
`revalidateTag('catalog')`. A missing or short secret is refused at boot in production.

**Why:** the alternative is a cache that is either always cold (a database query on every public
page view) or stale until a TTL expires (an editor publishes an exam and nobody sees it). A tag
gives exactly the second half of that: cached until the thing it depends on changes.

**Consequence:** the secret is a second shared secret between the two tiers, required in
`docker-compose.prod.yml` and in the web's production configuration. A revalidation failure is
logged and swallowed: the write has already committed, and the page is stale for at most one
revalidation window rather than the API reporting a failure for a change it made.

## 0037 — The audit viewer is read-only by construction and its export is audited

**Status:** accepted · **Phase** 3

`GET /v1/admin/audit` filters by actor, action and date range and pages the result;
`GET /v1/admin/audit/export` returns the same rows as CSV. Neither has a counterpart: there is no
update and no delete route, the table's trigger raises for `UPDATE`, `DELETE` and `TRUNCATE`, and
the application role has those privileges revoked. The export writes an `AUDIT_EXPORTED` row.

**Why:** a viewer is only as trustworthy as the absence of a write path behind it, and taking a
copy of the trail is itself something an administrator did — exactly the kind of act the trail
exists to record.

**Consequence:** the export is capped at 5,000 rows so one request cannot become a database dump,
and the CSV is generated from the same filter function the viewer uses, so what is exported is
what was on screen.


## 0038 — A private S3-compatible bucket, and an upload pipeline that decides for itself

**Status:** accepted · **Phase:** 4

Storage is S3 behind `ObjectStorage` (`apps/api/src/infra/object-storage.ts`), and the
bucket is private in every environment. Development and CI run MinIO (`minio/minio`
`RELEASE.2024-05-10T01-41-38Z`) and the API creates the bucket at boot there; production
points at an external service and creates nothing. `validateEnv` refuses, in production,
an empty endpoint, a non-`https` endpoint, the in-memory store, development credentials,
and a public-bucket flag (which is refused in every environment).

Every image goes through `apps/api/src/media/image.ts`:

- the type is decided by **magic bytes**, never the extension or the declared content
  type, so a renamed executable or an SVG is not an image;
- the file is decoded with `sharp` (pixel-count limit), rotated, resized to a 2000px
  longest edge, and **re-encoded as WebP**, which strips EXIF and drops anything appended
  to the original container — that is what defuses a polyglot;
- the key is generated (`question-image/<uuid>.webp`) and the database CHECK refuses any
  other shape, so a user-supplied name can never reach the store;
- reads are presigned URLs that live five minutes, and only the uploader or an
  administrator can ask for one.

**Dependencies (exact versions):**

- `@aws-sdk/client-s3` 3.699.0 — the S3 protocol client.
- `@aws-sdk/s3-request-presigner` 3.699.0 — signed GET URLs; part of the same SDK line,
  so a single version must not drift.
- `sharp` 0.33.5 — decoding and re-encoding. It is the only maintained image library that
  gives a pixel-count limit and a metadata-stripping re-encode without a shell-out.

**Why:** a public bucket makes presigned URLs pointless, and deciding the type from the
name is the oldest upload bug there is. Re-encoding rather than trusting the bytes means
the store only ever holds a WebP the pipeline produced.

**Consequence:** `S3_ENDPOINT=memory:` exists for the database test job, which has no
object store. It is named like a protocol so it cannot be mistaken for a host, and
production refuses it.

## 0039 — Questions: a working version, an immutable published version, and server-side sanitising

**Status:** accepted · **Phase:** 4

A `questions` row points at the catalog (exam, subject, optional topic) and owns a
`current_version`. Text lives in `question_versions`: an HTML subset sanitised on the
server, an explanation, an optional LaTeX string rendered separately with KaTeX, marks and
negative marks, language (`EN`/`HI`), difficulty, and the type. `question_options` rows
hang off a version.

Rules the database keeps, not the handler:

- a version that has `published_at` cannot be updated or deleted (trigger), and neither
  can its options;
- a deferred constraint trigger checks the answer key at commit: an `MCQ` has two to six
  options and exactly one correct one, a `NUMERICAL` has none and a numeric
  `numerical_answer` matching `^-?[0-9]+(\.[0-9]{1,6})?$`;
- a question's subject must belong to its exam and its topic to its subject (trigger);
- editing a published question creates a new draft version, so history is never rewritten.

Rich text arrives as TipTap's HTML and is sanitised with an allowlist (`sanitize-html`),
never trusted. LaTeX is rendered with `katex` with `trust: false` and `strict: 'ignore'`
on the render options, so `\href` and raw HTML cannot pass through.

**Dependencies (exact versions):**

- `sanitize-html` 2.13.1 (+ `@types/sanitize-html` 2.13.0) — the allowlist sanitiser.
- `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm` 2.10.3 — the editor. TipTap is in
  the fixed stack from phase 0.
- `katex` 0.16.11 (+ `@types/katex` 0.16.7) — mathematical rendering, also named in the
  fixed stack.

**Why:** a rich-text editor that is trusted by the backend is an XSS engine with a
database. Storing the sanitised HTML next to the numeric answer means a student preview
and a printed paper see the same markup, and versioning means a published paper cannot
change under a student who already sat it.

## 0040 — Bulk import: a worker job, a staging table, and an all-or-nothing commit

**Status:** accepted · **Phase:** 4

An editor uploads a CSV or XLSX (and optionally a ZIP of images). The API stores the file
in the private bucket and queues a job; the worker parses it, validates every row into
`import_rows`, and never writes a question until the commit. A job with any invalid row is
`REJECTED` and commits nothing. The commit writes drafts only, inside one transaction, and
records `import_commits` first, so a worker that restarts finds the row and stops instead
of importing twice.

ZIP handling rejects, before reading any entry: more than 500 entries, more than 100 MB of
uncompressed data, a compression ratio above 100:1, `../` or absolute paths, and symlinks.
Each image entry then goes through the same `processImage` pipeline as a direct upload.

**Dependencies (exact versions):**

- `exceljs` 4.4.0 — reads XLSX and writes the template and the error report. It is used
  by the API and the worker, so the template and the parser cannot disagree.
- `yauzl` 3.2.0 (+ `@types/yauzl` 2.10.3) — streaming ZIP reading with entry metadata,
  which is what makes the caps above enforceable before extracting anything.

**Why:** a bulk import that half-succeeds leaves an editor with no idea which rows landed,
and parsing a customer-supplied archive is the classic path to a zip bomb or a path
traversal. Staging plus one transaction makes the answer to "what did this file do?"
exactly one row in `import_jobs`.

**Consequence:** the worker now owns a Prisma client and the same object-storage client as
the API, and it generates the client from the API's schema so the two can never drift.


## 0041 — Adobe S3Mock is the development and CI object store, pinned by tag and digest

**Status:** accepted · **Phase:** 4

Development and CI run `adobe/s3mock` at `5.2.3`, pinned again by its manifest-list
digest (`sha256:ab01a6946750f451ca215a47e91030695b260e4003b8a5a6201d25029b8fca92`), on
port 9090. It implements the S3 API the application uses — `CreateBucket`, `HeadBucket`,
`PutObject`, `GetObject`, `DeleteObject`, `GetBucketLocation` and path-style addressing —
and it accepts presigned URLs. The application still creates its own private bucket at
boot, so the server starts empty.

**Why this server:** MinIO's own images are not pullable anonymously from CI any more.
`minio/minio` does not exist on Docker Hub, `quay.io/minio/minio` answers "unauthorized"
without a login, and `bitnami/minio` publishes no tags at all (its Docker Hub tag list is
empty). S3Mock is maintained by Adobe, ships a dateable release line, and its documented
limitations are exactly the ones we do not rely on: it accepts presigned URLs without
validating the signature (the API still signs and expires them, and only ever hands them
to the person who uploaded the image), and it is path-style only (the application is
configured with `S3_FORCE_PATH_STYLE=true`).

**Consequence:** this image is a development and CI convenience and must never be
deployed. Production requires an external S3-compatible service over https with its own
credentials; `validateEnv` refuses an empty endpoint, a non-https endpoint, the in-memory
store, the development credentials and a public bucket, and `docker-compose.prod.yml`
requires every `S3_*` variable by name. `PROGRESS.md` records the substitution as a known
gap.

## 0042 — The `fast-xml-parser` override is temporary and must be removed

**Status:** accepted · **Phase:** 4

`@aws-sdk/client-s3` 3.699.0 depends on `fast-xml-parser` 4.4.1 through `@aws-sdk/core`,
which carries four advisories at the time of writing (GHSA-m7jm-9gc2-mpf2, critical;
GHSA-jmr7-xgp7-cmfj, GHSA-8gc5-j5rx-235r and GHSA-fj3w-jwp-x2g3). The audit gate is not
lowered and no exception is added: `package.json` pins the transitive package to `4.5.5`,
which is the version the advisories name as fixed, and the production audit passes.

**Why an override and not a newer SDK:** the SDK line that depends on a fixed
`fast-xml-parser` is newer than the two-week window the dependency rules require, and the
SDK is only used for the S3 protocol. Pinning the one package keeps the SDK on a version
whose behaviour has been running in CI for a while.

**Consequence:** remove the `fast-xml-parser` override as soon as `@aws-sdk/client-s3`
reaches a release that depends on `fast-xml-parser` >= 4.5.5 on its own. The override is
listed with its reason in `package.json`'s `pnpm.overrides` block.

## 0043 — `sharp` 0.35.5, and every dependency inside the two-week window

**Status:** accepted · **Phase:** 4

`sharp` was raised from 0.33.5 to 0.35.5 because three high advisories
(GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w) are fixed only at
0.35.5. The 0.35.5 release is older than the two-week window at the time this was applied,
so it satisfies both rules at once; the smaller bumps that were not old enough were not
taken. Every other new dependency is pinned to an exact version that was published at
least two weeks before it was added, and the audit gate is unchanged.

## 0044 — Signed URLs live five minutes, and an exam student sees only their own snapshot's images

**Status:** accepted · **Phase:** 4 (with a rule for phases 6 and 7)

A question image is stored in a private bucket. The only way to read it is a presigned
`GET` whose key was generated by the server (`question-image/<uuid>.webp`), whose life is
`PRESIGNED_URL_TTL_SECONDS` (300 seconds), and which is issued only after the caller has
been authorised for that asset. Nothing else in the platform can produce a permanent
address to an object, and the upload response never carries image bytes.

**Why five minutes:** an author previews an image seconds after uploading it, and a
student sees one for the length of a question. Five minutes is long enough for both and
short enough that a URL copied out of a page stops working before it can be shared
usefully.

**Phases 6 and 7 (exams):** during an active attempt, a student may receive a signed URL
only for an image belonging to a question in their own attempt snapshot — the questions
frozen for that attempt — and not for any other asset, including images of questions they
have not reached yet or questions from another paper. The exam module therefore asks for a
URL per asset through an attempt-scoped check; `MediaService.signedUrl`'s uploader check
remains for authoring and is not sufficient on its own for an exam. Answer keys stay
outside that check: an image URL proves nothing about the correct option, but the
snapshot rule keeps one student's paper from revealing another's.

**Known limitation of the development store:** `adobe/s3mock` (decision 0041) accepts a
presigned URL without validating its signature or its expiry, so CI proves the URL is
signed and expired correctly (a unit test reads `X-Amz-Expires`, `X-Amz-Signature` and
`X-Amz-Credential` out of the generated URL) but does not prove the store rejects a
tampered or expired one. **Phase 9 carries a launch-blocking integration test** against the
real production S3-compatible service: a URL with an edited signature, an expired URL and
a URL for a key that does not exist must each be refused. `PROGRESS.md` records this as a
known gap.



## 0045 — Decoding a question image is bounded by pixels, threads and a body limit

**Status:** accepted · **Phase:** 4

Three limits decide how much memory one upload may cost, and they are chosen for the
smallest box the platform is meant to run on (a two-core VPS with 2 GB of memory), not for
the machine it was written on.

**Pixels.** `MAX_INPUT_PIXELS` is 16,000,000. libvips decodes to four bytes per pixel
(RGBA) before it resizes, so one decode peaks at about 64 MB: 16e6 × 4 bytes. A file that
declares more is refused by `limitInputPixels` before any of it is decoded, which is what
makes a decompression bomb cheap to reject — an 8000 × 8000 PNG of a few kilobytes is
64 megapixels and never allocates them.

**Threads and cache.** `sharp.cache(false)` drops libvips' operation cache, which otherwise
keeps decoded tiles alive after the request that needed them — memory held by history
rather than by work. `sharp.concurrency(1)` stops one decode from fanning out over every
core, so two decodes use two threads and that is the ceiling. `MAX_CONCURRENT_DECODES` is
2, matching the two cores: two decodes ≤ 2 × 64 MB = 128 MB of pixel data, plus the stored
WebP (≤ 5 MB each) and the Node heap. Everything else in the API is single-threaded
JavaScript and does not compete for that memory.

**A slot belongs to the decode, not to the caller.** The limiter's slot is taken around the
native work; the ten-second timeout only stops the caller from waiting. An abandoned decode
keeps its slot until libvips actually finishes, so a slow decode cannot be abandoned into
starting a third one beside it — the bound is on real memory, not on requests in flight.

**The body limit.** Every route keeps the Fastify adapter's 1 MB `bodyLimit`. The upload
route carries a base64 image, which is 4/3 of the file plus the JSON envelope, so it gets
the single per-route exception: `ceil(5 MB × 4 / 3) + 8 KB` (about 6.99 MB), applied
through Fastify's `onRoute` hook before routes are registered. Fastify stops reading at the
limit and answers 413, so an oversized upload is refused without being buffered; a body
between 5 MB and 6.99 MB is refused by the parser with the image-size message. The hook is
attached in `main.ts` and in the HTTP test, so the test exercises the same limit the server
runs with.

**Stored images and the browser.** `PutObject` always writes `ContentType: image/webp` and a
private, short cache rule; the presigned `GET` asks the store to answer with
`response-content-type=image/webp` and `response-cache-control=private, max-age=300`, so a
proxy cannot decide either. A signed URL is the only way in, and the object is never public.

**CSP.** The web app loads question images from the storage origin, so that exact origin —
validated as an origin with no path and no credentials — joins `img-src` through
`MEDIA_ORIGIN`. It is added to `img-src` and to nothing else; `script-src`, `connect-src`,
`frame-src` and the rest are byte-identical to the policy without it, and that is what the
header test asserts.

**Animated containers are refused, not flattened.** An animated PNG declares an `acTL`
chunk and an animated WebP declares `ANIM`/`ANMF`; both are refused before the decoder runs,
and `metadata.pages > 1` refuses anything else that still declares more than one frame. A
question image is one still picture, and a container that describes more is not one.


## 0046 — Authored content is a fixed point of one allowlist, and an image is a reference

**Status:** accepted · **Phase:** 4

One function in `apps/api/src/questions/sanitize.ts` decides what authored content is, and
it runs on three occasions: on save, on every later save, and again when the row is read
back, so a version written under older rules can never reach a student unsanitised.

**The allowlist.** Paragraphs, line breaks, emphasis, lists, sub/superscript, code and a
blockquote. No links — a question has no use for one, and a link is the easiest way to
smuggle a scheme — and no `style`, `class`, `id` or `on*` attribute anywhere: only `img`
carries attributes at all, and only `data-media-id` and `alt`. The containers whose content
is not prose (`script`, `style`, `textarea`, `option`, `noscript`, `iframe`, `object`,
`embed`, `svg`, `math`, `template`, `form`) are dropped whole rather than unwrapped, because
their text is the payload: the classic `<math><mtext><table><mglyph><style><img onerror…>`
needs the namespace to be discarded, not read.

**An image is a reference.** Content names an upload by its `media_assets` id and nothing
else; an `img` without one, or with a URL where one belongs, is removed, and a second pass
over the cleaned markup removes anything the parser left behind. On save the service checks
every referenced id: it must exist, be a WebP and be the caller's own upload (an
Administrator may use any). A foreign id and an invented one are refused with the same
words, so the route cannot be used to discover which images exist.

**A fixed point.** `sanitize(sanitize(x))` must equal `sanitize(x)`, and the save refuses a
value that moves on the second pass. A sanitiser whose output is not its own input cannot be
reasoned about; the tests hold every payload to it.

**Characters.** Text is composed to NFC, and C0 controls (except tab, newline and carriage
return), null bytes, bidirectional overrides and isolates are removed. A bidi override
renders one string and reads as another, which has no place in a question a student answers.
Depth is bounded at 50 tags: 20,000 nested tags would be flattened by the parser only after
it had built the tree, so the raw string is measured first and refused.

**Search text.** `plainText` strips tags and then decodes entities, so a question authored
as `a &lt; b` or `R&amp;D` is found by searching for what the author typed.

**LaTeX.** KaTeX renders with `trust: false`, `strict: 'error'`, `throwOnError: false`,
`maxSize: 50` and `maxExpand: 1000`. `\href`, `\url`, `\includegraphics` and `\htmlClass` are
not in its command list and cannot produce a link, an image or a class attribute with trust
disabled; the renderer shows the expression as escaped text, and a hard failure is escaped
by the renderer itself before it reaches the page.


## 0046 — Animation is decided by the chunk list, and the sanitiser strips what cannot be read

**Status:** accepted · **Phase:** 4

**Chunks, not bytes.** The first version of the animation guard searched the file for the
four bytes `acTL` (PNG) and `ANIM`/`ANMF` (WebP). That is wrong in both directions: a text
chunk or a caption that merely mentions `acTL` was refused, and a real animation whose
chunk type was split across the search window could pass. Both formats are chunk lists, so
the guard now walks them: for a PNG it reads each chunk header from the signature and
refuses the file when an `acTL` chunk appears before the first `IDAT`; for a WebP it walks
the RIFF chunks and refuses `ANIM` or `ANMF`. The tests keep a PNG carrying `acTL` inside a
text chunk and a WebP carrying `ANIMANMF` inside a metadata chunk, and both are accepted.

**Invisible characters.** `normalizeText` removes C0 controls (except tab, line feed and
carriage return), DEL, C1 controls (U+0080–U+009F), Unicode tag characters
(U+E0000–U+E007F), the zero-width space, the word joiner and the byte-order mark, after
composing to NFC. It deliberately keeps the zero-width joiner (U+200C) and non-joiner
(U+200D): Devanagari conjuncts are written with them, so removing them would silently
change the Hindi an author typed, and there is a test with conjuncts that would break.

**Metadata containers.** `xmp`, `noembed`, `noframes`, `title` and `head` join the list of
tags whose *content* is dropped, not just the tag: their text is an instruction to a
browser that parses it later, so keeping it as prose is the bug.

**List screens show text.** `plainText` is documented as the string a list screen may show,
never as HTML, and the web side has one `questionPreview` that strips markup and decodes
entities to a plain string rendered in a text node. The test feeds it
`<img src=x onerror=alert(1)>` and asserts the result carries no tag at all.


## 0047 — The repository is public temporarily, and carries no real secret

**Status:** accepted · **Phase:** 4

The repository is **public for now**, because GitHub Actions for a private repository were
blocked on billing and public repositories get free runners. That is a temporary arrangement,
not the intended state.

- **Make it private again before any real user data, production secret or live customer
  exists.** Nothing in the history can be unpublished: once something is pushed to a public
  repository it must be treated as published for ever, and removing it from the latest commit
  does not remove it from earlier ones.
- **Production secrets never live in this repository.** They are set as GitHub encrypted
  secrets (CI) and in the server environment (deployment), read by name through
  `docker-compose.prod.yml`'s `${VAR:?}` requirements. `.env.example` holds development
  placeholders only, and `validateEnv` refuses the development values in production.
- **What the working tree and history were checked for** when the repository became public:
  real passwords, tokens, API keys, private keys, real addresses or phone numbers, server IPs
  and hostnames, and personal data. The findings were the expected ones — documented
  development placeholders in `.env.example`, throwaway `example.com` accounts and obvious
  test passwords in the browser suite, and the repository owner's handle in `PROGRESS.md`
  proof links — and no real credential. The `gitleaks` job scans the full history on every
  push, so an accidental commit is caught as it arrives rather than later.
- **Repository settings that matter more now than they did in private**: fork pull requests
  require approval before workflows run, secret scanning with push protection is on, and
  Dependabot alerts and security updates are enabled. Those are toggles in the repository's
  own settings, not files, so they are recorded here rather than enforced by CI.


## 0048 — Mobile OTP is off by default and the switch is enforced on the server

**Status:** accepted · **Phase:** 2c

**One switch, checked at three layers.** `OTP_ENABLED` (default false) is read from the
validated environment at boot and is the only thing that turns the feature on. With it off:
`providerFromEnv` returns `null` before it constructs anything at all, `OtpService.assertEnabled`
throws `NotFoundException` before it reads a row or a counter, and `OtpGuard` answers **404**
(not 403) on the routes. Hiding the web screens is the fourth layer, never the first. Tests
prove the disabled mode from the service with a provider wired in on purpose: 404, and nothing
in the outbox.

**Codes are stored as an HMAC, bound to their destination.** `code_hmac` is
`HMAC-SHA256(OTP_HMAC_SECRET, "<e164>:<code>")`, so the same six digits sent to two numbers
produce different digests and a database read cannot recover a live code. Verification compares
in constant time with `timingSafeEqual` and, for an unknown number, spends a comparison anyway
so the two answers are not measurably different. The code itself appears in exactly one place:
the body handed to the provider, which the fake provider keeps in its development-only outbox.

**Five attempts, five minutes, escalating resends.** A row is spent (`consumed_at`) when it is
verified, when the fifth guess is wrong, when it expires, or when delivery fails — a code that
was never delivered must never verify. The resend cooldown starts at 30 seconds and doubles to
ten minutes, indexed by how many requests already exist for that number in the last hour.

**Limits, and the budget as a hard stop.** Per number 3/hour and 8/day, per IP 10/hour, per
device 5/hour, all on the existing Redis fixed-window limiter. Above them sits a daily SMS
budget: the count is `sms_cost_ledger` rows for the current business day (Asia/Kolkata), and
when it is reached a Redis latch closes the breaker for the rest of the day, one alert row is
written, and every further request answers 503 without another provider call. The ledger also
records what each message was sent by and, when the vendor returns one, its message id.

**Anomaly detection, and what it honestly covers.** A limit denial from one address, and a
number whose digits run sequentially, each write an `OTP_ALERT` audit row and increment a
per-action, per-day counter in Redis that `alertCount()` reads. Network-level (ASN) burst
detection is **not** implemented; it belongs to the WAF in front of the deployment and is
recorded as a known gap rather than pretended.

**The gateway is an SSRF seam, so it is guarded twice.** At boot, the URL must be https in
production and its host may not name a private, loopback, link-local, CGNAT (100.64.0.0/10),
multicast, unspecified or metadata address — including the numeric forms IPv4 accepts
(`127.1`, `0x7f000001`, `2130706433`) and IPv4-mapped IPv6 (`::ffff:127.0.0.1`). At send time
DNS is resolved once, *every* answer is checked, and the address that passed is pinned into
`http(s).request` through its `lookup` option, so a second lookup cannot swap in another host.
Redirects are never followed (a 3xx is a failure), the timeout is bounded per request, and the
response is read with an 8 KiB cap. Development and CI may point the provider at a loopback
mock server; production may not, and `validateEnv` keeps that honest.

**Boot refusal, not configuration advice.** With the switch on in production, `validateEnv`
refuses a fake or console provider, any provider without an adapter (only `http` exists yet), a
missing or short or well-known `OTP_HMAC_SECRET`, a missing `OTP_SENDER_ID`,
`OTP_DLT_ENTITY_ID` or `OTP_TEMPLATE_ID`, and a gateway that is empty, not https, or missing its
body template. The fake provider and the test Turnstile verifier refuse themselves as well, so
the process cannot start in a state where a development shortcut would be reachable.


## 0049 — An account is identified by a verified identifier, and mobile-first accounts hold no usable password

**Status:** accepted · **Phase:** 2c

A student who signs up with a mobile number has no email address, so `users.email` becomes
nullable and a `users_identifier_present` CHECK requires a row to carry an email **or** a
`first_verified_mobile` — never neither. Both identifiers are only ever written after they
have been verified (an email link, or an OTP), so the row cannot claim an identifier nobody
proved.

`users.password_hash` stays `NOT NULL`. A mobile-first account is created with an Argon2id
hash of 32 random bytes the platform generates and never stores in readable form, which makes
password sign-in impossible for it until its owner sets a password through re-authentication.
A nullable hash column was rejected: every password comparison on the platform would then
carry a branch, and a forgotten branch is an authentication bypass.

The consequences are written down rather than discovered later:

- Password sign-in and password reset look the account up **by email**, so a mobile-first
  account simply cannot be found by either. They answer exactly as an unknown address does.
- Every screen, list and export that shows an email shows "No email linked" when it is null.
- A sensitive change proves the holder by password, by a code sent to the account's own
  verified number, or — for an account with no email — by a sign-in from the last fifteen
  minutes (decision 0050).
- A full-text search over the account list matches the name and the email; a mobile-only
  account is found by name.

The unique indexes are the real constraint, not the service: `users_email_key` compares the
lower-cased value the normalising trigger writes, and `users_mobile_key` (plus
`users_first_verified_mobile_key`) makes one phone one account. A test inserts a duplicate in
a different case and proves Postgres refuses it.

## 0050 — Re-authentication: password, then a code, then a sign-in from minutes ago

**Status:** accepted · **Phase:** 2c

Changing a password, deactivating an account, and (in item 3) linking or unlinking an
identifier are all changes to how somebody signs in, so each one has to prove it is still
the holder. `ReauthenticationService.assert` accepts, in this order:

1. **The current password**, whenever one is offered. It is verified for every account that
   has one, whichever way it was created — a mobile-first account that later chose a password
   is asked for it.
2. **A one-time code** sent to the account's own `first_verified_mobile`, purpose `REAUTH`.
   The destination is read from the account, never from the request body, so the route can
   never be used to send a code to a stranger. It is an ordinary OTP row: same HMAC storage,
   five attempts, five minutes, same rate limits and the same 404 with `OTP_ENABLED=false`.
3. **A sign-in from the last fifteen minutes**, and only for an account with **no email
   address**. Such an account has no password anybody could type; a session created minutes
   ago is the same evidence as a password typed a minute ago.

Recent-ness is never accepted for an account with an email address: there the password is
available and asking for it is what stops a stolen session from changing it. That asymmetry is
deliberate and is proven by tests for both kinds of account. A stale session with no proof is
a 403 naming both ways forward, not a generic refusal.


## 0051 — A fixed code only the fake provider may use, so the browser can be tested with OTP on

**Status:** accepted · **Phase:** 2c

The master switch has two halves and the browser suite only proved one: the stack runs with
`OTP_ENABLED=false`, so Playwright can show the screens are hidden and the routes are 404, but it
cannot register, sign in, link or be locked out, because a browser cannot read an SMS.

Two shortcuts were considered and both were rejected:

- **An HTTP route that returns the newest code in development.** It is a way to obtain a live
  code from outside the process, and "development only" is a flag away from being reachable. The
  rule that a code never leaves the server except in the message would have its first exception.
- **Logging the code.** Same objection, plus log retention and log access.

What is accepted is narrower: `OTP_FAKE_FIXED_CODE`. It is a six-digit constant used instead of a
random draw, and it is honoured only when **all** of these hold: `OTP_ENABLED=true`, `NODE_ENV` is
not `production`, and `SMS_PROVIDER=fake`. `validateEnv` refuses it in production, refuses it with
any provider other than `fake`, and refuses anything that is not six digits — a boot failure, not
advice. `fixedCodeFor()` checks the same three conditions again inside the API, so the value is
inert even if somebody bypasses the validator (the fake provider also refuses to be constructed in
production at all).

Nothing else about a code changes. It is still stored only as an HMAC bound to its destination,
still expires in five minutes, still spends after five wrong guesses, still obeys the escalating
resend cooldown and every rate limit. `otp-code.spec.ts` proves the digest, the constants and the
schedule are untouched by a fixed code, and `otp-flow.test.ts` boots an API with one and proves the
cooldown, the attempt limit and the expiry still bite.

`docker-compose.otp.yml` is the override that turns this on for CI and for a developer who wants to
click through the mobile screens: `OTP_ENABLED=true`, the fake provider, the HMAC secret, a
template id and the fixed code. Production never uses it — `docker-compose.prod.yml` is a
standalone file, and `scripts/validate-compose-prod.mjs` fails if that file so much as names the
override or the variable.

The browser coverage stays in the existing `e2e` job: the disabled suite runs first against the
default stack, then the stack is restarted with the override and a second Playwright project drives
mobile registration, mobile sign-in, linking a number from the account page with re-authentication,
the wrong-code lockout, the resend countdown and the identical answer for a number nobody has. No
job was added; the job's timeout was raised from fifteen minutes to twenty with the reason written
beside it.


## 0052 — The client address is the socket address unless a named proxy says otherwise

**Status:** accepted · **Phase:** 2c

Every per-IP counter — OTP requests, registration, sign-in, password reset — is only as good
as the address it counts. Fastify was started with `trustProxy: true`, so any request that
carried an `X-Forwarded-For` chose its own address, and the web tier forwarded whatever the
browser sent. A single client could therefore present a fresh address per attempt and never
meet a cap.

The rule now:

- `TRUST_PROXY` is unset by default, and unset means **the forwarding headers are ignored**
  and the socket address is the client.
- It may name the proxies that are believed: a comma-separated list of addresses or CIDR
  blocks, or a hop count (1–10). Only those may state a client address.
- `true` and `*` are development conveniences and **production boot refuses them.** There is
  no configuration in which a production API believes an address from anybody who asks.
- The web tier follows the same rule in its own right (`webConfig().trustForwardedIp`): it
  reads the edge's header only when `TRUST_PROXY` names an edge, and otherwise forwards no
  address at all, so a browser-supplied header cannot reach the API as a claim.
- The browser suite needs a fresh address per test, and it gets one through a **separate**
  switch, `TRUST_FORWARDED_IP_FOR_TESTS`, which production boot refuses. It is deliberately
  not the fixed-code switch: one is about where a message goes, the other about who is
  counting, and sharing a knob between them would make a test convenience look like a
  sending policy.

Nginx must **overwrite** `X-Forwarded-For` and `X-Real-IP` with the address it actually sees,
never append to what the browser sent; `docs/deployment.md` says so where the proxy is
configured. Even with a wrong Nginx config the API's rule holds — it believes only the
configured proxy, and Nginx is the one configured — so the failure is a shared counter rather
than an open one, and that is the direction to fail in.

`apps/api/test/client-ip.test.ts` boots the real API twice, differing only in the policy: with
no proxy trusted, twenty-one sign-ins and six registrations that each claim a different
address still hit the production ceiling (21st 429, 6th 429); with a trusted proxy, twenty-five
forwarded addresses are twenty-five counters and none is refused. `env.spec.ts` refuses
trust-everything and the test switch in production, and `apps/web/src/lib/client-ip.spec.ts`
proves the web tier ignores a header it was not told to trust.



## 0053 — An OTP attempt is claimed in the row, and an address is validated before it is used

**Status:** accepted · **Phase:** 2c

Decision 0052 made the client address trustworthy. This one closes what an attacker could
still do with a correct address, and what a malformed one could still reach.

**Verify attempts are atomic.** The service used to read `attempts`, compare, and then write
`attempts + 1`. A hundred requests sent together all read `0` and all compared, so the
"five attempts" ceiling was five attempts per request in flight, not per code. The comparison
is now made only after the row itself has been stepped:

```sql
UPDATE otp_requests
   SET attempts = attempts + 1
 WHERE id = $1::uuid
   AND consumed_at IS NULL
   AND expires_at > now()
   AND attempts < 5
RETURNING attempts
```

No row returned means the code is spent. A hundred simultaneous guesses therefore get at most
five comparisons between them, and the fifth wrong one consumes the row. `otp-flow.test.ts`
fires that hundred at one code and proves, by the `OTP_FAILED` audit rows written per
comparison, that at most five happened and that the right code is refused afterwards.

**Verifying is metered like requesting.** A destination accepts ten comparisons an hour and an
address twenty, keyed on the resolved client address; a refusal raises the `OTP_VERIFY_LIMITED`
alert counter and is audited like every other OTP alert.

**Nothing that is not an address is used, stored, logged or forwarded.** Both tiers validate
with `net.isIP` before the value is counted by, written to an audit row or logged — one choke
point on the API (`clientAddress` in `auth/request.ts`, used by `requestMeta`) and one on the
web tier (`clientAddress` in `lib/upstream.ts`). Garbage, a list, an oversized value, a
newline, `=HYPERLINK(...)` and `<script>` all become "no address", never a Redis key.

**The web tier names hops, not trust.** It cannot see the socket's peer, so `TRUST_PROXY`
there accepts only a hop count (1–10): production refuses `true`, `*` and an address list. The
address is `X-Real-IP` (the single value Nginx overwrites) or the entry at that hop **from the
right** of `X-Forwarded-For`. The left-most entry is never read, so a chain the browser grew
still resolves to what the proxy wrote.

**Production refuses a range too broad to be a proxy.** `/0`, an IPv4 block below `/8` and an
IPv6 block below `/32` are refused at boot, and entries are validated as addresses rather than
by shape (`999.1.1.1/8` is not an address). `docker-compose.prod.yml` pins the web container
to a fixed address on a pinned subnet and sets the API's `TRUST_PROXY` to exactly that `/32`;
the web tier is set to `1` hop, the host Nginx. `scripts/validate-compose-prod.mjs` fails the
`docker` job if either drifts — a subnet or `true` on the API would let a caller choose the
address its counters are keyed by.

**One bootstrap.** `apps/api/src/bootstrap.ts` builds the application — adapter options,
`trustProxy`, the 1 MB body limit, the route hooks and the docs gate — and both `main.ts` and
the database tests call it, so the tests exercise the wiring the process really uses rather
than a copy of it. `config/trust-proxy.ts` is the one conversion from the validated
`TRUST_PROXY` to Fastify's option: a hop count is a number at runtime but is missing from
Fastify's typings, and an address list is copied out of the immutable configuration.

`apps/api/test/client-ip.test.ts` proves: a spoofed chain still hits one counter; one forwarded
address repeated twenty-one times trips the cap while a different address does not; a
multi-hop chain resolves to `198.51.100.7`, not the prepended `1.1.1.1`; registration counts by
the same address; junk is never stored; and the OTP request and verify routes agree on the
resolved address. `packages/shared/src/env.spec.ts` refuses broad ranges and impossible
addresses, and `apps/web/src/lib/client-ip.spec.ts` proves the hop reading and the production
refusals on the browser tier.


## 0053 — The client address, the proof counter, and the OTP wallet

**Decided in phase 2c, after a security review of items 1–5. Date: phase 2c.**

**The client address is resolved once, by us.** `resolveClientAddress` (`apps/api/src/config/trust-proxy.ts`)
is a pure function over the boot's own `TRUST_PROXY`, the socket address and the two forwarding
headers. The bootstrap runs it in an `onRequest` hook and stores the answer on the request;
`requestMeta` reads that value and validates it with `net.isIP` again before it becomes a Redis
key, an audit row or a session record. The framework's own resolution is kept for logging, but no
per-IP decision depends on it, so a Fastify version change cannot quietly change who is counted.
Every candidate is dropped unless it is exactly one address: garbage, a list, an oversized value,
a newline and a spreadsheet formula never reach the database or a log.

**Re-authentication is metered.** Five wrong proofs (password or code) in fifteen minutes closes
the counter for that account with `429`; every wrong proof writes `IDENTITY_REAUTH_FAILED` with
the reason. A successful proof resets the counter. A request that offers no proof at all is not a
failed proof and is not counted — it is refused with the message that says what to offer.

**The code is required while the switch is on.** For an account with no email address, the fresh
session was the third proof (0050). It now applies only when `OTP_ENABLED` is false or the account
has no verified mobile: with the switch on, a code to the account's own number is required even on
the no-email path. A session minutes old is a weaker proof than a code only the holder's phone
receives, and an account with a verified number always has that option.

**OTP spend is counted atomically.** The daily SMS budget was read from `sms_cost_ledger`, which
is a record of what was sent, not a gate: two requests arriving together could both read "one
more is fine". A Redis counter (`otp:budget:count:<business day>`) is now `INCR`ed before a
provider is called, expires with the business day, and the `INCR` that takes the day past its
budget is the one that is refused and latches the breaker. The ledger stays the record. Requests
are also capped per number across every purpose (6 an hour, 12 a day), so relabelling a request
from `LOGIN` to `SIGNUP` cannot multiply the per-purpose ceiling.

**Secrets are checked for shape, not just for names.** In production, `AUTH_SECRET`,
`OTP_HMAC_SECRET` and `REVALIDATE_SECRET` must be different from each other, and each is refused
if it is the shipped default, starts with `dev-`, or contains `change-me`/`changeme`. A
production boot that uses the HTTP SMS gateway must present `OTP_GATEWAY_AUTH_VALUE`;
`SMS_PROVIDER` itself is required only when `OTP_ENABLED` is true.

**The SSRF guard judges every way an IPv4 address can be hidden in IPv6.** NAT64
(`64:ff9b::/96`) and 6to4 (`2002::/16`) are refused when the IPv4 address they embed is refused;
Teredo (`2001::/32`), the documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`,
`2001:db8::/32`) and the benchmarking ranges (`198.18.0.0/15`, `2001:2::/48`) are refused outright.

**`apiCall` refuses to leak and refuses to wait.** A response cached under Next tags is never
built from an access token (it would be shared between visitors); a request is abandoned after
10 s; and a response is streamed through a reader with a 1 MB cap, so an oversized body is refused
rather than buffered.


## 0054 — Accepted risks in phase 2c: a burnable code and a hard budget stop

**Decided in phase 2c, at the end of the security review. Date: phase 2c.**

Two risks are accepted rather than fixed in this phase, recorded here so they are judged again when
the switch goes on. `OTP_ENABLED` stays false in production (decision 0048), so neither is live yet.

**Anyone who knows a number can burn its code.** Verification is metered per destination and per
client address, and five wrong guesses spend the row (decision 0053). That rule is also a lever: a
caller who can reach `POST /v1/auth/otp/verify` with a victim's number can send five wrong codes and
leave the holder unable to use the code they were sent, or exhaust the per-number verify cap for the
hour. The holder cannot request a replacement while the cooldown holds either. The cost to the
attacker is bounded — one paid message per number per cooldown, and every guess writes an audit row
and an alert counter — and the obvious fix, a human check on every verification, taxes the honest
case more than the attack, so it is not taken now. Before OTP is enabled, one of these is chosen and
recorded in its own decision: bind the attempt counter to a client cookie set by the request route,
so burning a code requires the same browser that asked for it; or answer a wrong code with a
challenge instead of a refusal, so guesses cannot spend the code at all.

**The daily SMS budget is a cliff.** `OTP_SMS_DAILY_BUDGET` is counted by an atomic Redis counter
incremented before the provider call and trips a breaker for the rest of the Asia/Kolkata day
(0053). That is the right failure direction for money, but it takes mobile sign-in and sign-up down
for every user until midnight, whether the day was busy or attacked. The mitigation is on the
operator side and is written into the runbook: `docs/otp-enable-runbook.md` §4 tells the on-call
operator to read `otp:budget:count:<day>` against the budget, to alert when it passes about 80%,
and to page when `otp:alerts:SMS_BUDGET_EXHAUSTED:<day>` becomes non-zero or
`otp:budget:closed:<day>` latches. Sharing the budget per client address, so one attacker cannot
spend the day's allowance for everybody, is the next step and is owed with the staging test.


## 0055 — One client-address header per tier, named

**Decided in phase 2c hardening, before any deployment. Date: post-2c hardening.**

**One header, never two.** `TRUST_CLIENT_IP_HEADER` names the single request header a tier
reads for the client address: `x-real-ip` (the default) or `x-forwarded-for`. The other header
is not opened at all, so there is no fallback to fall back to. Believing both is worse than
believing neither: an edge that overwrites `X-Real-IP` leaves `X-Forwarded-For` to the browser,
and an edge that appends to `X-Forwarded-For` leaves `X-Real-IP` to it, so a request could
arrive with a truthful header and a forged second one and the resolver would take whichever it
happened to prefer. With one named header, the forged one is inert.

**The name is part of naming the proxy.** A production boot that sets `TRUST_PROXY` to
anything but `false` and does not set `TRUST_CLIENT_IP_HEADER` is refused; the web tier refuses
the same combination when it names a hop. `docker-compose.prod.yml` sets `x-real-ip` on both
tiers — Nginx overwrites that header with `$remote_addr` — and the web tier forwards the
address under the same name, which `scripts/validate-compose-prod.mjs` checks. Each tier still
reads the value as a chain of one, so switching to `x-forwarded-for` is a configuration change
and needs no code change.

**Proof.** `apps/api/src/config/trust-proxy.spec.ts` proves that the resolver reads only the
value it is handed; `apps/api/test/client-ip.test.ts` boots the real API twice more, once per
header name, and proves that a spoofed `X-Forwarded-For` is ignored when `X-Real-IP` is the
configured header and the reverse; `apps/web/src/lib/client-ip.spec.ts` proves the same on the
web tier; `packages/shared/src/env.spec.ts` and `apps/web/src/lib/config.spec.ts` prove the
production refusal and the default.


## 0056 — A re-authentication attempt is claimed before the proof is checked

**Decided in the post-2c hardening review. Date: hardening.**

Re-authentication counted failures *after* a comparison, and refused when the count was already
at the limit. Twenty parallel wrong passwords could therefore all read the same count and all be
verified. The counter is now `INCR`ed (atomic in Redis) before the proof is compared, and a
claim above the limit is answered `429` without comparing anything: five of twenty parallel
guesses are verified, fifteen are refused, and a successful proof resets the counter. A request
that offers **no** proof is not an attempt and does not spend the budget, so an account's
"enter the code" form cannot lock itself by being submitted empty.

`account-reauth.test.ts` sends the twenty in parallel and proves 5 × 400 and 15 × 429, with five
`IDENTITY_REAUTH_FAILED` rows.

## 0057 — An IPv4-mapped IPv6 address is judged as the IPv4 address it carries

**Decided in the post-2c hardening review.**

A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`. Left in that form it does not
match an IPv4 proxy block, so a trusted proxy would be counted as the client. The resolver
normalises the mapped form to the embedded IPv4 address before any trust decision, and
`trust-proxy.spec.ts` proves a socket of `::ffff:10.1.2.3` is matched by `10.0.0.0/8` while a
socket of `::ffff:203.0.113.9` is itself the client.

## 0058 — An unreadable API answer becomes our sentence, not the upstream's

**Decided in the post-2c hardening review.**

`apiCall` used to hand a non-JSON response body to the page as `{ message: <raw text> }`. An
upstream that answers HTML, a stack trace or a proxy error page has said something about
itself that a visitor should not read. A body that does not parse is now replaced with
`GENERIC_API_MESSAGE` ("Something went wrong. Please try again."), while the HTTP status is
kept so the page can still say it failed. `upstream.spec.ts` proves a 500 whose body names an
internal path never reaches the result.

## 0059 — Socket timeouts, and containers that cannot grow

**Decided in the post-2c hardening review.**

Node has no default connection or request timeout, so a socket that opens and says nothing, or
a client that sends headers and stalls, holds a slot until something else gives up — a
slow-loris lever behind Nginx. `bootstrap.ts` sets `connectionTimeout` 10 s, `requestTimeout`
30 s and `keepAliveTimeout` 72 s (shorter than Nginx's 75 s default, so this tier closes an idle
connection before the proxy reuses it); the values are recorded in `API_TIMEOUTS`, pinned by
`test/timeouts.test.ts`, and that test also boots with a 300 ms override and proves a silent
socket is closed.

The production compose is hardened to match: `no-new-privileges:true` and `cap_drop: ALL` on
the api, web and worker, memory limits sized for a 4 GB VPS (1 GB postgres, 384 MB redis,
640 MB api, 768 MB web, 384 MB worker, 256 MB migrations), `json-file` log rotation at 10 MB ×
3 for every service, a healthcheck for the worker that PINGs its queue, Redis `requirepass`
with the password carried in `REDIS_URL`, and postgres and redis pinned by manifest-list
digest. `scripts/validate-compose-prod.mjs` fails the `docker` job when any of that drifts.
Containers still run as root and the images still copy the whole workspace: both stay in
`PROGRESS.md`'s Known gaps.


## 0060 — The coin wallet is a cache of an append-only ledger

**Decided in phase 5, item 1. Date: phase 5.**

**One writer.** `CoinService` (`apps/api/src/coins/coin.service.ts`) is the only code that
writes `coin_transactions`, and it only writes movements: a type, a signed amount, an
optional reference, an idempotency key and who caused it. It never takes a balance from a
caller, and `new_balance` is computed from the wallet row it locked with `SELECT ... FOR
UPDATE`.

**The database keeps the wallet honest.** A `BEFORE INSERT` trigger on the ledger locks the
wallet, refuses a row whose `previous_balance` is not that wallet's current balance, and
moves the wallet to `new_balance` inside the same statement; CHECK constraints then require
`new_balance = previous_balance + amount`, `amount <> 0` and both balances non-negative. A
second trigger refuses a wallet balance change that did not come from the ledger for the
application role (`pg_trigger_depth()` tells the two apart), so the API can post entries but
cannot move a balance. The table's owner can still repair a wallet deliberately, and the
nightly reconciliation (item 4) reports any wallet that no longer matches its ledger rather
than hiding it.

**Append-only, twice over.** `UPDATE` and `DELETE` on the ledger raise
`insufficient_privilege`, and `abhyas_app` holds only `SELECT` and `INSERT` on it — the same
pair of rules the audit log has carried since phase 1.

**One key, one intent.** `UNIQUE (user_id, idempotency_key)` plus a `request_fingerprint`
(SHA-256 of type, amount and reference). Replaying a key with the same fingerprint returns
the original row and writes nothing; replaying it with a different amount, type or reference
is answered `409` and audited as `COIN_IDEMPOTENCY_MISMATCH`, because two intents wearing one
key is a bug, not a retry.

**Proof.** `apps/api/test/coins-ledger.test.ts` proves the CHECK constraints, the append-only
trigger, the application role's privileges (and that it cannot move a wallet balance
directly), a `previous_balance` mismatch, a replayed key, a reused key with a different
amount, and fifty parallel spends against a balance that affords ten: exactly ten are
charged, forty are refused, and the balance never goes below zero.


## 0061 — A wallet starts at zero, and the stopgap the ledger still needs

**Decided in phase 5, item 1b (review findings).**

**An insert is a write too.** The ledger already refused to let the application role move a
wallet's balance. It did not stop the same role *opening* a wallet with one, which is the same
hole one statement earlier. `coin_wallets_start_at_zero` refuses a non-zero `balance` on
`INSERT` for any role except the table's owner, and `coins-ledger.test.ts` proves it with
`SET ROLE abhyas_app`.

**The guard is a stopgap, and here is what replaces it.** Both wallet guards tell the honest
writer from a direct one by `pg_trigger_depth()` and by comparing `current_user` with the
table's owner. That works, but it is a heuristic about *how* a statement arrived rather than a
privilege the role does not hold: any future trigger that writes the wallet would inherit the
same permission, and a role renamed in a deployment would quietly change who is refused. The
preferred design is the one the audit log already uses in spirit: move the wallet write into a
`SECURITY DEFINER` function owned by the migration role, grant `abhyas_app` `SELECT` and
`INSERT` on `coin_wallets` only, and take away `UPDATE` altogether. Then the application
cannot move a balance by any path because it has no privilege to, no trigger-depth check is
needed, and the guarantee survives a rename or a new trigger. It is recorded here as the next
piece of ledger work rather than done now, because it changes the shape of `CoinService`'s
transaction and belongs with the admin tools that will exercise it.

**One of a thing, not one of a request.** The idempotency key stops the same request being
written twice; it never stopped two different requests asking for the same thing. Two partial
unique indexes now say what the ledger means: one `SIGNUP_GRANT` per `user_id`, and one
`ENROLLMENT` per `(reference_type, reference_id)`. `CoinService.grantSignupCoins` treats the
first as *already granted* and returns the row that exists, because a caller reaching it with a
different key has asked a question whose answer is the grant already there.

**History is not rewritten, not even by a delete.** `coin_transactions.created_by` is
`ON DELETE RESTRICT` like every other reference from the ledger: an append-only row that forgot
who caused it would be a rewrite by another name. A single entry is also bounded
(`abs(amount) <= 1000000`), so a malformed admin request or a bad bulk job cannot move a
surreal number in one statement; bulk work composes several bounded entries instead.

**Proof.** `apps/api/test/coins-ledger.test.ts` (the insert guard, both partial indexes, the
restrict foreign key, the amount bound, 404 for an unknown account, and twenty parallel credits
on one key) and `apps/api/test/coin-grants.test.ts` (a grant another path wrote is read back,
not refused).


## 0062 — One mailbox, one grant — and the farming risk that remains

**Decided in phase 5, item 2b (review findings).**

**The identity a grant is paid against is not always the address typed.** Gmail ignores dots
in the local part and everything from a plus onwards, and googlemail.com is gmail.com, so
`a+1@gmail.com` and `a.b@gmail.com` are one inbox. `coin_grant_identities` records the
normalised identity a grant paid out against, keyed `(kind, value)` and written inside the
same transaction as the ledger row: a second account spelling the same mailbox differently
finds the key taken and earns nothing, without an error and without a second grant. The
address a person signs in with is untouched — this value is for grant eligibility only.

**The email-only grant is a farming risk until OTP is on.** With `signup_grant_requirement`
at `email`, one person can register a second account with a mailbox they control at another
domain (or a domain whose dots are significant) and earn the 1,000 coins again. The index
above closes the Gmail spelling, not the business model: a disposable-address domain defeats
it. Before launch, either `signup_coins` should be lowered for accounts that have verified
only an email (the mobile requirement paying the full amount), or the requirement should be
`mobile` once SMS is live. Recorded here rather than solved, because the fix is a product
decision about the launch economics, and `signup_coins` is a setting an Administrator can
already change without a deployment.

**Proof.** `apps/api/src/coins/email-identity.spec.ts` (unit) and
`apps/api/test/coin-grants.test.ts` (`lets one Gmail mailbox earn the grant once, however it
is spelled`), plus `coin-safety.test.ts` for the rule that a coin failure never breaks the
flow that called it: a 0 setting means disabled, a missing setting row is counted and
audited as `COIN_REWARD_ERROR` with a kind and an error class only, and a sign-in or
verification still succeeds.



## 0063 — The bulk drain is a poller over database state, not a queue of its own

**Decided in phase 5, item 3b.**

**Why not BullMQ.** The obvious shape for a bulk assignment is one BullMQ job per person.
That would make the queue the record of who has been paid, and BullMQ is at-least-once: a
worker that dies after writing a ledger row but before acknowledging would be handed the
same job again. It would also put the decision of *how far the job has got* in Redis, where
the status screen cannot read it and a flushed Redis loses it. The job row and its
per-person rows are already in Postgres, already carry the counts, and already survive a
restart.

**What runs instead.** `coin_bulk_jobs` and `coin_bulk_job_rows` are the queue. The worker's
repeatable drain finds `QUEUED` and `RUNNING` jobs and asks the API to run one batch of each,
because the ledger has exactly one writer and it lives in the API. Each batch takes the next
`PENDING` rows and writes one ledger row per person keyed `<job_id>:<user_id>`; the wallet's
unique `(user_id, idempotency_key)` plus the fingerprint turns a retry into a replay, not a
second credit. A job killed halfway resumes from the first row still `PENDING`, and two
drains running the same job at once credit each person exactly once — proven in
`apps/api/test/coins-admin.test.ts`.

**The cost that comes with it.** A poller spends a query every thirty seconds whether there
is work or not, and a broken job would be retried forever unless something gives up. So the
drain bounds each API call at fifteen seconds, logs when it hits its round cap rather than
pretending the job is finished, counts consecutive failed drains per job, marks the job
`FAILED` after five, and raises a Redis alert counter for the operator
(`apps/worker/src/jobs/coin-bulk.spec.ts`).



## 0064 — A student's history is paged by number, with the page capped

**Decided in phase 5, item 4b (student wallet).**

**Numbered pages, not a keyset yet.** `GET /v1/coins/me/history` takes `page` and `pageSize`
(the latter capped at 100), because a student wants "page 2 of my ledger" and a numbered page
is what the wallet table shows. The cost is a `skip`, which a deep page pays for; the query is
bounded by `userId`, so it scans one person's entries rather than the table.

**The page number is capped at 10,000.** A caller asking for page 100,000,000 would otherwise
hand Postgres a `skip` it has to walk. Beyond 10,000 the API answers 400 rather than quietly
serving an empty page: a client that far into a ledger is asking a question the screen does not
offer. Keyset pagination (cursor on `(created_at, id)`) is the later improvement when archives
grow, and it is noted here so the cap is a decision rather than a surprise.

**Proof.** `apps/api/test/wallet.test.ts`: a repeated parameter (`type=A&type=B`, `page=1&page=2`)
is refused, and an absurd `page=100000000` is refused.



## 0065 — The Administrator's coin forms: the form's key is the ledger's key, and a preview is only a cookie

**Decided in phase 5, item Q4 (admin coin screens).**

**The form's `Idempotency-Key` reaches the ledger unchanged in meaning.** `CoinsService`
stores the request (its own fingerprint and the response) under `(actor, key)`, and passes the
same key to `CoinService` as `admin:<actor>:<key>`. The API-level key answers a replayed form
with the first answer, and the ledger-level key is what makes two submissions that arrive *at
the same time* one movement: whichever wins the wallet's row lock writes the row, the loser
replays it. The audit row for the adjustment is written by the winner only, because a replay is
the first decision already recorded. Proven in `apps/api/test/coins-admin.test.ts`, where both
submissions are sent with `Promise.all` and exactly one ledger row and one audit row exist.

**A refused proof keeps the whole request.** `POST /v1/admin/coins/adjust` and `/bulk` answer
403 `reauth_required` until a proof (password or a code to the Administrator's own number)
verifies, and the proof check runs *before* the request is stored — so nothing has been
consumed. The web form answers that refusal by redirecting back with the same key, and now
with the same amount and remark, because the stored fingerprint is bound to the exact body: a
retry with a different body would be a 409, not a retry. The screen re-renders those fields,
the Administrator enters the proof, and the second submission is the same request.

**A bulk preview is convenience, not authority.** The matched accounts, the amount and the
reason live in one httpOnly cookie for fifteen minutes; confirming posts the matched ids back,
and the API re-reads every account, re-checks `coin_max_bulk_users` and `coin_max_bulk_coins`
and creates the job itself. A tampered cookie therefore cannot credit an account the preview
never matched, and an expired one is refused with a message rather than a stale confirmation.
The job's own idempotency key means a double click on confirm creates one job.

**Proof.** `e2e/admin-coins.spec.ts` (an Administrator credits one account; two simultaneous
submissions of the open form write one row; a CSV with one unmatched row previews, credits the
matched two and reports the job; an editor and a student are refused by the pages and by a
direct post to the write route), and `apps/api/test/coins-admin.test.ts` for the ledger,
fingerprint and audit behaviour underneath it.



## 0066 — The internal coin route's address list: a pinned /24 in development and CI, the operator's own in production

**Decided in phase 5, Q4 (the first browser proof of a bulk job).**

**What the browser found.** The worker does not write coins: it calls `POST /v1/internal/coins/bulk/drain`
with `INTERNAL_API_SECRET`, and that route answers **404** unless the caller's address is one of
`INTERNAL_ALLOWED_ADDRESSES`. Development and CI listed `127.0.0.1/32`, which no container can
present — the worker arrives from its own address on the Compose network — so every job stayed
`QUEUED` while the worker logged `could not be drained: the API answered 404`. The reconciliation
job knocked on the same door every 24 hours and was refused the same way, silently.

**Why the obvious fix is refused.** Compose gives a new project a /16, and
`parseAllowedAddress` refuses any block wider than /24 (decision 0057: a coin-moving route must
not accept the internet). Listing a /16 is therefore not allowed, and a container address cannot
be known before the network exists.

**The fix: pin the development network.** `docker-compose.yml` now declares the default network
as `10.213.0.0/24` and both the API and the worker allow exactly that block. It is a development
and CI topology, written down where the network is created, and the worker's address is inside it
by construction.

**Production is untouched.** `docker-compose.prod.yml` still requires `INTERNAL_ALLOWED_ADDRESSES`
from the environment, and the shared validator still refuses a block wider than /24. The operator
sets it to the worker's (and any operator host's) exact address or its /24; nothing in CI proves
the production list, which is why it is a deploy note rather than a test.

**Proof.** The e2e job's stack now drains: `e2e/admin-coins.spec.ts` shows a bulk job reaching
`COMPLETED` with `2 / 2` credited and its report downloadable, in both runs of `ea400ea`. The
refusal itself stays proven by `coins-admin.test.ts` (404 without the secret) and
`internal-access.spec.ts` (the address rule).



## 0067 — The e2e browser download: cached per runner OS and Playwright version, and bounded

**Decided after phase 5, on the `e2e` job itself.**

**What the cancellations actually were.** The `e2e` job had been cancelled at its timeout
twice, and both times the missing minutes were in one place. From the Actions jobs API, step
by step: on `7790330` the job took 13m0s, of which **9m22s** was `pnpm exec playwright install
--with-deps chromium`; on the `main` merge `bd37281` the same step ran **11m16s** before the
job was cancelled. Every other step was as fast as on a healthy run — the stack up 1m56s and
2m02s, the OTP restart 13s, the health poll 0s — and on the healthy re-run of `7396cd1` the
install took **16s**. The `migrate` dependency, the pinned `10.213.0.0/24` development network
and `INTERNAL_ALLOWED_ADDRESSES` (0066) were therefore never the problem: the job was waiting
on a CDN and an apt mirror.

**The stopgap first.** PR #23 raised the job cap from twelve minutes to **twenty**, because a
job that is cancelled proves nothing even when every test that ran passed. That is a ceiling,
not an explanation, and on its own it only moves the wall further away: the 13m0s run on
`7790330` spent 9m22s in that one step and would still have been cancelled at twelve.

**Fail fast inside the job.** The head of the same work bounds the steps that wait on Docker:
six minutes for the stack-up, six for the OTP restart, three for the health poll with
`--max-time 5` on each curl, and `Collect container logs` now runs with `if: always()`, so a
cancelled run leaves `ps` and the tails of postgres, migrate, api and worker behind instead of
an empty artifact. The job cap stays at twenty as the ceiling.

**The cache.** The e2e job now caches `~/.cache/ms-playwright` with `actions/cache`, pinned by
commit SHA like every other action in the workflow, keyed
`playwright-<runner os>-<installed Playwright version>`. The version is read from the installed
package (`pnpm exec playwright --version`), so it follows the lockfile rather than a variable a
human has to remember to bump; a Playwright upgrade changes the key and downloads once. On a
hit the step runs `playwright install-deps chromium` instead of the download, because the OS
packages (`libnss3`, fonts, X libraries) are not in that cache and a restored browser without
them cannot launch. On a miss the normal `--with-deps` install runs, and the step carries its
own `timeout-minutes: 8`, close to the healthy cost and far below the job cap, with one retry
on failure: a stalled CDN now fails in minutes with "the Chromium download failed once; retrying
once" and the step's own timeout, not at the job cap with nothing to read.

**What the two runs showed.** The first run of `ci/playwright-browser-cache` (`59fd58f`, run
42200948401, attempt 1) was a miss: the restore step took 0s, the install 21s, and the post step
saved `playwright-Linux-1.64.1` at 293 MB. The re-run of the same `e2e` job (attempt 2, no code
change) restored that cache in **4s** and ran `install-deps` in **11s**; both runs were green,
9/9. A hit is not automatically faster on a good day — the miss downloaded in 21s — but a hit
does not touch the browser CDN at all, which is where the 9m22s and 11m16s went. If a later hit
ever fails to launch the restored browser, the cache is removed and the install keeps only its
timeout and retry.

## 0068 — Phase 6: the test pattern, the publish rule and the enrollment rules

**Decided before phase 6's first unit. Two parts: what the owner has decided, and what this
session assumes and the owner will confirm.**

### Decided by the owner

**Only an Administrator publishes or archives a test.** An editor builds a draft and submits
it; the hand-off is the editor's last action. This is a decision, not a default: `tests.publish`
belongs to `ADMIN`, an editor calling publish or archive is refused with **403** by the API
before any handler runs, the publish and archive controls do not render on an editor's screen,
and a Playwright test proves both halves. Phase 6 therefore also **retires the `publish_tests`
editor flag** that phase 3 introduced (decision 0033): the three-flag model becomes two flags,
`manage_questions` and `manage_tests`, and a migration refuses `tests.publish` on an editor
account. Until that migration lands, "an editor cannot publish" is not true of this repository,
and `docs/PHASE-6.md` says so.

**The pattern is per test and editor-editable.** The editor who assembles a paper sets its
questions, its duration, its marks per question and its negative marking. Nothing derives the
pattern from the exam.

**Single-correct questions only, no partial marking.** The question bank's `MCQ` already
enforces exactly one correct option by a deferred trigger; phase 6 papers use those, and the
negative marking is one number for the paper rather than a per-option weighting. No
multiple-correct question type and no partial credit in the attempt engine after it.

**Editors may see answer keys; only an Administrator moves coins.** An editor reads the key and
explanation of the questions they may edit. No coin is added or removed by anyone but an Admin;
the single run-time debit is enrollment.

**Enrollment costs 100 coins per attempt, from `default_enrollment_cost`** (already a
setting, default 100, `apps/api/test/operations.test.ts` asserts it). There is no refund, and a
retake pays again. A student holds at most one **open** enrollment per test at a time, and a
test may carry an optional maximum number of attempts. Every phase 6 e2e spec pins the
settings it reads with the upsert-and-verify fixture in `e2e/coin-settings.ts`.

**Accuracy is correct ÷ attempted.** Defined here, computed in the results phase.

### Assumed, owner to confirm

These do not block work; each is reversible without changing the shape of the data or the
ledger.

- **Lifecycle:** `DRAFT` → `SUBMITTED` → `PUBLISHED` → `ARCHIVED`. Editors create drafts and
  submit; only an Administrator publishes or archives. `SUBMITTED` exists because the hand-off
  is a real state — an editor's work is done and the Administrator has something to review.
- **Freezing:** publishing freezes a test version's questions, ordering, duration, marks and
  negative marking. Editing a published test opens a **new version**; an open enrollment keeps
  the version it was sold, so a retake cannot change the paper under a student already sitting
  it. This is the same rule the question bank already uses (`question_versions_frozen`).
- **The debit:** enrollment writes one `ENROLLMENT` ledger row through `CoinService.spend` in
  the same transaction as the enrollment row, with the request's `Idempotency-Key`. A double
  click or a retry writes one debit. The row's `reference_type` is `'enrollment'` and its
  `reference_id` is the enrollment's id, so the existing partial unique index
  `coin_transactions_one_enrollment_per_reference`
  (`(reference_type, reference_id)` where `type = 'ENROLLMENT'`, migration `20260801000000`)
  keeps its meaning and each enrollment — including a retake — is its own charge.
- **The student catalog** lists published tests only, with title, exam, duration, question
  count, total marks, cost and the student's own enrollment state. It never shows an answer
  key, an explanation, a draft or an archived test.

**Consequence for the queue:** P1 adds the schema, the partial unique index for one open
enrollment and the retirement of the editor publish grant; P2 and P3 enforce the publish rule
in the API and the pages; P4 makes the debit and the enrollment one transaction with the wallet
row locked. The specification and the audit of what already exists are in `docs/PHASE-6.md`, and
the queue is in `docs/NEXT-TASKS.md`.

### Confirmed or corrected at the close of the phase

**The publish rule needed no assumption.** The owner confirmed it, and it is built: the
migration deletes editor grants of `tests.publish` and a trigger refuses a new one, `POST
/v1/admin/tests/:id/publish` and `.../archive` answer **403** to an Editor or a Student before
any handler runs, the builder page renders neither control without `tests.publish`, and
`e2e/test-builder.spec.ts` proves both halves (0069).

The four assumptions came out as follows.

- **Lifecycle — confirmed as written.** The migration CHECKs the four statuses and 0070 records
  the transition table: a second submit, a second publish, an edit after archive and a publish
  of a draft are all 409.
- **Freezing — confirmed.** 0069 freezes a published version and its placements by trigger; 0070
  opens a new version when a published paper is edited and leaves an open enrollment's
  `test_version_id` pointing at the version it was sold.
- **The debit — corrected in one respect.** It is not `CoinService.spend` but the new
  `CoinService.spendWithin`, the same private `applyEntry` path exported for a caller that
  already holds a transaction. The row is written inside the enrollment `$transaction` under the
  wallet row's `FOR UPDATE`, with the key prefixed `enroll:` and looked up scoped to the caller
  before the transaction and again under the lock (0072). The rest of the assumption held: one
  `ENROLLMENT` row per enrollment, `reference_type 'enrollment'`, `reference_id` = the
  enrollment's id, and the existing partial unique index keeps its meaning.
- **The student catalog — confirmed, with two fields added.** It also carries
  `marksPerQuestion`, `negativeMarksPerQuestion` and `maxAttempts`, and the caller's own
  `enrollment` state (`status`, `attemptNumber`, `enrollmentId`, `attemptsUsed`). It carries no
  question, option, `isCorrect`, explanation, `created_by`, ledger id, idempotency key or
  fingerprint, which the P4 tests assert field by field.

Two smaller decisions followed from building it: refusals carry a stable `code` beside their
unchanged message (0073), and the builder routes take no `Idempotency-Key` (0071).



## 0069 — Phase 6, P1: the published paper is frozen by trigger, and publishing a test is an Administrator's permission

**Status:** accepted · **Phase:** 6

**The freeze is a trigger, not a service rule.** A `test_versions` row with `published_at` set
cannot be updated or deleted (`test_versions_frozen`), its question list cannot be added to,
reordered or removed (`test_questions_frozen`), and a published test cannot go back to `DRAFT`
or `SUBMITTED` nor be deleted (`tests_status_frozen`). This is the rule
`question_versions_frozen` already uses, applied to the paper: an enrollment points at a
version, so the version a student paid for must be immutable even if a later code path forgets
to check. Editing a published test therefore creates a new version (P2), and an open attempt
keeps the one it bought (P4).

**`tests.publish` is now an Administrator's alone, so question publishing got its own code.**
The phase 4 question-publish route was guarded by `tests.publish`, which phase 3 also exposed
to editors through the `publish_tests` flag. Retiring the flag alone would have taken question
publishing away from editors, which was never the owner's decision. So the migration adds
`content.publish` ("Publish a question version"), grants it on the `EDITOR` and `ADMIN` roles,
and repoints the question publish route (`POST /v1/questions/:id/publish`) at it.
`tests.publish` stays a role permission of `ADMIN`; the migration deletes existing editor grants of it (rather than failing
the deploy on them) and the replaced `user_permissions_editor_flags_only` trigger refuses a new
grant to anything but an `ADMIN` account.

**Safety on existing data.** The new migration was written to apply to an empty schema (which
is how every database test applies it: `prisma migrate deploy` on a fresh schema) and to a
database with earlier phases' rows: it deletes the editor `tests.publish` grants instead of
assuming there are none, and it only adds tables and permissions. This session could not run
Docker, so the migration has not been executed against a real Postgres here; the `database`
job on the pushed commit is what will prove it, on both an empty schema and the seeded one.

**Consequences.** The three editor flags become two, `manage_questions` and `manage_tests`;
`docs/permissions.md`, the admin users screens, the web route handlers and the flag tests all
say so. `apps/api/test/tests-model.test.ts` proves the CHECKs, the freeze, one open enrollment
per student and test under two concurrent inserts, the enrollment-to-ledger link, and the
editor grant refusal.



## 0070 — Phase 6, P2: the paper's lifecycle, the revision, and one winner

**Status:** accepted · **Phase:** 6

**The allowed transitions are an explicit table, and everything else is a 409.**

| From | Action | To | Who |
| --- | --- | --- | --- |
| `DRAFT` | submit | `SUBMITTED` | the paper's editor (`tests.write`) or an Administrator |
| `SUBMITTED` | publish | `PUBLISHED` | **an Administrator** (`tests.publish`) |
| `PUBLISHED` (a revision is open) | publish | `PUBLISHED` | **an Administrator** |
| `PUBLISHED` | archive | `ARCHIVED` | **an Administrator** |
| `PUBLISHED` (a revision is open) | submit | `PUBLISHED`, `submitted_at` set | the paper's editor |

Anything else — publishing a draft, archiving a draft or a submitted test, a second submit, a
second publish, editing a submitted or archived test, submit or edit after archive — answers
**409** with the reason in the body. The table lives in `TestsService` as those explicit
checks; it is not inferred from a status ordering.

**A published test does not go back to `DRAFT` or `SUBMITTED`.** The P1 trigger
(`tests_published_frozen`) refuses that, because a student could have paid for the paper in
between. So a revision's hand-off is `submitted_at` plus a `TEST_SUBMITTED` audit row with
`revision: true`, and the Administrator publishes the revision directly. The alternative —
letting a published row slip back to `SUBMITTED` — would make the freeze depend on a code path
rather than the database.

**What happens to the live paper while a revision is being edited.** The test row keeps
`status = PUBLISHED` and its `published_at`; `current_version` moves to the new unpublished
version, and the paper a student buys is the newest version **with** `published_at` set. Editing
a published test therefore:

- creates version `N+1` as a **copy** of the live version's pattern *and* its ordered question
  list, because an Administrator should review a complete paper, not an empty one;
- leaves version `N` published, frozen by trigger, and referenced by every open enrollment;
- changes nothing a student holding enrollment sees until an Administrator publishes the
  revision, at which point new enrollments get `N+1` and existing ones keep `N` (decision
  0069). The API response carries both: `version` (being edited) and `publishedVersion`
  (being sold).

**Atomicity is a row lock plus a guarded write.** Every state-changing call opens one
transaction, takes `SELECT ... FOR UPDATE` on the `tests` row, re-reads the state, and then
writes with the state in the `WHERE` (`updateMany({ where: { id, status } })`, or
`updateMany({ where: { id, publishedAt: null } })` for the version stamp), refusing when the
count is not 1. Two simultaneous submits or publishes therefore serialise on the lock: the
second reads what the first committed and gets a 409, and exactly one audit row is written.
The concurrency proof is in `apps/api/test/tests-builder.test.ts`.

**The question list is replaced, not patched.** `PUT /v1/editor/tests/:id/questions` takes the
whole ordered list, validates every id (exists, is the caller's own unless an Administrator,
belongs to the paper's exam, is published), then deletes and re-inserts inside the same
transaction. That is what makes reordering atomic and the positions gapless 1..n — there is no
window in which two positions collide, and the unique `(test_version_id, position)` index is
never violated by a partially applied reorder.

**Strict bodies and queries.** An unknown field is a 400 rather than silently ignored, so a
client that misspells `maxAttempts` learns it did. The limits are bounded at the edge of the
API as well as in the database: duration 1–600 minutes, marks per question above 0 and at most
100, negative marks between 0 and the marks, `maxAttempts` null or 1–100, at most 100 questions
per paper, at most 2,000 characters of description. Repeated query parameters are refused
rather than read as arrays, and only `status`, `examId` and `page` are filters.

**Answer keys.** The builder's responses are Editor and Administrator only, and they carry
`isCorrect`, the explanation and a numerical question's answer, because an editor placing a
question has to see what it asks (the phase 6 rule: editors may read the key). No student-facing
serialiser exists in this unit; a Student gets 403 on every builder route, and the test checks
that no 403 body carries either field. The catalog and attempt serialisers that will face
students are P4, P5 and phase 7, and each owns its projection.



## 0071 — Phase 6, P3: the builder screens, and why they send no Idempotency-Key

**Status:** accepted · **Phase:** 6

**The pages do not enforce anything the API does not.** `/editor/tests`,
`/editor/tests/<id>` and `/admin/tests` each read `loadPermissionSession` before rendering, so a
student is sent to `/account?denied=1` and never receives the shell; the Publish and Archive
controls render only for `tests.publish`. But the write handlers behind them
(`/api/editor/tests/create`, `/[id]/pattern`, `/[id]/questions`, `/[id]/submit`,
`/api/admin/tests/[id]/publish` and `.../archive`) hold no permission logic at all: they read the
session cookie, pass its access token to the API and return the API's answer. An editor who
posts to the publish handler by hand is refused by the API with 403, and the handler redirects
back with that message. This is the same split the coin screens use (decision 0065): the page
is a convenience, the API is the authority, and there is exactly one place to change a rule.

**No Idempotency-Key, because no builder route accepts one.** The queue asked for a key
"where the API accepts one", and the P2 routes do not: every write is already idempotent in the
way that matters. `PUT /questions` replaces the whole ordered list, so sending it twice
converges on the same paper; `submit`, `publish` and `archive` are guarded by the lifecycle —
the second call sees the state the first committed and is refused with 409 rather than applied
twice; `PATCH` is a last-write-wins update of pattern fields; `POST /v1/editor/tests` creates a
row by definition. The coin tools need a key because a double submit there would move coins
twice; a double-clicked "Save pattern" here rewrites the same fields, and a double-clicked
"Submit" is refused. Adding a client key nobody checks would suggest a protection that is not
there, so the forms send none and the page says so here.

**A published paper's builder page says two things at once.** It shows the live version
(`publishedVersion`: number, duration, total marks) with a sentence that it "stays exactly as it
is", and beside it the draft version being edited. That is decision 0070's model made visible:
the API copies version `N` into an unpublished `N+1` on the first edit, and students keep `N`
until an Administrator publishes the revision. Without the notice, an editor would reasonably
assume their change is live the moment they save it.

**Ordering is two buttons, not drag and drop.** `Up`/`Down` post one question id and a
direction; the handler reads the paper's current order from the API, swaps the pair, and sends
the whole list back through `PUT /questions`. A drag-and-drop library would have been dependency
weight for an operation whose correctness lives on the server anyway, and the whole-list PUT is
what keeps the positions gapless (decision 0070).

**The e2e fixture seeds the exam and the bank in SQL, and that is deliberate.** An editor may
only build a paper for an exam they created and place their own questions — the P2 object rule.
The admin UI can create an editor and a catalog entry, but it cannot yet hand an existing exam to
another account, and authoring a question through the TipTap editor is a flow of its own with its
own coverage. So `e2e/tests-fixture.ts` inserts one category, exam, subject and two published
questions owned by the editor, through the same `docker compose exec ... psql` route the coin
settings fixture uses, and the spec then exercises only the builder screens. When the catalog
grows an "assign owner" control, the fixture should be replaced by it.



## 0072 — Phase 6, P4: enrollment is one transaction, in one lock order

**Status:** accepted · **Phase:** 6

**The lock order is wallet, test, enrollments.** Every enrollment transaction takes the caller's
`coin_wallets` row `FOR UPDATE` first, then the `tests` row `FOR SHARE`, then reads and inserts
`enrollments`. The order is what keeps two shapes of concurrency safe at once: two requests from
**one** student (a double click, two tabs, a retry) meet on the wallet row and serialise, so only one
of them decides the balance; two requests from **different** students meet on the shared test row in
SHARE mode, which readers never block, so neither waits for the other's wallet. Taking the test row
first, or the enrollment rows first, would let two students hold different locks in opposite orders.
The same reason the `enrollments` row is last: it is the only row this transaction creates.

The wallet lock is taken through **`CoinService.lockWallet`**, added for this, and the debit is
written through **`CoinService.spendWithin`** — `spend`'s own logic (`applyEntry`) running inside the
transaction the enrollment opened. No second code path writes a ledger row or a balance: the
wallet's trigger still moves the balance, the insufficient-funds check is still `applyEntry`'s 400
("Not enough coins for this charge"), and a replayed key still returns the original row.

**An `Idempotency-Key` is the student's, and it is checked twice.** Before the transaction the key
is looked up on `enrollments (user_id, idempotency_key)`; inside it, again, under the wallet lock —
two requests carrying one key can both pass the first check. A key already spent on **this** test
answers with the first enrollment, byte for byte, and charges nothing; the same key on **another**
test is a 409 and writes nothing, because silently serving a different paper's purchase would be
worse than a refusal. On the ledger the key is prefixed `enroll:` (`enroll:<key>`), so it cannot
collide with `signup:`, `daily:` or `admin:` — and the 8..100-character client bound exists because
the ledger refuses a key above 200 characters, prefix included.

**Two different keys racing for one paper end in exactly one winner, never a 500.** The open
enrollment check and the attempt count are advisory; the decision is the database's own indexes —
`enrollments_one_open_per_test` (the partial unique index) and `enrollments_user_test_attempt_key`.
A `P2002` from the insert aborts the transaction, so the debit written a moment earlier rolls back
with it, and the API answers **409** ("Another enrollment for this test was written at the same
moment; try again"). The test proves one 201, one 409, one ledger row, one enrollment row and the
balance moved once.

**A retake is a new enrollment with a new attempt number and a new debit.** A completed or expired
attempt leaves its row, its `coin_transaction_id` and its `test_version_id` untouched; the new row
is `attempt_number = prior + 1` and points at the version that is published **now**. That is what
`coin_transactions_one_enrollment_per_reference` (one `ENROLLMENT` row per `(reference_type,
reference_id)`) is for: each enrollment is its own reference, so a retake can never share a debit
with the attempt before it. The attempt engine that closes an attempt (COMPLETED) is phase 7; this
unit only reads that state.

**Status codes, and why each one.** `201` for a new enrollment, and the same `201` for a replay —
the body is identical, so a client that retries cannot tell it apart, which is the point. `400` for
a missing or malformed key, a body field (including `userId`), an unknown query value, or an
unaffordable price: the wallet's own insufficient-funds answer is a 400 and enrollment reuses it.
`409` for a paper that is not for sale (draft, submitted, archived), an open enrollment, a reached
attempt cap, and a reused key on another test — all of them states the client could have known.
`404` for an unknown paper, so the catalog cannot be used to discover drafts. `401` for an
anonymous or suspended session, the guard's answer before any handler.

**The price is read inside the transaction, and zero closes the shop.** `default_enrollment_cost`
has bounds `0..100000`; a zero would need a zero-amount ledger row, which
`coin_transactions_amount_non_zero` refuses, so a zero is a 409 ("Enrollment is closed") rather
than a free paper. The read happens after the checks, so the amount charged is the amount the
setting held while the transaction ran.

**The catalog never selects a question.** `GET /v1/tests` and `GET /v1/tests/:id` select the paper's
summary, its live version's pattern and counts, and the caller's own enrollments — nothing from
`test_questions`, `questions`, `question_versions` or `question_options`. The enrollment's own
answer is the same projection plus the row it wrote. The attempt serialiser in phase 7 is the first
student-facing response that may carry a question, and it will own its own projection.



## 0073 — Phase 6, P5: one key per render, and refusals told apart by code

**Status:** accepted · **Phase:** 6

**The enroll form's `Idempotency-Key` is generated once per render, and the refusal returns it.**
The key is created when `/tests/<id>` renders and carried in a hidden field. On 201 the handler
redirects to `?enrolled=1` with no key, so the next page load (or a deliberate new attempt) is a
new intent with a new key. On a refusal it redirects to `?error=<code>&key=<key>`, and the page
reuses that key instead of generating one. That is what makes a retry safe: adding coins after an
`insufficient_coins` refusal and pressing the same button replays the first request — which
wrote nothing — instead of risking a second debit; and a retry after an `open_enrollment`
refusal replays the enrollment that already exists. The key lives only in the form and the URL
of that one page; it is never stored in the browser, and it names the intent, not the person.

**Refusals are classified by the API's `code`, not by its status.** Three different 409s (an open
enrollment, the attempt cap, a paper no longer for sale) and two 400s (an unaffordable price, a
malformed request) mean five different things to a student, and the status cannot tell them
apart. P4's messages were already exact but messages are prose; this unit adds a stable `code`
beside each one — `insufficient_coins`, `open_enrollment`, `attempt_cap_reached`, `not_for_sale`,
`key_reused` — thrown as `{ code, message }` the way `reauth_required` already is (decision 0065).
The message is unchanged, so every existing assertion on it still holds; the web tier reads the
code and a plain `switch` turns it into the sentence the student sees. Anything unrecognised —
including a 500 or a proxy error — becomes one generic sentence, and no API text is ever put into
the URL: the redirect carries the code, never the message.

**The insufficient-funds code is added at the enrollment boundary, not in `CoinService`.** The
ledger's own 400 ("Not enough coins for this charge") is shared by every debit, the admin's
included; the enrollment service catches exactly that message and rethrows it with the code, so
nothing else in the coin path changes and the wallet's own behaviour stays as verified in P4.

**The pages are read-only projections.** `GET /v1/tests`, `GET /v1/tests/:id` and
`GET /v1/enrollments/me` are called through one small helper whose types are copied field for
field from `enrollments.service.ts`; there is no second fetch style and no client-side state.
A page that cannot load its data renders an error sentence instead of throwing (the catalog, the
enrollment list and the detail page each have their own empty/error branch), because a thrown
server component shows the student a crash and the run a missing test id.



## 0074 — Phase 7: the server's clock, submit-only answers, and the sweeper

**Decided before phase 7's first unit. Two parts: what the owner has decided, and what this
session assumes and the owner will confirm.**

### Decided by the owner

**The server owns the clock.** `POST /v1/enrollments/:id/attempt` computes `deadline_at =
started_at + test_version.duration_minutes` and stores it. The page shows a countdown from the
remaining seconds the server sends, re-synced on every read, and never decides expiry itself: a
browser clock, a paused tab or a manipulated timer cannot extend or shorten an attempt.

**Answers are saved only on submit.** There is no autosave and no partial-save endpoint. The
consequence is accepted and is written plainly in `docs/PHASE-7.md`: an attempt the server ends
at its deadline without a submit call has an **empty answer set**, so every question is
unattempted and the score is zero. Closing the browser scores zero.

**One start per enrollment, and no resume.** Starting delivers the paper once; a second start is
refused, a reload does not re-deliver it and the questions are never returned by any later read.
Ending moves the enrollment to `COMPLETED` (submitted) or `EXPIRED` (auto-submitted); a new
attempt needs a new enrollment and a new payment.

**Scoring is one pure function.** Correct earns the version's `marks_per_question`, wrong loses
its `negative_marks_per_question`, unattempted scores zero, single-correct only, no partial
marking. `accuracy = correct ÷ attempted` with zero attempted giving zero. The function is a
function of (version, submitted answers) alone, unit-tested on its own, and the only place that
computes marks.

**Answer keys stay on the server until the attempt has ended.** The phase 6 projection rule holds
before the end — no `is_correct`, `numerical_answer` or `explanation_html` in the start response
or in any pre-end read — and the post-end result is the only student response that carries them.

**Questions come in the version's order.** No shuffling in this phase.

### Assumed, owner to confirm

- **A grace window of `attempt_submit_grace_seconds`, default 5, bounds 0–60.** A submit arriving
  within it of `deadline_at` is accepted for network latency; later than that the attempt has
  already been ended by the server and the submit is refused with a clear message.
- **The sweeper lives in the existing worker and runs at least every 30 seconds**, following the
  bulk-coin drain's shape (a repeatable job, a query over database state, work done through the
  API's own service so there is still one writer, row locks and idempotency so a kill resumes).
  The same ending happens **lazily** on any read or submit of an expired attempt, so no result
  depends on the worker being up.
- **A reload mid-test ends access to the paper.** The page warns before leaving, the enrollment
  is not refunded, and there is no resume.
- **The autosave table exists but no autosave endpoint does.** `attempt_answers` is in A1's data
  model so a later autosave is a new write path rather than a rewrite; nothing writes it before a
  submit in this phase.
- **One attempt per enrollment and one result per attempt**, enforced by unique indexes and by a
  trigger that refuses to change a written result, so a submit racing the sweeper or two workers
  still produce exactly one result.

**Consequence for the queue:** A1 adds `attempts`, `attempt_answers`, `results` and the grace
setting; A2 writes the pure scoring function; A3 the four student routes and both expiry paths;
A4 and A5 the taking and result screens; A6 docs and merge; A7 stop. The specification and the
audit of what already exists are in `docs/PHASE-7.md`, and the queue is in `docs/NEXT-TASKS.md`.
