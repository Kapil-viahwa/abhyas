# Deploying Abhyas

An ordered runbook for a clean Linux host with Docker and Docker Compose. Nothing in this
document is a secret: every value is something the operator generates or is given by a provider,
and secrets are referred to by **name** only.

Production topology is `docker-compose.prod.yml`: Postgres, Redis, a one-shot migrations
container, the API, the web tier and the worker. It publishes one port, on loopback only, and
requires every secret from the environment by name.

**D1 is this document and the compose fixes.** Nginx/TLS (D2) and backups (D3) are *not* in it;
the sections that mention them say what D1 assumes and what those units will add.

## 1. Prerequisites

- A Linux host with Docker Engine 24+ and the Compose v2 plugin (`docker compose version`).
- 4 GB RAM (the compose memory limits add up to about 3.4 GB), 2 vCPU, 40 GB disk.
- A DNS name pointing at the host, and a TLS certificate for it (D2 terminates TLS).
- An external S3-compatible bucket over **https**, with a key pair. Production refuses the
  in-memory store, a non-https endpoint and the development credentials.
- A Cloudflare Turnstile widget (site key and secret key) allow-listed for the host name.
- An SMTP endpoint **if** `EMAIL_PROVIDER=smtp`. The SMTP sender in this build validates its
  configuration and then refuses to deliver (decision 0027): real delivery is launch blocker #4.
- For OTP only: a DLT-registered sender id, entity id and template id, and an https SMS gateway
  that accepts a JSON body and an auth header.

## 2. Environment

The full set the compose file hands the services. `docker-compose.prod.yml` fails at
`docker compose config` when a `${VAR:?}` is missing, so start by satisfying every required row.

