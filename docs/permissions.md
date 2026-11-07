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
| `coins.write` | Use the Administrator coin tools: adjust, bulk assign, read and export |
| `audit.read` | Read the audit log |
| `content.read` | Read content, including unpublished |
| `content.write` | Create and edit exams, subjects, topics, questions and options |
| `tests.read` | Read tests, including drafts |
| `tests.write` | Create and edit tests, sections and question placement |
| `tests.publish` | Publish or archive a test — an Administrator's alone (decision 0069) |
| `content.publish` | Publish a question version |
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
| `coins.write` | Y | — | — |
| `audit.read` | Y | — | — |
| `content.read` | Y | Y | published only |
| `content.write` | Y | by flag | — |
| `tests.read` | Y | Y | published only |
| `tests.write` | Y | by flag | — |
| `tests.publish` | Y | — | — |
| `content.publish` | Y | Y | — |
| `attempts.take` | Y | — | Y |
| `attempts.read.all` | Y | — | — |
| `analytics.read` | Y | — | — |

"The own only" and "published only" rows are object-level rules, not extra permissions: a student
reading `/me/coins` passes a `users.read.self` style check enforced by the handler, and a
published filter is applied in the query. `USER_PERMISSIONS` adds individual codes to a user
without changing their role; those are always granted by an `ADMIN` and are audited.

"By flag" is the phase 3 model, tightened in phase 6: an editor's write capability is an
explicit grant, one row in `user_permissions` per ticked flag, and a flag that was not ticked
grants nothing. There are **two** flags now, because only an Administrator publishes a test
(decision 0069):

| Flag | Permission code | What it allows |
| --- | --- | --- |
| `manage_questions` | `content.write` | Create and edit exams, subjects, topics, questions and options |
| `manage_tests` | `tests.write` | Create, edit and submit tests; the Administrator publishes |

The retired `publish_tests` flag no longer exists: migration `20270101000000` removed its
existing grants, and the trigger refuses any new `tests.publish` grant to a
non-Administrator. Publishing a **question** is `content.publish`, which the `EDITOR` role
itself carries, because publishing content is a content action.

Two database triggers keep that model honest: one refuses the editor write codes on an account
that is not an `EDITOR` (and `tests.publish` on an account that is not an `ADMIN`), and one
clears them when an editor is demoted. Changing an editor's flags ends that editor's sessions
in the same transaction, so no token outlives the capability it was issued under.

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
| `coins.write` on every Administrator coin route: search, adjust, bulk preview/start/status/report, ledger and export; an editor and a student are refused on all of them | 5 | Done, by migration (`20261101000000`) and the sweep in `coins-admin.test.ts` |
| The worker's bulk drain is `@Public()` with a shared-secret check that answers 404, so it carries no session and no permission | 5 | Done |



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



## Phase 5: a student's own wallet

| Route | Declared access | Who may call it | What it returns |
| --- | --- | --- | --- |
| `GET /v1/coins/me` | `@Authenticated` | any signed-in, active account | its own balance, total earned, total spent, today's Asia/Kolkata daily reward state and the next reward date |
| `GET /v1/coins/me/history` | `@Authenticated` | any signed-in, active account | its own ledger page (newest first, type and date filters, page size at most 100), without ids, idempotency keys or fingerprints |

There is no `userId` parameter on either route: the account is the session's. A suspended
account is refused on both. The Administrator tools under `/v1/admin/coins` keep the
`coins.write` permission and are listed above.


## Phase 5: the Administrator's coin screens

The screens under `/admin/coins` are not a second gateway: they are forms that call the
routes above, and the API decides every one of them.

| Screen | Server check before it renders | What it calls |
| --- | --- | --- |
| `/admin/coins` | `coins.write` (`loadPermissionSession`) | `GET /v1/admin/coins/recipients` |
| `/admin/coins/<userId>` | `coins.write` | `GET /v1/admin/users/<id>`, `GET .../ledger`, `POST .../adjust` |
| `/admin/coins/bulk` | `coins.write` | `POST .../bulk/preview` (draft kept in one httpOnly cookie) |
| `/admin/coins/bulk/<jobId>` | `coins.write` | `GET .../bulk/<id>`, `.../bulk/<id>/report` |

