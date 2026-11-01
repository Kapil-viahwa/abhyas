# Roles and permissions

Authorization is deny-by-default and checked twice: at the route (does the caller hold the
permission codes the route requires?) and at the object (may this caller act on *this* row?). A
permission alone never grants access to every row — that is the IDOR rule.

## Roles

| Role | Code | Purpose | Boundary |
| --- | --- | --- | --- |
| Administrator | `ADMIN` | Owns the platform | Everything, including users, roles, coins and settings |
| Editor | `EDITOR` | Authors content | May not touch users, roles, permissions, coins or settings |
| Student | `USER` | Takes mock tests | Own profile, own attempts, own coin history |

A user has exactly one role (`users.role_id`). `EDITOR` is created by an `ADMIN` only.

## Permission catalog

Codes are `resource.action`, and the catalog is seeded by migration so it cannot drift from the
code that checks it.

| Code | Meaning |
| --- | --- |
| `users.read` | List and read any user |
| `users.write` | Create, suspend, restore and edit any user |
| `roles.write` | Assign roles and change a role's permissions |
| `permissions.assign` | Grant or revoke a per-user permission override |
| `settings.read` | Read platform settings |
| `settings.write` | Change platform settings |
| `coins.read` | Read any user's coin history |
| `coins.adjust` | Add or deduct coins outside the automatic rules |
| `audit.read` | Read the audit log |
| `content.read` | Read content, including unpublished |
| `content.write` | Create and edit exams, subjects, topics, questions and options |
| `tests.read` | Read tests, including drafts |
| `tests.write` | Create and edit tests, sections and question placement |
| `tests.publish` | Publish or archive a test |
| `attempts.take` | Start and submit an attempt |
| `attempts.read.all` | Read any user's attempts and results |
| `analytics.read` | Read platform analytics |

## Matrix

`Y` = granted by the role. Everything else is denied.

| Permission | ADMIN | EDITOR | USER |
| --- | --- | --- | --- |
| `users.read` | Y | — | — |
| `users.write` | Y | — | — |
| `roles.write` | Y | — | — |
| `permissions.assign` | Y | — | — |
| `settings.read` | Y | — | — |
| `settings.write` | Y | — | — |
| `coins.read` | Y | — | own only |
| `coins.adjust` | Y | — | — |
| `audit.read` | Y | — | — |
| `content.read` | Y | Y | published only |
| `content.write` | Y | Y | — |
| `tests.read` | Y | Y | published only |
| `tests.write` | Y | Y | — |
| `tests.publish` | Y | — | — |
| `attempts.take` | Y | — | Y |
| `attempts.read.all` | Y | — | — |
| `analytics.read` | Y | — | — |

"The own only" and "published only" rows are object-level rules, not extra permissions: a student
reading `/me/coins` passes a `users.read.self` style check enforced by the handler, and a
published filter is applied in the query. `USER_PERMISSIONS` adds individual codes to a user
without changing their role; those are always granted by an `ADMIN` and are audited.

## Rules that are enforced, not documented

- A route with no explicit permission requirement fails review, and a permission check that
  reads the role from the request body is a bug: the role is read from the authenticated user
  record by the server.
- Coins: only `ADMIN` may add or deduct outside the automatic rules (`coins.adjust`), and every
  such change is a ledger row with `created_by` set.
- Editors cannot escalate: `roles.write`, `permissions.assign` and `users.write` are absent from
  the `EDITOR` row above, so no editor route can reach them.
- Answer keys and explanations are never serialised before submission, regardless of permission.

## Where this is implemented

| Piece | Phase |
| --- | --- |
| `users`, `roles`, `permissions`, `user_permissions` tables and the seeded catalog | 1 (this phase) |
| `role_permissions` table, authentication, guard that enforces the matrix | 2 |
| Object-level rules per resource | with the resource (phases 3–4) |
