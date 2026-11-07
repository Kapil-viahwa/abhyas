# Phase 7 — the attempt engine

The specification and the setup record for phase 7, kept in the repository so a later session
can resume from the repository alone. This document, `docs/decisions.md` 0074 and the phase 7
queue in `docs/NEXT-TASKS.md` are the whole of the setup; no feature is built here.

Phase 6 made a mock test a sellable product: an editor assembles a paper, an Administrator
publishes it, and a student pays coins to enroll. Phase 7 is what happens after the payment —
the student starts the attempt, the server runs the clock, the paper is submitted once, and a
result exists. Results, analytics and dashboards beyond one student's own result are phase 8.

## Rules the owner has decided

1. **The server owns the clock.** Starting an attempt computes `deadline_at = started_at +
   test_version.duration_minutes` on the server and stores it. The browser shows a countdown but
   is never trusted: the browser's clock, a paused tab, a manipulated timer or a slow page change
   nothing about when the attempt ends.
2. **Answers are saved only on submit.** There is no autosave and no partial-save endpoint. The
   answer set exists only in the submit request.
3. **An attempt that is not submitted is auto-submitted at the deadline.** The server ends it and
   scores it. Because answers are only saved on submit, an attempt the server ends on the
   student's behalf has **an empty answer set**: every question is unattempted and the score is
   zero. Closing the browser, losing the connection or walking away scores zero, by design.
4. **One start per enrollment, and no resume.** Starting delivers the paper once. A second start,
   a second fetch of the questions, or a reload never re-delivers the paper and never restarts
   the clock. Ending the attempt moves the enrollment to `COMPLETED` (submitted) or `EXPIRED`
   (auto-submitted); a new attempt needs a new enrollment, which is a new 100-coin payment.
5. **Scoring.** A correct answer earns the version's `marks_per_question`; a wrong answer loses
   the version's `negative_marks_per_question`; an unattempted question scores zero. Only
   single-correct questions are in a paper, so there is no partial marking. `accuracy = correct ÷
   attempted`, and zero attempted gives zero rather than a division error. The scoring function
   is **pure** — a function of (version, submitted answers) and nothing else — unit-tested on its
   own, and the single place in the codebase that turns answers into marks.
6. **Answer keys and explanations stay on the server until the attempt has ended.** Before it
   ends, no response carries `is_correct`, a numerical answer or an explanation. After it has
   ended, the student may read their own result and review their own paper.
7. **Questions are delivered in the version's order.** There is no shuffling in this phase.

## Assumptions recorded for the owner to confirm

Written down in `docs/decisions.md` 0074 as "assumed, owner to confirm". Work does not block on
them; each is reversible without a rewrite of the data model.

- **A small grace window after the deadline.** A submit that arrives up to
   `attempt_submit_grace_seconds` (default **5**, a setting) after `deadline_at` is accepted, to
   cover network latency. After that the server's own auto-submit has already ended the attempt
   and a late submit is refused with a clear message rather than silently discarded.
- **Auto-submit runs in the existing worker, and also lazily.** A sweeper job in `apps/worker`
  (the same repeatable-job, row-lock and idempotency patterns as the bulk-coin drain) finds
  attempts past their deadline at least every 30 seconds and ends them. The same ending also
  happens lazily on any read or submit of an expired attempt, so the result never depends on the
  worker being up.
- **A reload mid-test ends access to the paper.** The page warns before leaving; once the
  attempt is ended there is no resume and no refund.
- **Autosave is deferred, the table is not.** "Answers saved only on submit" is the owner's
  decision, and its consequence (closing the browser scores zero) is accepted. The data model
  still keeps an attempt-answers table so autosave can be added later as a write path, not a
  rewrite. No autosave endpoint is built now.
- **One open attempt per enrollment, one result per attempt.** Enforced by unique indexes and
  triggers, so two workers, a submit racing the sweeper, or a double-clicked submit produce
  exactly one result.

## Audit: what already exists

Read from the code on `main` at `1133d76`, not only from the docs. Phase 7 builds on these; it
duplicates none of them.

