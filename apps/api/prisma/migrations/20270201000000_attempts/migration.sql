-- ---------------------------------------------------------------------------
-- Phase 7, A1: the attempt model
--
-- One attempt per enrollment, the answers given in it, and the result it produced. The
-- attempt hangs off an enrollment (phase 6 already sells one attempt per enrollment) and off
-- a test version (the paper is frozen once published), so nothing here repeats a purchase or
-- a paper.
--
-- The rules the database owns, not the API:
--   * `started_at` is the database's now(), never a value the application sends;
--   * `deadline_at` must be after `started_at`;
--   * `submitted_at` and `submit_source` exist exactly when the attempt is not IN_PROGRESS;
--   * an attempt's user and version are its enrollment's, and cannot change;
--   * IN_PROGRESS may move to SUBMITTED or AUTO_SUBMITTED exactly once, and nothing else;
--   * an answer names a question in the attempt's version and an option of that question,
--     and no answer can be written or changed once the attempt has ended;
--   * a result exists only for an attempt that has ended, and is immutable once written.
--
-- There is no answer-key column here, and no autosave column: `attempt_answers` is a real
-- table so autosave can be added later as a write path, not a rewrite (decision 0074).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Attempts
-- ---------------------------------------------------------------------------

CREATE TABLE "attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "enrollment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "test_version_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "submitted_at" TIMESTAMPTZ(6),
    "submit_source" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attempts_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT,
    CONSTRAINT "attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "attempts_test_version_id_fkey" FOREIGN KEY ("test_version_id") REFERENCES "test_versions"("id") ON DELETE RESTRICT,
    CONSTRAINT "attempts_status_valid" CHECK ("status" IN ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED')),
    CONSTRAINT "attempts_deadline_after_start" CHECK ("deadline_at" > "started_at"),
    -- The two submitted columns are a pair: both null while the attempt runs, both set once it
    -- has ended. One CHECK, so a row can never be half-submitted.
    CONSTRAINT "attempts_submitted_fields" CHECK (
        ("status" = 'IN_PROGRESS' AND "submitted_at" IS NULL AND "submit_source" IS NULL)
        OR ("status" IN ('SUBMITTED', 'AUTO_SUBMITTED') AND "submitted_at" IS NOT NULL AND "submit_source" IS NOT NULL)
    ),
    CONSTRAINT "attempts_submit_source_valid" CHECK (
        "submit_source" IS NULL OR "submit_source" IN ('STUDENT', 'SWEEPER', 'LAZY')
    )
);

-- One attempt per enrollment: starting twice is the database's refusal, not only the handler's.
CREATE UNIQUE INDEX "attempts_enrollment_key" ON "attempts" ("enrollment_id");
CREATE INDEX "attempts_user_id_idx" ON "attempts" ("user_id");
-- The sweeper's query: attempts that are still running, nearest deadline first.
CREATE INDEX "attempts_status_deadline_idx" ON "attempts" ("status", "deadline_at")
    WHERE "status" = 'IN_PROGRESS';

-- The start is the database's. An application that sends a `started_at` (Prisma's model
-- carries it with a default, so a write may include it) is overwritten here, which is what
-- makes "the server owns the clock" true at the storage layer as well as in the handler.
CREATE OR REPLACE FUNCTION "attempts_started_at_from_database"() RETURNS trigger AS $$
BEGIN
    NEW."started_at" := now();
    NEW."created_at" := now();
    NEW."updated_at" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attempts_started_at_from_database"
    BEFORE INSERT ON "attempts"
    FOR EACH ROW EXECUTE FUNCTION "attempts_started_at_from_database"();

-- An attempt's user and version are its enrollment's. The composite read is the guard: the
-- enrollment already proves the pair is one purchase of one paper.
CREATE OR REPLACE FUNCTION "attempts_consistent"() RETURNS trigger AS $$
DECLARE
    enrollment_user UUID;
    enrollment_version UUID;
