# Phase 2c spec: mobile OTP, fully built but disabled by default

Saved here verbatim so any future session can resume from the repository alone.

## The master switch

- `OTP_ENABLED` environment variable, default false. When false: every OTP route answers **404** (not 403), the web app shows no mobile sign-up, sign-in or linking UI, the SMS provider is never constructed, and no SMS can be sent from any code path. The switch is enforced on the server; hiding UI alone does not count.
- When true: production boot refuses to start unless a real SMS provider is configured. Production also refuses the fake provider, test Turnstile keys, and a missing sender id, DLT entity id or template id. Boot-refusal tests for both configurations.
- CI proves **both** modes: the default suite runs with OTP disabled (the 404s and the hidden UI), and a second configuration runs the OTP tests with the fake provider. Reuse existing jobs or a Playwright project instead of adding many new jobs, to save CI minutes.

## Item 1: data model and SMS provider

- Migration: `otp_requests` (hashed codes only), mobile numbers normalised to E.164 (+91 default) and unique per account, `first_verified_mobile` recorded once per person with a unique constraint, `sms_cost_ledger` (provider, destination hash, cost, request id, date). Constraint tests.
- `SmsProvider` interface with a fake provider (dev and CI only, in-memory outbox) and a generic HTTP gateway adapter configured by environment variables (URL, auth header, body template, timeout), unit-tested against a local mock server. No vendor-specific adapter yet. `docs/sms-provider.md`: what a vendor adapter needs and the India requirements (DLT entity registration, sender id, approved template ids).

## Item 2: OTP service and abuse controls (tests first)

- 6-digit code, stored only as an HMAC with a server secret, 5-minute expiry, 5 verify attempts then invalidated, resend cooldown that escalates, constant-time comparison, the code is never logged (not even in dev; the fake provider outbox is the only place it appears).
- Limits: per number (3 per hour, 8 per day), per IP (10 per hour), per device identifier, a global daily SMS budget with a circuit breaker that stops sending and raises an alert, Turnstile required before any code is sent, allowed country codes configurable (default +91 only).
- Identical responses and similar timing for known and unknown numbers (no enumeration). Anomaly detection: bursts, sequential numbers, many numbers from one IP or network, written to the audit log and exposed as an alert counter.
- Tests: brute force of the code is throttled; code cannot be reused; expired code fails; budget breaker opens; per-number and per-IP caps; enumeration responses match; the code never appears in logs or audit rows.

## Item 3: flows, sessions, linking

- Register by mobile + OTP, sign in by mobile + OTP, resend. A successful OTP sign-in issues the same opaque session as password sign-in, with the same revocation rules, audit rows and rate limits.
- Account linking after login only: adding a mobile (OTP) or an email (verification link) requires re-authentication (current password, or a recent sign-in), never auto-merges two accounts, and answers generically when the identifier belongs to someone else. Every link, unlink and refusal is audited.
- Setting `signup_grant_requirement` ('email' or 'mobile'): default 'email' while OTP is disabled and 'mobile' when OTP is enabled; admin-editable and audited. This phase only stores the setting and the `first_verified_mobile` data; the coin grant itself is built in Phase 5.
- Signup protections that work without OTP: Turnstile on register, per-IP signup limit, a disposable-email domain blocklist (maintained list in the repo with a test).

## Item 4: web screens (all hidden and 404 when `OTP_ENABLED=false`)

- Mobile registration and sign-in with OTP entry, resend timer and clear errors; link-a-mobile in the account page; Turnstile widget (test key in dev and CI only).
- Playwright in both modes: disabled mode shows no mobile UI and the OTP routes return 404; enabled mode (fake provider) completes register, sign-in, link, wrong-code lockout and resend cooldown.

## Item 5: runbook and docs

- `docs/otp-enable-runbook.md`: exact steps to turn OTP on later — buy a provider, complete DLT registration and template approval, add the vendor adapter (or configure the generic gateway), set the environment variables and secrets in GitHub encrypted secrets and the server, set the daily SMS budget, set `OTP_ENABLED=true`, flip `signup_grant_requirement` to mobile, run the verification checklist. Include a manual staging test with a real SMS provider that the owner runs (cannot be proven in CI); record it as launch-blocking in `docs/ROADMAP.md`.
- Update `docs/permissions.md`, `docs/decisions.md`, `PROGRESS.md` (claim table with run links) and the Known gaps list.
