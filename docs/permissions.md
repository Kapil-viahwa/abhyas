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
| `content.write` | Y | by flag | — |
| `tests.read` | Y | Y | published only |
| `tests.write` | Y | by flag | — |
| `tests.publish` | Y | by flag | — |
| `attempts.take` | Y | — | Y |
| `attempts.read.all` | Y | — | — |
| `analytics.read` | Y | — | — |

"The own only" and "published only" rows are object-level rules, not extra permissions: a student
reading `/me/coins` passes a `users.read.self` style check enforced by the handler, and a
published filter is applied in the query. `USER_PERMISSIONS` adds individual codes to a user
without changing their role; those are always granted by an `ADMIN` and are audited.

"By flag" is the phase 3 model, and it is the reason the `EDITOR` row carries only the read side:
an editor's write capability is an explicit grant, one row in `user_permissions` per ticked flag,
and a flag that was not ticked grants nothing. The three flags are:

| Flag | Permission code | What it allows |
| --- | --- | --- |
| `manage_questions` | `content.write` | Create and edit exams, subjects, topics, questions and options |
| `manage_tests` | `tests.write` | Create and edit tests, sections and question placement |
| `publish_tests` | `tests.publish` | Publish or archive a test |

Two database triggers keep that model honest: one refuses to grant any of those three codes to an
account that is not an `EDITOR`, and one clears them when an editor is demoted. Changing an
editor's flags ends that editor's sessions in the same transaction, so no token outlives the
capability it was issued under.

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

| Piece | Phase | State |
| --- | --- | --- |
| `users`, `roles`, `permissions`, `user_permissions` tables and the seeded catalog | 1 | Done |
| `role_permissions` table seeded from the matrix above | 2a | Done, by migration |
| Deny-by-default guard: every route declares `@Public`, `@Authenticated` or `@RequirePermissions`, and a test enumerates every handler and fails on an undeclared one | 2a | Done |
| Permissions resolved from the database per request, never from a token | 2a | Done |
| The matrix proven end to end over HTTP: 401 without a token, 403 for a `USER` and an `EDITOR` on a `users.read` route, 200 for an `ADMIN` | 2a | Done |
| Refresh tokens, session list and revoke, password change and reset, deactivation | 2b | Done (API) |
| `USER_REVOKED` and `last_used_at` on sessions, so the account page can show activity | 2b | Done, by migration |
| Role change behind `roles.write`, revoking every session of the user whose role changed | 2b | Done |
| Web screens, cookies and CSRF protection: server-side refresh, httpOnly cookies, an `Origin` check plus a double-submit value on every write, and security headers | 2b | Done |
| Editor capability as explicit grants (the three flags), refused on a non-editor and cleared on demotion | 3 | Done, by migration and triggers |
| User administration: searchable list, detail, editor creation, capability editing, activate/suspend/deactivate, each ending the sessions it invalidates | 3 | Done |
| Exam catalog with object-level ownership: an editor changes only what they created, and subjects and topics inherit their exam's owner | 3 | Done |
| Settings with per-row bounds, and the topic band scale validated as one ordered set | 3 | Done |
| Audit viewer: filter by actor, action and date range, page, and export; read-only by construction and the export is audited | 3 | Done |
| Admin dashboard with real counts of what exists today | 3 | Done |
| Object-level rules for questions, tests and attempts | with the resource (phases 4–5) | Not yet |



## Mobile OTP (phase 2c)

OTP introduces **no new permission codes**, because it introduces no privileged action:

- The sign-up and sign-in routes are `@Public()`: they exist to hand out a first session.
- Every OTP route also carries `OtpGuard`, which answers **404** when `OTP_ENABLED` is false.
  The switch is not a permission, and no role can be given it.
- Linking a mobile to an account is `@Authenticated()` and re-proves the holder through
  `ReauthenticationService` — the current password, a code sent to the account's own verified
  number, or (for an account with no email) a sign-in from the last fifteen minutes; it is never
  `@Public` and never takes the account id from the body — the id comes from the session.
- **The code wins while OTP is on (decision 0053).** A request with no proof fails after five
  wrong proofs in fifteen minutes (`429`), and every wrong proof writes `IDENTITY_REAUTH_FAILED`.
  For an account with no email address, the fresh session is accepted only when `OTP_ENABLED`
  is false or the account has no verified number; with the switch on, a code to the account's
  own number is required, including when adding or removing an identifier. The account page
  offers "Send confirmation code" for those accounts, and the link and unlink forms ask for it.
- Linking and unlinking an email is `@Authenticated()` and re-proves the holder the same way;
  taking away the last identifier an account has is refused, so an account can never become
  unreachable.
- The same rule covers every other change to how somebody signs in: changing a password and
  deactivating an account both ask for the current password (or a code, or the fresh session).
- `signup_grant_requirement` is an ordinary setting row, so changing it needs `settings.write`
  and is audited as `SETTINGS_CHANGED` like every other setting.
- The alert counter and the daily SMS budget are not exposed as routes; they are read from Redis
  by an operator (see `docs/otp-enable-runbook.md`).
