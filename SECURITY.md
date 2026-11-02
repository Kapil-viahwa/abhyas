# Security policy

Abhyas handles student accounts, exam content and a coin ledger, so a vulnerability here is
taken seriously even while the project is still being built.

## Reporting a vulnerability

Please report privately, not in a public issue or pull request. Use GitHub's **Report a
vulnerability** button on the Security tab of this repository, which opens a private advisory
only the maintainer can read. If that is unavailable to you, open a minimal issue that asks
for a private channel and says nothing about the details.

Please include the affected area, the steps to reproduce, and what you expected to happen.
Do not include real user data, real credentials, or screenshots of other people's accounts.

## What to expect

An acknowledgement when the report is read, an assessment of severity and scope, a fix on a
branch with a test that reproduces the issue, and credit in the advisory if you want it. Please
give a reasonable window to ship a fix before any public disclosure.

## Out of scope here

- Findings that require a compromised device, a compromised GitHub account, or access to the
  production server.
- Missing hardening already recorded as a known gap in `PROGRESS.md` (Nginx, non-root
  containers, a nonce-based CSP, object storage in CI, the SMTP stub). Those are known, and
  tracked as work rather than as disclosures.

## What is never in this repository

No production secret lives in this repository or in its history. Production values are set in
GitHub's encrypted secrets for CI and in the server's environment for deployment; `.env.example`
contains development placeholders and nothing that works anywhere real. See decision 0047.
