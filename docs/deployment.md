# Deployment

Two compose files, one topology. Development is for people; production is for the platform, and
it refuses to start without its secrets.

## Development

```mermaid
flowchart TB
  subgraph host["Developer machine"]
    browser["Browser<br/>localhost:3000"]
    shell["pnpm commands<br/>lint, typecheck, tests, db:migrate"]
  end

  subgraph compose["docker compose up — project abhyas"]
    web["web<br/>:3000 published"]
    api["api<br/>:3001 published"]
    worker["worker"]
    pg[("postgres:16-alpine<br/>:5432 published<br/>volume pgdata")]
    redis[("redis:7-alpine<br/>:6379 published")]
  end

  browser --> web
  web -->|API_INTERNAL_URL| api
  api --> pg
  api --> redis
  worker --> pg
  worker --> redis
  shell -->|DATABASE_URL=localhost:5432| pg
```

- Every service has a healthcheck; `docker compose up --wait` blocks until the stack is actually
  serving, which is exactly what the `compose-smoke` and `e2e` CI jobs rely on.
- Database ports are published in development only, so host-side `pnpm db:migrate` and
  `pnpm test:db` work.
- Two database roles (decision 0023): migrations connect as the owner
  (`MIGRATION_DATABASE_URL`), while the API and the worker connect as `abhyas_app`
  (`DATABASE_URL`, `APP_DATABASE_URL` for tests) — not a superuser, with `UPDATE`, `DELETE`
  and `TRUNCATE` on `audit_logs` revoked. Development and CI create the role from
  `docker/postgres-init/01-app-role.sql`; production creates it out of band with its own secret.
- `ALLOW_DEV_LOGIN`, a Turnstile test key, the `fake` SMS provider and the console email outbox
  are set here — and are refused by the boot gate when `NODE_ENV=production`.

## Production

```mermaid
flowchart TB
  users["Clients"] --> web["web<br/>published ${WEB_PORT:-3000}"]

  subgraph compose["docker compose -f docker-compose.prod.yml"]
    web --> api["api<br/>expose 3001 only"]
    migrations["migrations<br/>one-shot: prisma migrate deploy"]
    api --> pg[("postgres<br/>no published port<br/>named volume")]
    api --> redis[("redis<br/>no published port")]
    worker["worker"] --> pg
    worker --> redis
    migrations --> pg
  end

  api -.->|phase 4: presigned URLs| s3[("S3-compatible storage")]
  nginx["Nginx — hardening phase<br/>edge TLS and rate limiting"] -.-> web
```

Production invariants, asserted by `scripts/validate-compose-prod.mjs` in the `docker` CI job:

- Postgres, Redis and the API publish **no** host ports; only the web tier is reachable.
- `NODE_ENV=production` in every service; no `ALLOW_DEV_LOGIN`, no `fake`/`console` SMS, no
  console email outbox.
- Migrations run as the owner role (`MIGRATION_DATABASE_URL`); the API and the worker run as
  `abhyas_app`, which cannot rewrite or erase `audit_logs`.
- `EMAIL_PROVIDER` is required and cannot be `console`; `EMAIL_PROVIDER=smtp` additionally
  requires `SMTP_URL`, and the transport still refuses to send until real delivery is wired.
- Every secret is required by name (`${VAR:?message}`), so rendering the file without one fails
  before any container starts. A default secret is therefore impossible to deploy.
- Named volumes only; no bind mounts of host paths.
- Migrations run as a one-shot service that the API waits on, so a replica never serves against
  an unmigrated schema.

## Planned edge and storage

Nginx will terminate TLS, serve the Next.js static assets and rate-limit the auth endpoints; it
belongs with the hardening phase. Object storage will hold question media in phase 4: the API
issues presigned upload/download URLs and never proxies bytes. Both are drawn here because they
change the deployment shape, and neither exists yet — they are listed as known gaps in
`PROGRESS.md`.

## CI mapping

| Concern | Job |
| --- | --- |
| Images build from the repository | `docker` |
| Production topology has no shortcuts | `docker` (`validate-compose-prod.mjs`) |
| The stack comes up and serves health and docs | `compose-smoke` |
| A user can open the home page against the running stack | `e2e` |


## The proxy in front of the API, and the client address

Per-IP limits are only as good as the address they count, so the address is resolved in one
place and believed only when a proxy is named (decision 0052).

**The API.** `TRUST_PROXY` is unset by default, and then every forwarding header is ignored:
the socket address is the client. It accepts a hop count (1–10) or a comma-separated list of
addresses and CIDR blocks. `true` and `*` are refused at boot in production, and so is any
block wider than the platform can call a proxy: `/0`, an IPv4 block below `/8`, or an IPv6
block below `/32` is refused, because a range that big lets a caller choose the address its
counters are keyed by. Entries are validated as real addresses with `net.isIP`, not by shape.

`docker-compose.prod.yml` names **exactly one** address: the web container's fixed address on
the compose network, as a `/32`. It never names a subnet, and `scripts/validate-compose-prod.mjs`
fails the `docker` job if it does, or if the web service loses its fixed address.

**The web tier.** Behind Nginx on the host, one hop counts as the edge:

```yaml
TRUST_PROXY: '1'    # web: exactly one proxy — the host Nginx — in front of it
```

Here `TRUST_PROXY` is a hop count and nothing else; production refuses `true`, `*` and an
address list, because a Next.js route handler cannot see the socket's peer and therefore
cannot check an address. The tier reads `X-Real-IP` first — the single value Nginx overwrites
— and otherwise the entry at the named hop **from the right** of `X-Forwarded-For`. The
left-most entry is never read: that is the one a browser can write.

**Every value is validated before it is used.** Both tiers drop anything that is not exactly
one `net.isIP` address, so garbage, a list, an oversized value, a newline or a spreadsheet
formula never reaches a Redis key, an audit row or a log line.

So the edge must both **overwrite** the headers and be **named**:

```nginx
# Nginx, on the server that fronts web:3000 and api:3001
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $remote_addr;   # $remote_addr, NOT $proxy_add_x_forwarded_for
proxy_set_header X-Forwarded-Proto $scheme;
```

`$proxy_add_x_forwarded_for` appends what the browser sent, which is the one thing that must
not happen. With `proxy_set_header X-Forwarded-For $remote_addr` the browser's own value is
discarded and the address Nginx actually accepted the connection from is the only one either
tier can see.

**Why unset is a safe failure, and a shared one.** With `TRUST_PROXY` unset the socket address
is used. Behind a proxy that is the proxy's own address, so every visitor shares one per-IP
counter: the limits still apply, they just apply to everyone at once. That is degraded, not
unsafe. The unsafe direction — believing whatever header arrives — is refused at boot in
production, and the browser suite is the only thing allowed to choose an address, through
`TRUST_FORWARDED_IP_FOR_TESTS`, which production also refuses.
