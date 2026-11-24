-- A small, obviously fake dataset for the backup/restore proof.
--
-- It is written to exercise every mechanism a restore has to carry: the coin ledger and its
-- wallet trigger, an enrollment that references its ENROLLMENT debit, a published and fully
-- pinned paper, an ended attempt with answers and a result, and an auto-submitted attempt with
-- an empty result. Every value is a placeholder — no real name, address or answer key.
--
-- The whole file is one transaction because `question_options_answer_key` is a deferred
-- constraint trigger: it judges the option set at COMMIT, when both options exist.

BEGIN;

-- ---------------------------------------------------------------------------
-- People (roles are seeded by the identity migration)
-- ---------------------------------------------------------------------------

INSERT INTO "users" ("id", "email", "password_hash", "full_name", "role_id", "status", "email_verified_at")
VALUES
    ('11111111-1111-4111-8111-111111111111', 'seed-admin@example.test',   'seed-not-a-real-hash', 'Seed Administrator', (SELECT "id" FROM "roles" WHERE "code" = 'ADMIN'),  'ACTIVE', now()),
    ('22222222-2222-4222-8222-222222222222', 'seed-editor@example.test',  'seed-not-a-real-hash', 'Seed Editor',        (SELECT "id" FROM "roles" WHERE "code" = 'EDITOR'), 'ACTIVE', now()),
    ('33333333-3333-4333-8333-333333333333', 'seed-student-a@example.test', 'seed-not-a-real-hash', 'Seed Student A',   (SELECT "id" FROM "roles" WHERE "code" = 'USER'),   'ACTIVE', now()),
    ('44444444-4444-4444-8444-444444444444', 'seed-student-b@example.test', 'seed-not-a-real-hash', 'Seed Student B',   (SELECT "id" FROM "roles" WHERE "code" = 'USER'),   'ACTIVE', now());

-- ---------------------------------------------------------------------------
-- Catalog: one category, one exam, one subject
-- ---------------------------------------------------------------------------

INSERT INTO "exam_categories" ("id", "name", "slug", "created_by")
VALUES ('55555555-5555-4555-8555-555555555551', 'Seed Category', 'seed-category', '11111111-1111-4111-8111-111111111111');

INSERT INTO "exams" ("id", "category_id", "name", "slug", "created_by")
VALUES ('55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555551', 'Seed Exam', 'seed-exam', '11111111-1111-4111-8111-111111111111');

INSERT INTO "subjects" ("id", "exam_id", "name", "slug", "created_by")
VALUES ('55555555-5555-4555-8555-555555555553', '55555555-5555-4555-8555-555555555552', 'Seed Subject', 'seed-subject', '11111111-1111-4111-8111-111111111111');

-- ---------------------------------------------------------------------------
-- Two questions, each published with two options and one correct answer
-- ---------------------------------------------------------------------------