An account without `coins.write` is redirected to `/account?denied=1` before the page renders,
and the navigation link exists only for an account that holds it. The web routes
(`/api/admin/coins/adjust`, `/bulk/preview`, `/bulk/confirm`, `/download`) pass the session to
the API and return its refusal; they never hold `coins.write` themselves, so an editor or a
student who posts to one still receives the API's 403. The ID in the URL is never trusted to
grant access to somebody else's ledger — it is an Administrator-only route, and the API checks
the permission before it reads the row.



## Phase 6, P2: building a test

A test is a paper an editor assembles from the question bank. Building needs `tests.write`
(the `manage_tests` flag, or an Administrator); reading needs `tests.read`, which the `EDITOR`
role carries and an Administrator holds with every other code. **Publishing and archiving are
not an editor's actions**: both routes require `tests.publish`, which only an Administrator
holds, so an Editor or a Student is refused with **403** by the guard before any handler runs
(decision 0069).

| Route | Declared access | Who may call it | What it does |
| --- | --- | --- | --- |
| `GET /v1/editor/tests` | `tests.read` | an Editor (own papers), an Administrator (all) | the list, newest first, paged, filterable by `status` and `examId` |
| `GET /v1/editor/tests/:id` | `tests.read` | the paper's creator, or an Administrator | the pattern and the paper's ordered questions, with answer keys |
| `POST /v1/editor/tests` | `tests.write` | an Editor with `manage_tests`, or an Administrator | creates a draft for an exam the caller may write content for |
| `PATCH /v1/editor/tests/:id` | `tests.write` | as above | title, description, duration, marks per question, negative marks, `maxAttempts`; editing a published paper opens a new version (decision 0070) |
| `PUT /v1/editor/tests/:id/questions` | `tests.write` | as above | replaces the paper's whole ordered list; every question must be published, in the paper's exam, and the caller's own unless the caller is an Administrator |
| `POST /v1/editor/tests/:id/submit` | `tests.write` | as above | hands a complete draft, or a revision, over for review |
| `POST /v1/admin/tests/:id/publish` | `tests.publish` | **an Administrator only** | publishes the submitted (or revised) version, freezing it |
| `POST /v1/admin/tests/:id/archive` | `tests.publish` | **an Administrator only** | retires a published test; its enrollments stay |

