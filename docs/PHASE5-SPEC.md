# Phase 5 — coins

The specification for phase 5, kept in the repository so a later session can resume from
the repository alone. The wording below is the specification as it was given, unchanged.

## Rules (decided)

students get 1,000 coins once per person; +10 coins once per calendar day (Asia/Kolkata)
on first successful sign-in; one attempt costs 100 coins (editable per test later); only
Admin can add or deduct coins; no refunds after enrollment. Settings already exist:
signup_coins, daily_reward_coins, default_enrollment_cost, signup_grant_requirement.

## ITEM 1: wallet and ledger (database first)

- coin_wallets (one per user, balance integer, CHECK balance >= 0) and coin_transactions
  (append-only): id, user_id, type (SIGNUP_GRANT, DAILY_REWARD, ADMIN_CREDIT,
  ADMIN_DEBIT, ENROLLMENT, other later), signed amount (CHECK amount <> 0),
  previous_balance, new_balance, CHECK new_balance = previous_balance + amount,
  reference_type, reference_id, description, created_by, idempotency_key,
  request_fingerprint (hash of type, amount and reference), created_at. UNIQUE
  (user_id, idempotency_key). A trigger rejects UPDATE and DELETE on the ledger and the
  application role has no UPDATE or DELETE privilege on it; a trigger also checks that
  previous_balance equals the wallet's current balance and updates the wallet in the
  same statement, so the wallet cannot drift from the ledger.
- ONE CoinService is the only code that writes the ledger: spend and credit run in a
  database transaction that locks the wallet row (SELECT ... FOR UPDATE), take an
  idempotency key, never accept a balance from a client, and refuse to go below zero.
  Reusing an idempotency key with the SAME fingerprint returns the original result and
  changes nothing; reusing it with a DIFFERENT amount, type or reference is refused with
  409 and audited.
- Tests: CHECK constraints, append-only triggers, role privileges, previous_balance
  mismatch rejected, idempotent replay, key reuse with a different amount refused, 50
  parallel spends against a balance that affords only 10 charge exactly 10, balance never
  negative.

## ITEM 2: grants and daily reward

- Wallet creation and the signup grant happen when the first identifier is verified,
  according to signup_grant_requirement: 'email' grants when the email is verified,
  'mobile' grants when the first mobile is verified (OTP). One grant per user (unique),
  and one per person: the existing unique first_verified_mobile or the unique normalized
  email stops a second account from earning it again. Existing accounts get a one-time,
  idempotent backfill job.
- Daily reward: on the first successful sign-in of each Asia/Kolkata day (password or
  OTP), insert into daily_rewards with UNIQUE (user_id, reward_date) and the ledger row
  in one transaction; ON CONFLICT DO NOTHING so parallel sign-ins from many devices pay
  once. Amount from daily_reward_coins. Only verified, active accounts earn it.
- Tests: grant once even with parallel verification calls; second account with the same
  mobile gets nothing; daily reward once with 10 parallel sign-ins; the next IST day pays
  again (use an injectable clock around the 00:00 IST boundary); suspended or unverified
  accounts earn nothing.

## ITEM 3: admin tools (Admin only; Editor and User get 403, proven by the route-access test and a sweep test)

- Single add or deduct with a mandatory remark, per-operation cap from a setting, no
  deduction below zero, audited.
- Bulk assignment: choose users by search and multi-select, by filter (signup date range,
  status), or by uploading a CSV of mobiles or emails. Show a preview (matched users,
  unmatched rows, total coins), require confirmation, then run as a BullMQ job in the
  worker. Each user gets its own ledger row with idempotency key <bulk_job_id>:<user_id>,
  so a retry never double credits. Status screen with per-row success or failure and a
  downloadable report (cells starting with = + - @ neutralised). Maximum users and coins
  per job from settings. Test: a job killed halfway and resumed credits every user
  exactly once.
- Admin ledger viewer per user (paginated, filterable by type and date), exportable with
  the export audited.

## ITEM 4: student wallet screens and reconciliation

- Wallet page: balance, total earned, total spent, filtered history with pagination,
  today's daily reward status. Admin pages for the tools above. Nothing hidden by URL
  only: server-side role checks.
- Nightly reconciliation job: recompute each wallet from the ledger, compare with the
  balance, increment an alert counter and write an audit row on any mismatch; test with a
  deliberately corrupted wallet.
- Playwright: new student verifies and sees 1,000 coins; sign-in shows the daily reward
  once; admin credits one user and bulk-credits several from a CSV (including an unmatched
  row); an editor cannot reach the coin pages.

## ITEM 5: docs and report

- Update docs/permissions.md, docs/decisions.md, Known gaps, PROGRESS.md claim table with
  run links, and docs/ROADMAP.md.
