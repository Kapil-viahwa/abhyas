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

## Dependency reasons

Filled in as dependencies are added. Format: package — reason it is here, and what it replaces.

_None yet: F0 adds documentation only._