INSERT INTO "questions" ("id", "exam_id", "subject_id", "created_by", "status", "current_version")
VALUES
    ('66666666-6666-4666-8666-666666666661', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553', '22222222-2222-4222-8222-222222222222', 'PUBLISHED', 1),
    ('66666666-6666-4666-8666-666666666662', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553', '22222222-2222-4222-8222-222222222222', 'PUBLISHED', 1);

-- Versions start unpublished so their options may be written (options of a published version
-- are frozen by `question_options_frozen`).
INSERT INTO "question_versions" ("id", "question_id", "version", "question_type", "language", "difficulty", "content_html", "marks", "negative_marks", "created_by")
VALUES
    ('66666666-6666-4666-8666-666666666671', '66666666-6666-4666-8666-666666666661', 1, 'MCQ', 'EN', 'EASY', '<p>Seed question one</p>', 1.00, 0.25, '22222222-2222-4222-8222-222222222222'),
    ('66666666-6666-4666-8666-666666666672', '66666666-6666-4666-8666-666666666662', 1, 'MCQ', 'EN', 'EASY', '<p>Seed question two</p>', 1.00, 0.25, '22222222-2222-4222-8222-222222222222');

INSERT INTO "question_options" ("id", "question_version_id", "position", "option_html", "is_correct")
VALUES
    ('77777777-7777-4777-8777-777777777771', '66666666-6666-4666-8666-666666666671', 1, '<p>Seed option 1A</p>', true),
    ('77777777-7777-4777-8777-777777777772', '66666666-6666-4666-8666-666666666671', 2, '<p>Seed option 1B</p>', false),
    ('77777777-7777-4777-8777-777777777773', '66666666-6666-4666-8666-666666666672', 1, '<p>Seed option 2A</p>', false),
    ('77777777-7777-4777-8777-777777777774', '66666666-6666-4666-8666-666666666672', 2, '<p>Seed option 2B</p>', true);

UPDATE "question_versions" SET "published_at" = now()
WHERE "id" IN ('66666666-6666-4666-8666-666666666671', '66666666-6666-4666-8666-666666666672');

-- ---------------------------------------------------------------------------
-- One paper, published and pinned
-- ---------------------------------------------------------------------------

INSERT INTO "tests" ("id", "exam_id", "created_by", "title", "status", "current_version", "published_at")
VALUES ('88888888-8888-4888-8888-888888888881', '55555555-5555-4555-8555-555555555552', '22222222-2222-4222-8222-222222222222', 'Seed Paper', 'PUBLISHED', 1, now());

INSERT INTO "test_versions" ("id", "test_id", "version", "duration_minutes", "marks_per_question", "negative_marks_per_question", "created_by")
VALUES ('88888888-8888-4888-8888-888888888882', '88888888-8888-4888-8888-888888888881', 1, 30, 1.00, 0.25, '22222222-2222-4222-8222-222222222222');

INSERT INTO "test_questions" ("id", "test_version_id", "question_id", "question_version_id", "position")
VALUES
    ('88888888-8888-4888-8888-888888888883', '88888888-8888-4888-8888-888888888882', '66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666671', 1),
    ('88888888-8888-4888-8888-888888888884', '88888888-8888-4888-8888-888888888882', '66666666-6666-4666-8666-666666666662', '66666666-6666-4666-8666-666666666672', 2);

-- Publishing is the step that requires every placement to be pinned already.
UPDATE "test_versions" SET "published_at" = now()
WHERE "id" = '88888888-8888-4888-8888-888888888882';

-- ---------------------------------------------------------------------------
-- Student A: wallet, a signup grant, a daily reward and an enrollment charge
-- ---------------------------------------------------------------------------

INSERT INTO "coin_wallets" ("id", "user_id", "balance")
VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000001', '33333333-3333-4333-8333-333333333333', 0),
    ('bbbbbbbb-bbbb-4bbb-8bbb-000000000001', '44444444-4444-4444-8444-444444444444', 0);

INSERT INTO "coin_transactions" ("id", "user_id", "type", "amount", "previous_balance", "new_balance", "idempotency_key", "request_fingerprint")
VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000011', '33333333-3333-4333-8333-333333333333', 'SIGNUP_GRANT', 1000, 0, 1000, 'seed-signup-student-a', repeat('a', 64)),
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000012', '33333333-3333-4333-8333-333333333333', 'DAILY_REWARD', 10, 1000, 1010, 'seed-daily-student-a', repeat('b', 64)),
    ('bbbbbbbb-bbbb-4bbb-8bbb-000000000011', '44444444-4444-4444-8444-444444444444', 'SIGNUP_GRANT', 1000, 0, 1000, 'seed-signup-student-b', repeat('d', 64));

-- The ENROLLMENT debits name the enrollment they paid for at insert time: the ledger is
-- append-only, so there is no second statement that could add the reference later.
INSERT INTO "coin_transactions" ("id", "user_id", "type", "amount", "previous_balance", "new_balance", "reference_type", "reference_id", "idempotency_key", "request_fingerprint")
VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-000000000013', '33333333-3333-4333-8333-333333333333', 'ENROLLMENT', -100, 1010, 910, 'enrollment', '99999999-9999-4999-8999-999999999991', 'seed-enroll-student-a', repeat('c', 64)),
    ('bbbbbbbb-bbbb-4bbb-8bbb-000000000012', '44444444-4444-4444-8444-444444444444', 'ENROLLMENT', -100, 1000, 900, 'enrollment', '99999999-9999-4999-8999-999999999992', 'seed-enroll-student-b', repeat('e', 64));

-- The enrollment names the debit that paid for it; `enrollments_consistent` proves the pair.
INSERT INTO "enrollments" ("id", "test_id", "test_version_id", "user_id", "attempt_number", "status", "coin_transaction_id", "idempotency_key", "completed_at")
VALUES
    ('99999999-9999-4999-8999-999999999991', '88888888-8888-4888-8888-888888888881', '88888888-8888-4888-8888-888888888882', '33333333-3333-4333-8333-333333333333', 1, 'COMPLETED', 'aaaaaaaa-aaaa-4aaa-8aaa-000000000013', 'seed-enroll-student-a', now()),
    ('99999999-9999-4999-8999-999999999992', '88888888-8888-4888-8888-888888888881', '88888888-8888-4888-8888-888888888882', '44444444-4444-4444-8444-444444444444', 1, 'COMPLETED', 'bbbbbbbb-bbbb-4bbb-8bbb-000000000012', 'seed-enroll-student-b', now());

-- ---------------------------------------------------------------------------
-- Student A: an attempt that was answered and submitted, then scored
-- ---------------------------------------------------------------------------

INSERT INTO "attempts" ("id", "enrollment_id", "user_id", "test_version_id", "deadline_at", "status")
VALUES ('cccccccc-cccc-4ccc-8ccc-000000000001', '99999999-9999-4999-8999-999999999991', '33333333-3333-4333-8333-333333333333', '88888888-8888-4888-8888-888888888882', now() + interval '30 minutes', 'IN_PROGRESS');

INSERT INTO "attempt_answers" ("id", "attempt_id", "question_id", "chosen_option_id")
VALUES ('dddddddd-dddd-4ddd-8ddd-000000000001', 'cccccccc-cccc-4ccc-8ccc-000000000001', '66666666-6666-4666-8666-666666666661', '77777777-7777-4777-8777-777777777771');

UPDATE "attempts"
SET "status" = 'SUBMITTED', "submitted_at" = now(), "submit_source" = 'STUDENT'
WHERE "id" = 'cccccccc-cccc-4ccc-8ccc-000000000001';

INSERT INTO "results" ("id", "attempt_id", "score", "correct_count", "wrong_count", "unattempted_count", "attempted_count", "total_questions", "total_marks", "accuracy")
VALUES ('eeeeeeee-eeee-4eee-8eee-000000000001', 'cccccccc-cccc-4ccc-8ccc-000000000001', 1.00, 1, 0, 1, 1, 2, 2.00, 1.0000);

-- ---------------------------------------------------------------------------
-- Student B: the deadline ended the attempt with nothing answered
-- ---------------------------------------------------------------------------

INSERT INTO "attempts" ("id", "enrollment_id", "user_id", "test_version_id", "deadline_at", "status")
VALUES ('cccccccc-cccc-4ccc-8ccc-000000000002', '99999999-9999-4999-8999-999999999992', '44444444-4444-4444-8444-444444444444', '88888888-8888-4888-8888-888888888882', now() + interval '30 minutes', 'IN_PROGRESS');

UPDATE "attempts"
SET "status" = 'AUTO_SUBMITTED', "submitted_at" = now(), "submit_source" = 'SWEEPER'
WHERE "id" = 'cccccccc-cccc-4ccc-8ccc-000000000002';

INSERT INTO "results" ("id", "attempt_id", "score", "correct_count", "wrong_count", "unattempted_count", "attempted_count", "total_questions", "total_marks", "accuracy")
VALUES ('eeeeeeee-eeee-4eee-8eee-000000000002', 'cccccccc-cccc-4ccc-8ccc-000000000002', 0.00, 0, 0, 2, 0, 2, 2.00, 0.0000);

COMMIT;