BEGIN
    SELECT "user_id", "test_version_id" INTO enrollment_user, enrollment_version
    FROM "enrollments" WHERE "id" = NEW."enrollment_id";

    IF enrollment_user IS NULL THEN
        RAISE EXCEPTION 'attempts: enrollment % does not exist', NEW."enrollment_id";
    END IF;
    IF enrollment_user <> NEW."user_id" THEN
        RAISE EXCEPTION 'attempts: the attempt belongs to the enrollment''s student, not %', NEW."user_id";
    END IF;
    IF enrollment_version <> NEW."test_version_id" THEN
        RAISE EXCEPTION 'attempts: the attempt is of the enrollment''s version, not %', NEW."test_version_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attempts_consistent"
    BEFORE INSERT ON "attempts"
    FOR EACH ROW EXECUTE FUNCTION "attempts_consistent"();

-- One way, once: IN_PROGRESS -> SUBMITTED or AUTO_SUBMITTED. Everything else — a second
-- ending, a jump back to IN_PROGRESS, a changed deadline or student — is refused.
CREATE OR REPLACE FUNCTION "attempts_one_way"() RETURNS trigger AS $$
BEGIN
    IF OLD."status" <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'attempts: an ended attempt cannot be changed';
    END IF;

    IF NEW."enrollment_id" <> OLD."enrollment_id"
        OR NEW."user_id" <> OLD."user_id"
        OR NEW."test_version_id" <> OLD."test_version_id"
        OR NEW."started_at" <> OLD."started_at"
        OR NEW."deadline_at" <> OLD."deadline_at"
        OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'attempts: the enrollment, student, version, start and deadline are fixed at start';
    END IF;

    IF NEW."status" NOT IN ('SUBMITTED', 'AUTO_SUBMITTED') THEN
        RAISE EXCEPTION 'attempts: an IN_PROGRESS attempt may only move to SUBMITTED or AUTO_SUBMITTED';
    END IF;

    NEW."updated_at" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attempts_one_way"
    BEFORE UPDATE ON "attempts"
    FOR EACH ROW EXECUTE FUNCTION "attempts_one_way"();

-- ---------------------------------------------------------------------------
-- Attempt answers: only the questions that were answered
-- ---------------------------------------------------------------------------

-- A row exists only for a question the student answered, so `chosen_option_id` is NOT NULL and
-- an unattempted question simply has no row. That is what "answers are saved only on submit"
-- means in the data model, and it is what lets autosave be added later without a rewrite.
CREATE TABLE "attempt_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "chosen_option_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "attempt_answers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attempt_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE,
    CONSTRAINT "attempt_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT,
    CONSTRAINT "attempt_answers_chosen_option_id_fkey" FOREIGN KEY ("chosen_option_id") REFERENCES "question_options"("id") ON DELETE RESTRICT
);

-- One answer per question in an attempt.
CREATE UNIQUE INDEX "attempt_answers_attempt_question_key" ON "attempt_answers" ("attempt_id", "question_id");
CREATE INDEX "attempt_answers_question_id_idx" ON "attempt_answers" ("question_id");

-- The question must be placed in the attempt's version, and the option must be an option of
-- that question. Once the attempt is no longer running, its answers are history.
CREATE OR REPLACE FUNCTION "attempt_answers_guard"() RETURNS trigger AS $$
DECLARE
    target_attempt UUID;
    attempt_status TEXT;
    attempt_version UUID;
    placed INTEGER;
    option_question UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_attempt := OLD."attempt_id";
    ELSE
        target_attempt := NEW."attempt_id";
    END IF;

    SELECT "status", "test_version_id" INTO attempt_status, attempt_version
    FROM "attempts" WHERE "id" = target_attempt;

    IF attempt_status IS NULL THEN
        RAISE EXCEPTION 'attempt_answers: attempt % does not exist', target_attempt;
    END IF;

    IF attempt_status <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'attempt_answers: answers cannot be written or changed once the attempt has ended';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    SELECT count(*) INTO placed
    FROM "test_questions"
    WHERE "test_version_id" = attempt_version AND "question_id" = NEW."question_id";

    IF placed = 0 THEN
        RAISE EXCEPTION 'attempt_answers: question % is not in this attempt''s paper', NEW."question_id";
    END IF;

    SELECT v."question_id" INTO option_question
    FROM "question_options" o
    JOIN "question_versions" v ON v."id" = o."question_version_id"
    WHERE o."id" = NEW."chosen_option_id";

    IF option_question IS NULL THEN
        RAISE EXCEPTION 'attempt_answers: option % does not exist', NEW."chosen_option_id";
    END IF;
    IF option_question <> NEW."question_id" THEN
        RAISE EXCEPTION 'attempt_answers: option % is not an option of question %', NEW."chosen_option_id", NEW."question_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "attempt_answers_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "attempt_answers"
    FOR EACH ROW EXECUTE FUNCTION "attempt_answers_guard"();