| Name | Required | Default | What it is | Read by | Must differ from CI/dev |
| --- | --- | --- | --- | --- | --- |
| `POSTGRES_USER` | yes | — | database owner role (migrations run as it) | postgres, migrations | yes |
| `POSTGRES_PASSWORD` | yes | — | that role's password | postgres | yes |
| `POSTGRES_DB` | yes | — | database name | postgres | no |
| `MIGRATION_DATABASE_URL` | yes | — | owner connection string used only by the migrations container | migrations | yes |
| `DATABASE_URL` | yes | — | runtime connection string for the non-owner `abhyas_app` role | api, worker | yes |
| `REDIS_PASSWORD` | yes | — | Redis `requirepass`; the API and worker embed it in `REDIS_URL` | redis, api, worker | yes |
| `AUTH_SECRET` | yes | — | 32+ chars; signs session material | api, worker | yes |
| `REVALIDATE_SECRET` | yes | — | 16+ chars; API → web cache drop | api, web, worker | yes |
| `INTERNAL_API_SECRET` | yes | — | worker → API internal routes | api, worker | yes |
| `INTERNAL_ALLOWED_ADDRESSES` | yes | `172.31.0.20/32` | the only source allowed to present the internal secret | api | no (fixed address) |
| `TRUST_PROXY` (api) | yes | `172.31.0.10/32` | the single proxy hop the API reads a client address from | api | no (fixed address) |
| `TRUST_PROXY` (web) | yes | `1` | one hop (Nginx) in front of the web tier | web | no |
| `TRUST_CLIENT_IP_HEADER` | yes | `x-real-ip` | the one header each tier reads | api, web | no |
| `WEB_URL` | yes | — | public https origin; the only origin trusted for cookie writes and CSRF | api, web | yes |
| `WEB_PORT` | no | `3000` | host loopback port for the web tier | web | no |
| `TURNSTILE_SITE_KEY` | yes | — | public widget key; a Cloudflare **test** key is refused in production | web | yes |
| `TURNSTILE_SECRET_KEY` | yes | — | server verification key; a test secret is refused in production | api, worker | yes |
| `SMS_PROVIDER` | yes | — | `http` when OTP is on (no vendor adapter exists yet); otherwise a real provider name | api, worker | yes |
| `EMAIL_PROVIDER` | yes | — | `smtp` in production (`console` is refused) | api, worker | yes |
| `SMTP_URL` | only when `EMAIL_PROVIDER=smtp` | empty | the mail transport; the SMTP sender refuses to construct without it | api, worker | yes |
| `S3_ENDPOINT` | yes | — | https endpoint of the object store | api, worker | yes |
| `S3_REGION` | no | `us-east-1` | bucket region | api, worker | no |
| `S3_BUCKET` | yes | — | media bucket; a public-read bucket is refused | api, worker | no |
| `S3_ACCESS_KEY_ID` | yes | — | bucket key id; development credentials are refused | api, worker | yes |
| `S3_SECRET_ACCESS_KEY` | yes | — | bucket secret, 16+ chars | api, worker | yes |
| `MEDIA_ORIGIN` | no | empty | bare origin the CSP allows for images; empty means no third-party host | web | yes |
| `OTP_ENABLED` | no | `false` | the mobile OTP switch, for the API and the web screens alike | api, web, worker | no |
| `OTP_HMAC_SECRET` | when OTP on | empty | 32+ chars in production; hashes stored codes | api, worker | yes |
| `OTP_SENDER_ID` | when OTP on | empty | DLT sender id | api, worker | yes |
| `OTP_DLT_ENTITY_ID` | when OTP on | empty | DLT entity id | api, worker | yes |
| `OTP_TEMPLATE_ID` | when OTP on | empty | DLT template id | api, worker | yes |
| `OTP_GATEWAY_URL` | when OTP on | empty | https SMS gateway | api, worker | yes |
| `OTP_GATEWAY_AUTH_HEADER` | no | empty | header name the gateway takes its key in | api, worker | yes |
| `OTP_GATEWAY_AUTH_VALUE` | when OTP on | empty | that header's value | api, worker | yes |
| `OTP_GATEWAY_BODY_TEMPLATE` | when OTP on | empty | JSON body template with the destination and code placeholders | api, worker | yes |
| `OTP_GATEWAY_TIMEOUT_MS` | no | `5000` | gateway timeout, 1000–30000 | api, worker | no |
| `OTP_SMS_DAILY_BUDGET` | no | `100` | daily send ceiling, 1–100000 | api, worker | no |
| `OTP_ALLOWED_COUNTRY_CODES` | no | `+91` | comma-separated E.164 prefixes | api, worker | no |
| `SEED_ADMIN_EMAIL` | one-off | — | the first administrator's address (§5) | seed command | yes |
| `SEED_ADMIN_PASSWORD` | one-off | — | 12+ chars, a letter and a digit, not a known default | seed command | yes |
| `SEED_ADMIN_NAME` | no | `Abhyas Administrator` | display name | seed command | no |
| `SEED_ADMIN_CONFIRM` | one-off | — | must be `create-first-admin` in production | seed command | no |

### Generating secrets

Run these on the host and paste the results into `.env.prod` by hand; never in a shell history
that is shared, never in this repository, never in a chat.

```
openssl rand -hex 32     # AUTH_SECRET, OTP_HMAC_SECRET
openssl rand -hex 24     # REVALIDATE_SECRET, INTERNAL_API_SECRET, POSTGRES_PASSWORD, REDIS_PASSWORD
```

`.env.prod` is `chmod 600`, owned by the deploy user, and outside the repository. `.gitignore`
already ignores `.env*` except `.env.example`.

### Checking it before you start

The same validators the API and the worker boot through can be run against the file, without
starting the stack. It prints **only variable names and the validator's messages**:

```
PROD_ENV_FILE=./.env.prod pnpm exec vitest run packages/shared/src/env-file.spec.ts
```

### OTP: how the two compose files combine

`docker-compose.otp.yml` is the *development and CI* overlay that turns OTP on with a fake
provider and a fixed code; it is never used in production (`scripts/validate-compose-prod.mjs`
refuses it, and the API refuses the fake provider in production at boot). In production OTP is
turned on with `OTP_ENABLED=true` in `.env.prod` plus the DLT and gateway values above; the prod
compose passes all of them to the API, the web tier and the worker. Leave `OTP_ENABLED` unset or
`false` and the mobile screens answer 404 and no code is ever sent.

