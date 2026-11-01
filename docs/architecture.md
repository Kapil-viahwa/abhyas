# Architecture

Phase 0 is a walking skeleton: every moving part exists, is wired to the next one, and is
proven by CI. Feature phases add tables, endpoints and screens inside this shape.

## Runtime topology

```mermaid
flowchart TB
  browser["Browser"]
  playwright["Playwright (CI)"]

  subgraph docker["Docker network"]
    web["apps/web<br/>Next.js App Router<br/>:3000"]
    api["apps/api<br/>NestJS on Fastify<br/>:3001"]
    worker["apps/worker<br/>BullMQ"]
    postgres[("PostgreSQL 16")]
    redis[("Redis 7")]
  end

  cdn["S3-compatible object storage<br/>(phase 2+)"]

  browser -->|HTTP| web
  playwright -->|HTTP| web
  playwright -->|OpenAPI, health| api
  web -->|server-side fetch of /health| api
  api -->|Prisma| postgres
  api -->|ioredis| redis
  worker -->|BullMQ jobs| redis
  worker -->|Prisma| postgres
  api -.->|presigned URLs| cdn
```

The browser never talks to the API directly in phase 0; the home page is a server component
that reads `API_INTERNAL_URL`. That keeps the API base URL out of the client bundle and
makes the "backend is the only authority" rule easy to enforce as screens are added.

## Repository layout

```
apps/api        NestJS (Fastify) REST API, Prisma, migrations, unit + database tests
apps/web        Next.js App Router UI for students, editors and admins
apps/worker     BullMQ consumers
packages/shared environment validation and cross-cutting types
e2e             Playwright user flows against the running stack
scripts         CI helpers (failure summary, production compose validation)
docs            architecture, decisions, working rules
```

## Request paths in phase 0

```mermaid
sequenceDiagram
  participant P as Playwright
  participant W as web (Next.js)
  participant A as api (NestJS)
  participant D as PostgreSQL
  participant R as Redis

  P->>W: GET /
  W->>A: GET /health
  A->>D: SELECT 1
  A->>R: PING
  A-->>W: 200 {status: "ok", checks: {...}} or 503 when a dependency is down
  W-->>P: HTML with data-testid="api-status" data-status="ok"
```

`/health` answers 200 only when both dependencies respond; otherwise 503 with the same body,
so the web page can show which dependency is down rather than a generic error.

## Configuration and secrets

Environment validation lives in `packages/shared` and is used by both the API and the worker,
so no entry point can forget it.

```mermaid
flowchart LR
  env["process.env"] --> validate["validateEnv()"]
  validate -->|valid| boot["boot"]
  validate -->|invalid| refuse["EnvValidationError<br/>process exits 1"]
  validate -->|production + dev shortcut| refuse
```

Production refuses: Turnstile test keys, `fake`/`console` SMS providers, `ALLOW_DEV_LOGIN`,
auth secrets shorter than 32 characters or equal to a known default, and missing secrets.
`docker-compose.prod.yml` additionally requires every secret by name, so rendering the file
without one fails before a container starts.

## Data

Phase 0 ships one hand-written migration (`app_metadata`) whose only purpose is to prove that
migrations are applied by the pipeline and that CHECK constraints are enforced by PostgreSQL
rather than by application code. Each later phase adds its own tables in its own migration.
