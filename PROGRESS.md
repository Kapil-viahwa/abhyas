# Progress

Honest status. "Verified by" names a CI run and the job in it that actually executed; nothing else counts. A row that has never executed in CI says so.

| Phase | Scope | Built | Verified by | Known gaps |
| --- | --- | --- | --- | --- |
| F0 | Working rules acknowledged, repository created | README, working rules, decision log, progress table, Node 22 pin | Documentation only — no CI job proves documentation | No code, no CI |
| 0 | Walking skeleton: pnpm monorepo, API `/health` + `/api/docs`, web health page, worker example job, Prisma with one migration, dev and production compose, nine CI jobs, Playwright flow | See the phase 0 mapping table | Run [41312437972](https://github.com/Kapil-viahwa/abhyas/actions/runs/41312437972) on commit `0f96b9d` (pull request #1): all nine jobs green | Carried gaps, listed below with the phase that fixes each |
| 1 | Architecture plan (system, deployment, Release 1 ER, module boundaries, permission matrix) and identity foundation: `users`, `roles`, `permissions`, `user_permissions`, `settings`, `audit_logs`, plus the admin seed | See the phase 1 mapping table | Run [41315945253](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253) on commit `7f82182` (push to `phase-1`): all nine jobs green — the first run that ever executed for this branch | No identity API yet (phase 2); `role_permissions` and the enforcement guard are design only (phase 2) |

## What CI proves for phase 1, and the job + run that proves it

Every link below is a job in run [41315945253](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253) on commit `7f82182`. Where a claim is proven by a test file, the named job is the one that executed it.

| Claim | Job | Evidence | Proof |
| --- | --- | --- | --- |
| The design documents describe the system being built | — | `docs/architecture.md`, `docs/deployment.md`, `docs/data-model.md`, `docs/permissions.md` | No CI job proves prose; reviewed in the pull request |
| The new migration applies to an empty schema and records itself | database | `migrations.test.ts`: both migration names finished, all seven tables exist | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| Email is unique case-insensitively | database | `identity.test.ts`: `  Student-x@Example.COM  ` is stored lowercased and the same address in another case is rejected | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| Mobile is unique after normalisation | database | `identity.test.ts`: `+91 98765 xxxxx` stores as ten digits, a `0`-prefixed duplicate is rejected, a five-digit number is rejected | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| Settings values are bounds-checked and type-checked | database | `identity.test.ts`: out-of-bounds integer rejected, in-bounds accepted, boolean declared as integer rejected, blank string rejected | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| `audit_logs` rejects UPDATE and DELETE | database | `identity.test.ts`: trigger raises "append-only" for both | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| The application role cannot rewrite or erase the audit log | database | `identity.test.ts`: `SET ROLE abhyas_app` + UPDATE/DELETE → permission denied; INSERT and SELECT succeed | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| Roles and the permission catalog are seeded | database | `identity.test.ts`: ADMIN/EDITOR/USER and the documented permission codes exist | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| A permission override cannot be self-granted or duplicated | database | `identity.test.ts`: both inserts rejected | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| The seed refuses without explicit variables, including in production | unit | `seed-admin.spec.ts`: no default password, length/strength/default checks, production requires `SEED_ADMIN_CONFIRM=create-first-admin` | [job 124875894829](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894829) |
| Passwords round-trip through scrypt and malformed hashes are refused | unit | `password.spec.ts` | [job 124875894829](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894829) |
| The seed creates an ADMIN, is idempotent and audits itself | database | `seed-admin.test.ts`: role, hash verifies, `IDENTITY_ADMIN_SEEDED` row, second run creates nothing | [job 124875894887](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894887) |
| The home page still shows a healthy API | e2e | `home.spec.ts` against the running stack | [job 124875894934](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894934) |
| Every package lints and typechecks with the new code | lint, typecheck | `pnpm lint`, `pnpm typecheck` exit 0 | [job 124875894860](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894860) and [job 124875894836](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894836) |
| Images build and production compose keeps its invariants | docker | `docker compose build`, `scripts/validate-compose-prod.mjs` | [job 124875894878](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894878) |
| The stack still comes up and serves health and docs | compose-smoke | `docker compose up --wait`, `curl /health`, `curl /api/docs-json`, `curl /` | [job 124875894732](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894732) |
| No secret is committed | gitleaks | full-history scan | [job 124875894892](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894892) |
| No blocking advisory in a production dependency | audit | `pnpm audit:ci` | [job 124875894863](https://github.com/Kapil-viahwa/abhyas/actions/runs/41315945253/job/124875894863) |

## Known gaps carried forward

| Gap | Impact | Phase that fixes it |
| --- | --- | --- |
| No Nginx in front of the stack | No TLS termination, static-asset serving or edge rate limiting | Phase 5 |
| No object storage | Question media cannot be uploaded or served; `media_assets` is design only | Phase 5 |
| Containers run as root | A container escape starts privileged; no `USER` directive in the images | Phase 5 (hardening) |
| Images copy the whole workspace | Each image carries every package and dev tooling: slow pulls, larger surface | Phase 5 (pruned `pnpm deploy`) |
| One Playwright flow only | Only the health page is proven in a browser | Phase 2 onward, one flow per phase |
| No identity API | Phase 1 ships tables, constraints and a seed; no user or role endpoints yet | Phase 2 |
| `role_permissions` and the authorization guard | Permission codes exist, but nothing resolves role → permission or enforces the matrix | Phase 2 |
| Dev-only advisories | `vitest`/`tinypool` and the `eslint` chain, tracked in `docs/security-exceptions.md` | Continuous, via Dependabot |