## 3. Migrations

Migrations are plain SQL in `apps/api/prisma/migrations`, applied **in directory-name order**,
**forward-only**: there is no down migration and `migrate deploy` never edits an applied one.
They must run as the role that owns the tables (`MIGRATION_DATABASE_URL`, i.e. `POSTGRES_USER`),
not `abhyas_app`: `20270301000000_test_question_pinning` disables and re-creates a trigger on
`test_questions`, which needs table ownership.

The full list, in order:

```
20250101000000_init
20250201000000_identity_foundation
20250301000000_auth_sessions
20250401000000_session_access_tokens
20250501000000_auth_lifecycle
20250601000000_user_management
20250701000000_exam_catalog
20250801000000_settings_and_audit
20250901000000_media_assets
20251001000000_questions
20251101000000_question_import
20251201000000_question_option_latex
20260101000000_otp
20260201000000_mobile_identity
20260401000000_reauthentication
20260501000000_account_linking
20260601000000_coins
20260701000000_daily_rewards
20260801000000_coin_ledger_hardening
20260901000000_coin_admin_jobs
20261001000000_email_grant_identity
20261101000000_coin_write_permission
20261201000000_coin_admin_requests
20270101000000_tests_and_enrollments
20270201000000_attempts
20270301000000_test_question_pinning
```

`docker/postgres-init/01-app-role.sql` creates the `abhyas_app` role in development and CI. On a
production host create that role once yourself (or run the same SQL as the owner), before the
first `DATABASE_URL` boot; it is not superuser and cannot rewrite `audit_logs`.

## 4. Order of operations

1. **Back up first** (D3 will automate; for now §7).
2. `docker compose -f docker-compose.prod.yml --env-file .env.prod config >/dev/null` — this
   fails on any missing required variable before anything starts.
3. `docker compose -f docker-compose.prod.yml --env-file .env.prod pull` (base images) and
   `docker compose -f docker-compose.prod.yml --env-file .env.prod build`.
4. `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres redis` and wait
   for both health checks to report healthy.
5. `docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm migrations`.
6. Seed the first administrator (§5).
7. `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d` (api, web, worker).
8. Verify (§6).

The API waits for Postgres, Redis and a successful migrations run; the web tier waits for the API
health check; the worker waits for Postgres, Redis and the API health check. Nothing needs a
manual sleep.

## 5. The first administrator, once

The seed is idempotent: if **any** administrator exists it creates nothing, and if the named
address exists it changes nothing — it never resets a password and never creates a second
administrator (`apps/api/src/seed/seed-admin.ts`, `admin-already-exists` / `user-already-exists`).
That is also why the variables below must be removed afterwards: they are a one-time credential.

1. Put `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` (12+ chars, a letter and a digit), optionally
   `SEED_ADMIN_NAME`, and `SEED_ADMIN_CONFIRM=create-first-admin` in `.env.prod`.
2. Run the seed against the API image:
   `docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm --entrypoint sh api -c 'cd /repo/apps/api && node node_modules/prisma/build/index.js migrate deploy >/dev/null && node dist/seed/cli.js'`
   — or, if the API image keeps the CLI entry point elsewhere, the same command as
   `pnpm db:seed:admin` inside a one-off container with the API's environment.
