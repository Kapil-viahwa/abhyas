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
