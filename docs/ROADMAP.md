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
| 2c | Mobile OTP, fully built but disabled by default behind `OTP_ENABLED` | Next |
| 5 | Coins: ledger rules, daily grant, attempt charges, admin adjustments | Planned |
| 6 | Test builder and enrollment: papers, sections, question selection, snapshot | Planned |
| 7 | CBT engine: attempts, timers, autosave, submission, snapshot-scoped media | Planned |
| 8 | Results, analytics and dashboards | Planned |
| 9 | Hardening and launch: real SMTP, a real S3 signature/expiry integration test, Nginx, non-root containers, CSP nonce, load test, backups, monitoring, and making the repository private again | Planned |

## Launch-blocking items

These cannot be proven in CI and must be done before real students use the platform:

- A manual staging test with a real SMS provider (Phase 2c runbook, `docs/otp-enable-runbook.md`).
- A real SMTP provider delivering verification and reset mail.
- An integration test against the production S3-compatible service proving a tampered or
  expired presigned URL is refused (decision 0044).