-- ---------------------------------------------------------------------------
-- Results: one per attempt, written once
-- ---------------------------------------------------------------------------

CREATE TABLE "results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attempt_id" UUID NOT NULL,
    "score" NUMERIC(8, 2) NOT NULL,
    "correct_count" INTEGER NOT NULL,
    "wrong_count" INTEGER NOT NULL,
    "unattempted_count" INTEGER NOT NULL,
    "attempted_count" INTEGER NOT NULL,
    "total_questions" INTEGER NOT NULL,
    "total_marks" NUMERIC(8, 2) NOT NULL,
    "accuracy" NUMERIC(6, 4) NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "results_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE RESTRICT,
    CONSTRAINT "results_counts_non_negative" CHECK (
        "correct_count" >= 0 AND "wrong_count" >= 0 AND "unattempted_count" >= 0
        AND "attempted_count" >= 0 AND "total_questions" >= 0
    ),
    -- Attempted is exactly what was right plus what was wrong.
    CONSTRAINT "results_attempted_sum" CHECK ("attempted_count" = "correct_count" + "wrong_count"),
    -- Every question in the paper is one of the three, and the paper records how many it had.
    CONSTRAINT "results_total_sum" CHECK (
        "correct_count" + "wrong_count" + "unattempted_count" = "total_questions"
    ),
    CONSTRAINT "results_accuracy_range" CHECK ("accuracy" >= 0 AND "accuracy" <= 1),
    -- Accuracy is correct / attempted, and nothing was attempted: zero, never a division error.
    CONSTRAINT "results_accuracy_zero_when_unattempted" CHECK ("attempted_count" > 0 OR "accuracy" = 0)
);

CREATE UNIQUE INDEX "results_attempt_key" ON "results" ("attempt_id");

-- A result exists only for an attempt that has ended: a running attempt has no score yet.
CREATE OR REPLACE FUNCTION "results_only_after_end"() RETURNS trigger AS $$
DECLARE
    attempt_status TEXT;
BEGIN
    SELECT "status" INTO attempt_status FROM "attempts" WHERE "id" = NEW."attempt_id";

    IF attempt_status IS NULL THEN
        RAISE EXCEPTION 'results: attempt % does not exist', NEW."attempt_id";
    END IF;
    IF attempt_status = 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'results: an attempt that is still running has no result';
    END IF;

    NEW."computed_at" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "results_only_after_end"
    BEFORE INSERT ON "results"
    FOR EACH ROW EXECUTE FUNCTION "results_only_after_end"();

-- A written result is history: no update, no delete, by any writer.
CREATE OR REPLACE FUNCTION "results_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'results: a written result cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "results_immutable"
    BEFORE UPDATE OR DELETE ON "results"
    FOR EACH ROW EXECUTE FUNCTION "results_immutable"();

-- ---------------------------------------------------------------------------
-- Settings: the grace window a late submit is accepted in (decision 0074)
-- ---------------------------------------------------------------------------

INSERT INTO "settings" ("key", "value_type", "value_int", "min_int", "max_int", "description") VALUES
    ('attempt_submit_grace_seconds', 'integer', 5, 0, 60,
     'How long after the deadline a late submit is still accepted, in seconds')
ON CONFLICT ("key") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Application role grants
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I."attempts" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."attempt_answers" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."results" TO "abhyas_app"', current_schema());
END
$$;