**Enrollments are already the unit of purchase.** `enrollments` carries `test_id`,
`test_version_id`, `user_id`, `attempt_number`, `status` (`OPEN`, `COMPLETED`, `EXPIRED`),
`coin_transaction_id`, its idempotency key and `completed_at`. Three unique indexes matter here:
one debit per enrollment (`enrollments_coin_transaction_key`), a new attempt number per retake
(`enrollments_user_test_attempt_key`), and **one `OPEN` enrollment per (user, test)**
(`enrollments_one_open_per_test`, a partial index). A trigger refuses a version that is not the
enrollment's test's or a ledger row that is not this student's `ENROLLMENT`. Phase 7 therefore
hangs an attempt off an existing enrollment; it does not need a second purchase record.

**The sold paper is frozen.** `test_versions` holds `duration_minutes`, `marks_per_question` and
`negative_marks_per_question` and is frozen by trigger once `published_at` is set; `test_questions`
holds the ordered list (`UNIQUE (test_version_id, position)` and `UNIQUE (test_version_id,
question_id)`) and is frozen with its version. An enrollment points at a version, so the paper a
student sat never changes under them; an edit opens a new version (decision 0070).

**Answer keys live in the content tables, not in a separate secret table.**
`question_options.is_correct` is a boolean on each option, and `question_versions` carries
`numerical_answer` and `explanation_html`; a deferred trigger enforces exactly one correct option
for an `MCQ`. Neither is protected by encryption or by a separate table: it is protected by
**projection** — every student-facing route selects a whitelist of fields
(`enrollments.service.ts`'s `TEST_SUMMARY_SELECT`, `TEST_VERSION_SELECT`, `CATALOG_ROW_SELECT`),
and the enrollment tests assert that no `isCorrect`, `explanationHtml`, `answerKey` or
`createdBy` appears in any catalog, detail or enrollment answer. Phase 7 has to keep that
property: the start response selects question text, options and positions and never selects
`is_correct`; only the post-end result selects it.

**The coin ledger is append-only and single-writer.** `CoinService` in the API is the only
writer, inside transactions that lock the wallet row, and every intent carries an idempotency
key. `CoinService.spendWithin` lets enrollment debit inside its own transaction
(decision 0072). Phase 7 charges nothing new; it ends what phase 6 sold.

**The worker is a maintenance queue, not a webhook.** `apps/worker` runs one BullMQ queue
(`MAINTENANCE_QUEUE`) with `concurrency: 1`; the repeatable jobs (`otp.purge`, `coin-bulk-drain`
every 30 s, `coin-reconciliation` daily) are *declarations* kept in Redis by BullMQ, so a
restarted or duplicated worker does not double the schedule. The bulk-coin drain is a **poller
over database state**: it finds `QUEUED`/`RUNNING` job rows, asks the API's internal route
(guarded by `INTERNAL_API_SECRET`, 404 without it) to run a batch, and recovers from a kill by
asking again because every per-person write is keyed. Phase 7's deadline sweeper should follow
the same shape: a repeatable job every 30 seconds, a database-state query, and work done through
the API's own service so there is still one writer.

**Settings are typed rows with bounds.** A new setting is an `INSERT` in a migration with
`value_type`, a default, `min_int`/`max_int` and a description, editable through
`/admin/settings` behind `settings.write` and audited. That is how
`default_enrollment_cost` (100) exists today.

**The student screens end at enrollment.** `/tests` lists published papers with the caller's own
state; `/tests/<id>` shows the pattern, the cost, the balance and the enroll form; after
enrolling the page says the attempt is ready and that taking it is the next phase. `/wallet`
shows the `ENROLLMENT` row. Both pages are server-checked with `loadSession` and render an error
sentence rather than throwing.

## Audit: what is missing

- **No `attempts`, `attempt_answers` or `results` table**, no migration and no Prisma model. An
  `OPEN` enrollment is currently closed only by direct SQL in a test.
- **No deadline anywhere.** `duration_minutes` exists on the version, but nothing computes or
  stores `started_at + duration`, and nothing ends an attempt when it passes.
- **No scoring.** No function computes marks, correct/wrong/unattempted or accuracy; phase 8's
  rule (accuracy = correct ÷ attempted) is written down but unbuilt.
- **No attempt API and no student route** that returns a paper. Nothing outside the editor
  screens ever selects a question.
- **No sweeper.** The worker's job table has three jobs and none of them touch attempts.
- **No test-taking or result pages**, no countdown, no submit confirmation, no leave warning.

## The data model phase 7 adds

One migration (A1), in the style of the existing ones: hand-written SQL, CHECKs, triggers,
partial indexes and grants to `abhyas_app` in a `DO` block. No existing table is duplicated; the
attempt hangs off `enrollments`, the answers off the attempt, the result off the attempt.

- `attempts` — `id`, `enrollment_id` (`UNIQUE`, FK `enrollments`, `ON DELETE RESTRICT`),
  `started_at`, `deadline_at`, `status` (`IN_PROGRESS`, `SUBMITTED`, `AUTO_SUBMITTED`),
  `submitted_at` (nullable), `submit_source` (`STUDENT`/`SWEEPER`/`LAZY`, nullable until it
  ends), timestamps. CHECK `deadline_at > started_at`; one attempt per enrollment by the unique
  index; an index on `(status, deadline_at)` for the sweeper's query.
- `attempt_answers` — `id`, `attempt_id` (FK cascade), `question_id` (FK restrict),
  `chosen_option_id` (nullable, FK restrict). `UNIQUE (attempt_id, question_id)` so one answer
  per question; a trigger (or the service, backed by the unique index) refuses a question that
  is not in the attempt's version and an option that is not that question's.
- `results` — `id`, `attempt_id` (`UNIQUE`, FK restrict), `correct`, `wrong`, `unattempted`,
  `attempted`, `score` (`NUMERIC(8,2)`), `accuracy` (`NUMERIC(6,4)`), `created_at`. CHECKs make
  every count non-negative and `attempted = correct + wrong`; a trigger refuses `UPDATE` and
  `DELETE`, so a result is immutable once written.
- `attempt_submit_grace_seconds` — a setting, `integer`, default **5**, bounds `0..60`, added by
  the same migration.

## The API phase 7 adds

Every route is self-only: no `userId` appears anywhere, the account is the session's, and a row
that is not the caller's is a 404 rather than a 403.

- `POST /v1/enrollments/:id/attempt` — starts the attempt of an `OPEN` enrollment. Refuses a
  second start (409), a non-open enrollment (409/404), a suspended account (401). Computes
  `deadline_at` on the server and **returns the questions once**, in the version's order, with
  content and options but without `is_correct`, `numerical_answer` or `explanation_html`.
- `POST /v1/attempts/:id/submit` — validates every answer against the attempt's version (a
  question not in the paper or an option not that question's is a 400), accepts a submit up to
  the grace window, and writes the answer rows and one result in one transaction. Idempotent: a
  replay of an ended attempt returns the first result rather than writing a second.
- `GET /v1/attempts/:id` — the caller's own attempt state: status, `started_at`, `deadline_at`,
  remaining seconds computed on the server. **Never the questions**, so a reload cannot re-read
  the paper.
- `GET /v1/attempts/:id/result` — the caller's own result and review, only once the attempt has
  ended; before that, a 409. This is the only student response that carries the answer key and
  the explanation.

Expiry is handled twice, on purpose: **lazily** on any read or submit of an expired attempt, and
by a **sweeper** in the worker. Both run the same service function under a row lock, so two
workers or a submit racing the sweeper still produce exactly one result.

## The web screens phase 7 adds

- `/attempts/<id>` — the taking page: the paper in the version's order, a countdown from the
  server's remaining seconds that re-syncs on every poll and never decides expiry itself, a
  submit confirmation, a warning before leaving, and an automatic redirect to the result when the
  attempt ends.
- `/attempts/<id>/result` — score, accuracy, correct/wrong/unattempted, and the per-question
  review (the student's answer, the correct answer, the explanation) only after the attempt has
  ended.
- The enrollment detail page stops saying "taking it is the next phase" and links to the start.

## The queue

The phase 7 unit order is in `docs/NEXT-TASKS.md`, below the phase 6 items: A1 data model, A2 the
scoring function, A3 the attempt API and expiry, A4 the taking page, A5 the result and review
pages, A6 docs and merge, A7 stop. Each names the test that proves it.

## Out of scope

- Autosave and partial saves: deliberately not built (the owner's decision; the answers table
  keeps the door open).
- Shuffling, per-section timers, multiple-correct questions and partial marking.
- Analytics, dashboards and cohort results: phase 8. This phase computes one student's score.
- A resume-after-reload flow: a reload ends access to the paper, by decision.
