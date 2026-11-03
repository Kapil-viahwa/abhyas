# Roadmap

The phase order this repository is being built in. Each phase is one branch, one pull
request, and merges only when every CI job is green on its latest commit.

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Walking skeleton: monorepo, health, docs, nine CI jobs | Merged |
| 1 | Architecture plan and the identity foundation | Merged |
| 2a | Registration, verification, sign-in, sessions, deny-by-default guard | Merged |
| 2b | Session and password lifecycle, cookie-only web screens, security headers | Merged |
| 3 | Administration, the exam catalog, settings, audit viewer, public SEO pages | Merged |
| 4 | Object storage and upload pipeline, question model and versioning, sanitiser, question API and editor | Merged (PR #16, `0a677c5`) |
| 4b | The rest of Phase 4: media-reference link table, media view route, CSV import, ZIP import, phase docs | Owed — see `docs/PHASE4-CHECKLIST.md` |
| 2c | Mobile OTP, fully built but disabled by default behind `OTP_ENABLED` | In progress (PR #18): items 1–5 built. The `e2e` job proves both modes — the default stack answers 404 and hides the screens, then a stack started with `docker-compose.otp.yml` is driven through registration, sign-in, linking, the wrong-code lockout and the resend countdown (decision 0051). The runbook's manual staging test (`docs/otp-enable-runbook.md`, §7) is owed — see `docs/PHASE2C-SPEC.md` |
| 5 | Coins: ledger rules, daily grant, attempt charges, admin adjustments | Planned |
| 6 | Test builder and enrollment: papers, sections, question selection, snapshot | Planned |
| 7 | CBT engine: attempts, timers, autosave, submission, snapshot-scoped media | Planned |
| 8 | Results, analytics and dashboards | Planned |
| 9 | Hardening and launch: real SMTP, a real S3 signature/expiry integration test, Nginx, non-root containers, CSP nonce, load test, backups, monitoring, and making the repository private again | Planned |

## Launch-blocking items

These cannot be proven in CI and must be done before real students use the platform:

- A manual staging test with a real SMS provider (Phase 2c runbook, `docs/otp-enable-runbook.md` §7): a real
  Indian number and a real DLT-approved template, run by the owner, with the result recorded in `PROGRESS.md`.
- Nginx in front of the API, overwriting (never appending to) `X-Forwarded-For` and `X-Real-IP`, with the API's
  trusted-proxy policy configured to match. Until then the API trusts a forwarded address it is given, so a browser
  can move out of a per-IP counter; this is why OTP stays switched off in production (Known gaps in `PROGRESS.md`).
- A real SMTP provider delivering verification and reset mail.
- An integration test against the production S3-compatible service proving a tampered or
  expired presigned URL is refused (decision 0044).