3. Sign in at `https://<host>/login` with those credentials.
4. **Change the password** from `/account` immediately (the account page's "Change password").
5. **Remove `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` and
   `SEED_ADMIN_CONFIRM` from `.env.prod`**, then `docker compose ... up -d --force-recreate api`
   so no running container holds them. Re-running the seed later is harmless, but the values
   must not stay where a backup or a `docker inspect` can read them.

## 6. Verification checklist after deploy

- `curl -fsS http://127.0.0.1:${WEB_PORT:-3000}/` → 200, and the health panel shows the API.
- `docker compose exec api node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{console.log(r.status, await r.text())})"`
  → 200 with `database` and `redis` both `ok` (`/health` answers 503 when either is down).
- `docker compose exec worker node --input-type=module -e '...'` is already the health check;
  read it with `docker compose ps` (worker **healthy**).
- `docker compose logs worker | grep 'repeatable jobs registered'` — one line naming
  `otp.purge 900s`, `coin-bulk-drain 30s`, `coin-reconciliation 86400s`,
  `attempt-expiry-sweep 30s`.
- `docker compose logs worker | grep 'expired swept'` — a sweep tick within 30 s of boot.
- Sign in; the account page lists the session; the cookie is `Secure`, `HttpOnly`, `SameSite=Lax`.
- As the administrator, create an editor; as the editor, create a question and a paper and submit
  it; as the administrator, publish it.
- As a student, enrol (coins are charged), take the paper on staging with the real worker, and
  let one attempt run past its deadline with the browser closed: the result page shows
  `Ended automatically at the deadline` and an empty answer set.
- `curl -sI https://<host>/ | grep -i -E 'strict-transport-security|content-security-policy|x-frame-options|x-content-type-options|referrer-policy'`
  — the headers from `apps/web/src/lib/security-headers.ts` are present.
- The Turnstile widget renders with the real site key (not the "test mode" line), and a sign-in
  with a wrong password is refused normally.
- Rate limits keyed by the real client address: from two different public addresses, the same
  limit is not shared (decision 0055). Until D2's Nginx overwrites `X-Real-IP`, per-IP limits
  collapse onto the web container's address — secure, but shared.
- Nothing secret in the process table: `docker inspect` shows only variable names with values,
  so the `.env.prod` file is the only copy.

## 7. Rollback

- **The real rollback is restore.** Migrations are forward-only; a code rollback to an older
  image against a newer schema is not supported and can fail at runtime.
- Before every deploy, and before every migrations run, take a backup:
  `docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backup-$(date +%Y%m%dT%H%M).dump`
  (run it as the owner role; keep it off the host). D3 automates this and adds a restore test.
- If a deploy fails **before** migrations: `docker compose ... up -d --force-recreate` with the
  previous image tag.
- If it fails **after** migrations: restore the dump into a fresh database and start the previous
  image against it. There is no partial down-migration, and `migrate resolve` only marks a
  migration as applied — it does not undo it.
- Redis is a queue, not a system of record: losing the volume loses queued jobs; the repeatable
  jobs are re-declared by the worker on its next boot. The coins ledger and every exam fact live
  in Postgres.

## 8. What D2, D3 and D4 add

- **D2 (edge):** Nginx in front of the web port, TLS termination, and the header rewrite this
  document assumes (`X-Real-IP` set to `$remote_addr`, never appended). The web port is already
  loopback-only so only that proxy can reach it.
- **D3 (data):** scheduled `pg_dump` to off-host storage, retention, a restore test in a scratch
  database, and the same for the Redis append-only file.
- **D4 (launch):** real SMTP delivery, the S3 presigned-URL integration test against the real
  provider, the OTP staging test with a real number and DLT template, monitoring and alerting,
  and making the repository private again.

## 9. Launch blockers (from `docs/ROADMAP.md`)

| Blocker | State |
| --- | --- |
| Real SMS provider + DLT template, manual staging test (`docs/otp-enable-runbook.md` §7) | **Open** — OTP is off by default and has never sent a real message |
| Nginx overwriting (not appending) the client-address header; `TRUST_PROXY` naming it | **Partly done** — the application rule and the compose wiring are in place (`172.31.0.10/32`, `x-real-ip`); the proxy itself is D2 |
| Web port loopback-only | **Done** — `127.0.0.1:${WEB_PORT:-3000}:3000` in `docker-compose.prod.yml` |
| Real SMTP delivery | **Open** — the SMTP sender validates `SMTP_URL` and then refuses to deliver (decision 0027); `SMTP_URL` is now passed by the prod compose |
| S3 presigned URL integration test against the real provider | **Open** — no integration test against a real bucket |

## 10. What D1 changed

- `docker-compose.prod.yml` now passes the OTP names (off by default), `SMTP_URL` and
  `MEDIA_ORIGIN`, gives Redis a named volume with `appendonly yes` and `appendfsync everysec`, and
  makes the worker wait for the API's health check.
- The worker's boot line names each repeatable job and its interval.
- `packages/shared/src/env-file.spec.ts` checks a candidate `.env.prod` with the real validators,
  printing names and messages only.



## 11. The edge: Nginx on the host, TLS and the notes the compose file leaves out

Nginx runs on the host and proxies to the loopback-only web port (`127.0.0.1:3000` by default).
The configuration is `deploy/nginx/abhyas.conf` plus its included `abhyas-proxy.conf`; the
decision and its trust reasoning are 0087.

### DNS and firewall

- An `A` record for the host name pointing at the host, and an `AAAA` record only if the host has
  working IPv6 (a broken AAAA record makes some clients hang).
- Allow 22 (SSH), 80 and 443; deny everything else. **Docker-published ports bypass ufw**, so the
  firewall is not what keeps the web tier private: the loopback binding is. Never publish a
  compose port on `0.0.0.0`.

### Install and the first certificate

```
apt install nginx certbot
mkdir -p /var/www/certbot
```

Install `deploy/nginx/abhyas-proxy.conf` as `/etc/nginx/abhyas-proxy.conf` and `abhyas.conf` as
`/etc/nginx/conf.d/abhyas.conf`, replacing `__DOMAIN__` with the real name everywhere. Every
proxying location in `abhyas.conf` carries its own `proxy_pass http://abhyas_web;`;
`abhyas-proxy.conf` is included for the forwarding headers and holds no `proxy_pass`. Then:

```
certbot certonly --webroot -w /var/www/certbot -d <host> --deploy-hook "systemctl reload nginx"
nginx -t && systemctl reload nginx
```

Renewal is certbot's systemd timer (`systemctl list-timers | grep certbot`); the deploy hook reloads
Nginx. Test it with `certbot renew --dry-run`.

### The values this needs

| Setting | Value |
| --- | --- |
| `WEB_URL` | `https://<host>` |
| `TRUST_PROXY` (web) | `1` — one hop, the host Nginx |
| `TRUST_CLIENT_IP_HEADER` (web and api) | `x-real-ip` |
| `TRUST_PROXY` (api) | `172.31.0.10/32` — the web container, checked with `docker network inspect <project>_default` |
| Web port | `127.0.0.1:${WEB_PORT:-3000}` (the compose default) |

### Header ownership

| Header | Owner |
| --- | --- |
| `Strict-Transport-Security` | **edge** (the app does not send it) |
| `Content-Security-Policy` | app |
| `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` | app |
| `Cache-Control` (including the no-store result pages) | app |
| `Server` | neither — `server_tokens off` at the edge and `poweredByHeader: false` in the app |

### After the change

```
curl -sI http://<host>/ | head -n 3                       # 301 to https
curl -sI https://<host>/ | grep -i strict-transport        # HSTS present
curl -sI https://<host>/ | grep -i '^server:'              # no version token
curl -s https://<host>/ -H 'X-Forwarded-For: 1.2.3.4' -H 'X-Real-IP: 5.6.7.8' >/dev/null
docker compose logs web | tail                                 # the app saw the real address
```

`.github/workflows/proxy-check.yml` proves the configuration with a stub upstream and a throwaway
certificate: the ACME path, the 301, that every proxying location reaches the upstream (a request to
`/` answers from the stub, not from Nginx's own document root), the overwritten `X-Real-IP`/`X-Forwarded-For`, the blanked
`Forwarded`, `X-Forwarded-Proto`, HSTS, no `Server` version, the 404s for `/internal/` and
`/api/docs`, unknown Host closed with 444, the 413 above 2 MB, the TLS floor and the 429 on the
auth path.

### Launch blocker update

"Nginx overwriting forwarding headers" is now **done in configuration**, and open until the
staging test in D4 proves it on a real host (real DNS, real certificate, real renewal).