A foreign paper, or one another editor created, answers **404** rather than 403, so a route
cannot be used to discover which papers exist. A Student is refused on **every** route above,
and no builder response reaches a student: the answer key (`isCorrect`, the explanation and a
numerical question's answer) is serialised only in these Editor and Administrator responses,
never to a student.



## Phase 6, P3: the test-builder screens

The screens are server-checked forms, not a second gateway: every page reads
`loadPermissionSession` before it renders, and every write posts to a web route handler that
passes the session's access token to the API, which decides. The token never reaches the
browser.

| Screen | Server check before it renders | What it calls |
| --- | --- | --- |
| `/editor/tests` | `tests.read` | `GET /v1/editor/tests` — an Editor's own papers, an Administrator's all |
| `/editor/tests/new` | `tests.write` | `POST /v1/editor/tests` |
| `/editor/tests/<id>` | `tests.read` | `GET /v1/editor/tests/<id>`, `PATCH .../<id>`, `PUT .../<id>/questions`, `POST .../<id>/submit`, and for an Administrator `POST /v1/admin/tests/<id>/publish` and `.../archive` |
| `/admin/tests` | `tests.publish` | `GET /v1/editor/tests` as the Administrator's review queue |

The **Publish** and **Archive** controls render only for an account holding `tests.publish`,
which in practice is an Administrator; an Editor never sees them. That is a convenience, not
the rule: the API refuses both routes with **403** whatever the page draws, and the web handler
returns the API's own message. A student is redirected to `/account?denied=1` before any of
these pages renders, the same way the coin screens refuse them.

The navigation link to `/editor/tests` appears for an account holding `tests.read` (the editor
role carries it, and an Administrator has every code), following the coin link's rule
(`apps/web/src/components/admin-shell.tsx`). The answer key — `isCorrect`, the explanation and
a numerical question's answer — is rendered only on `/editor/tests/<id>`, which is
`tests.read` behind the session; no student-facing page renders it in this unit.



## Phase 6, P4: the student catalog and enrollment

Every route below is `@Authenticated()`: a signed-in account, of any role, and nothing more.
**There is no `userId` parameter on any of them** — the account is the session's. The two routes
that could carry one (`POST /v1/tests/:id/enroll` and the reads beside it) refuse a `userId` in the
body *or* the query with **400**, naming it, rather than ignoring it. A suspended account's session
no longer authenticates, so the guard answers **401** before any handler runs; the service also
answers 403 for a non-active row as a second line.

| Route | Declared access | What it does | Refusals |
| --- | --- | --- | --- |
| `GET /v1/tests` | `@Authenticated` | published papers, priced at `default_enrollment_cost`, with the caller's own state per paper | 400 for an unknown/repeated/`userId` query value, or a `pageSize` above 50; 401 anonymous or suspended |
| `GET /v1/tests/:id` | `@Authenticated` | one published paper's summary and pattern, with the caller's own state | 404 for an unknown, draft, submitted or archived paper; 401 |
| `POST /v1/tests/:id/enroll` | `@Authenticated` | buys one attempt: one `ENROLLMENT` debit and one `OPEN` enrollment, in one transaction | 400 for a missing or malformed `Idempotency-Key`, a body field, or an unaffordable price; 401; 404 unknown paper; **409** for a draft, submitted or archived paper, an open enrollment, the attempt cap, or a key already spent on another test |
| `GET /v1/enrollments/me` | `@Authenticated` | the caller's own enrollments, newest first, paged (max 100) | 400 for an unknown/`userId` query value; 401 |

What none of them ever selects, so none of them can leak: a question, an option, `isCorrect`, an
explanation, a numerical answer, a `created_by`, another student's row, a ledger id, an idempotency
key or a request fingerprint. The catalog's answer is a whitelist of summary fields, and the
enrollment's is the caller's own row plus the paper it bought.

`default_enrollment_cost` is the one price, read **inside** the enrollment transaction. A value of
`0` closes enrollment (409) rather than selling a free paper, because a ledger row of zero is
refused by `coin_transactions_amount_non_zero`.



## Phase 6, P5: the student catalog and enroll screens

The screens are server-rendered forms over the P4 routes and hold no rule of their own: they
read the session, call the API with its access token, and print the API's answer. The token
never reaches the browser.

| Screen | Server check before it renders | What it calls |
| --- | --- | --- |
| `/tests` | `loadSession` — any signed-in account; an anonymous visitor is sent to `/login?next=%2Ftests` | `GET /v1/tests`, `GET /v1/enrollments/me` |
| `/tests/<id>` | `loadSession` — anonymous to `/login?next=%2Ftests%2F<id>` | `GET /v1/tests/<id>`, `GET /v1/coins/me` (the balance), and the enroll form posts to `/api/enrollments/enroll` |
| `/api/enrollments/enroll` | `guardFormPost` (Origin + double submit), then the session cookie | `POST /v1/tests/<id>/enroll` |

The enroll form carries one `Idempotency-Key` generated when the page renders. On a refusal the
handler sends the same key back in the redirect, so pressing the button again is the same
request to the API and cannot charge twice; only a fresh page load without the key starts a new
one. The key is not a credential.

Refusals are read from the API's own `code`, never from the status alone — an unaffordable
enrollment and a malformed one are both a 400 — and the page turns the code into a sentence:

| Code | What the student reads |
| --- | --- |
| `insufficient_coins` | not enough coins yet; add coins and retry with the same button, which cannot charge twice |
| `open_enrollment` | an open attempt already exists for this test |
| `attempt_cap_reached` | every attempt this test allows has been used |
| `not_for_sale` | the test is no longer available to enroll in; also used when the platform has set no price |
| anything else | one generic sentence; the API's text is never put in the URL or the page |

Nothing on these screens reads a question, an option, an answer key, an explanation or a
`created_by`: the API's projection has none of them, and the pages render its summary fields
only. `/wallet` already lists the `ENROLLMENT` row (its history includes the type) and its type
filter offers it; the Tests link is added to the account and wallet navigation beside Wallet.
