-- Phase 6, P1: the test builder's data model and enrollment.
--
-- A test is the paper an editor assembles from the question bank. Its pattern lives on a
-- version, so publishing freezes what a student enrolled in and editing after that opens a
-- new version instead of rewriting history. Enrollment is the sale: one row here and one
-- ENROLLMENT row in the coin ledger, written together by the API (P4).
--
-- The same migration retires the `publish_tests` editor flag. The owner's decision is that
-- only an Administrator publishes or archives a test, so `tests.publish` stops being an
-- editor capability; question publishing gets its own `content.publish`, which the EDITOR
-- role carries, because publishing a question is a content action and phase 4 already
-- allowed it. Existing editor grants are revoked rather than left to fail a constraint.

-- ---------------------------------------------------------------------------
-- Tests
-- ---------------------------------------------------------------------------

CREATE TABLE "tests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "max_attempts" INTEGER,
    "submitted_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tests_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT,
    CONSTRAINT "tests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "tests_title_not_blank" CHECK (length(btrim("title")) > 0 AND length("title") <= 200),
    CONSTRAINT "tests_status_valid" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'PUBLISHED', 'ARCHIVED')),
    CONSTRAINT "tests_current_version_positive" CHECK ("current_version" >= 1),
    CONSTRAINT "tests_max_attempts_positive" CHECK ("max_attempts" IS NULL OR "max_attempts" >= 1)
);

CREATE INDEX "tests_exam_id_idx" ON "tests" ("exam_id");
CREATE INDEX "tests_created_by_idx" ON "tests" ("created_by");
-- The student catalog reads published tests; the editor list reads one creator's drafts.
CREATE INDEX "tests_status_published_at_idx" ON "tests" ("status", "published_at");
CREATE INDEX "tests_created_by_status_idx" ON "tests" ("created_by", "status");

-- A published or archived test does not go back to being a draft, and it cannot be deleted:
-- the enrollment rows that point at it are a record of something a student paid for.
CREATE OR REPLACE FUNCTION "tests_status_frozen"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."published_at" IS NOT NULL THEN
            RAISE EXCEPTION 'tests: a published test cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."published_at" IS NOT NULL AND NEW."status" IN ('DRAFT', 'SUBMITTED') THEN
        RAISE EXCEPTION 'tests: a published test cannot go back to %', NEW."status";
    END IF;

    NEW."updated_at" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tests_published_frozen"
    BEFORE UPDATE OR DELETE ON "tests"
    FOR EACH ROW EXECUTE FUNCTION "tests_status_frozen"();

-- ---------------------------------------------------------------------------
-- Test versions: the pattern, frozen once published
-- ---------------------------------------------------------------------------

CREATE TABLE "test_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "test_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "marks_per_question" NUMERIC(6, 2) NOT NULL DEFAULT 1,
    "negative_marks_per_question" NUMERIC(6, 2) NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "test_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_versions_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "tests"("id") ON DELETE CASCADE,
    CONSTRAINT "test_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "test_versions_version_positive" CHECK ("version" >= 1),
    -- A paper that runs for zero minutes or for a week is not a mock test.
    CONSTRAINT "test_versions_duration_range" CHECK ("duration_minutes" >= 1 AND "duration_minutes" <= 600),
    CONSTRAINT "test_versions_marks_positive" CHECK ("marks_per_question" > 0 AND "marks_per_question" <= 100),
    CONSTRAINT "test_versions_negative_marks_range" CHECK (
        "negative_marks_per_question" >= 0
        AND "negative_marks_per_question" <= "marks_per_question"
    )
);

CREATE UNIQUE INDEX "test_versions_test_version_key" ON "test_versions" ("test_id", "version");

-- The same rule the question bank uses (`question_versions_frozen`): a published pattern is
-- what an enrolled student was sold, so it can be read and referenced, never rewritten.
CREATE OR REPLACE FUNCTION "test_versions_frozen"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."published_at" IS NOT NULL THEN
            RAISE EXCEPTION 'test_versions: a published version cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."published_at" IS NOT NULL THEN
        RAISE EXCEPTION 'test_versions: a published version cannot be updated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_versions_frozen"
    BEFORE UPDATE OR DELETE ON "test_versions"
    FOR EACH ROW EXECUTE FUNCTION "test_versions_frozen"();

-- ---------------------------------------------------------------------------
-- Test questions: the paper's ordered question list
-- ---------------------------------------------------------------------------

CREATE TABLE "test_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "test_version_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "test_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "test_questions_version_id_fkey" FOREIGN KEY ("test_version_id") REFERENCES "test_versions"("id") ON DELETE CASCADE,
    CONSTRAINT "test_questions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT,
    CONSTRAINT "test_questions_position_positive" CHECK ("position" >= 1)
);

CREATE UNIQUE INDEX "test_questions_version_position_key" ON "test_questions" ("test_version_id", "position");
-- The same question cannot appear twice in one paper.
CREATE UNIQUE INDEX "test_questions_version_question_key" ON "test_questions" ("test_version_id", "question_id");
CREATE INDEX "test_questions_question_id_idx" ON "test_questions" ("question_id");

-- A question's place in a published paper is frozen with the paper, like its options are
-- frozen with a published question version.
CREATE OR REPLACE FUNCTION "test_questions_frozen"() RETURNS trigger AS $$
DECLARE
    parent_published TIMESTAMPTZ;
BEGIN
    SELECT "published_at" INTO parent_published FROM "test_versions"
    WHERE "id" = COALESCE(NEW."test_version_id", OLD."test_version_id");

    IF parent_published IS NOT NULL THEN
        RAISE EXCEPTION 'test_questions: a published paper cannot be changed';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_questions_frozen"
    BEFORE INSERT OR UPDATE OR DELETE ON "test_questions"
    FOR EACH ROW EXECUTE FUNCTION "test_questions_frozen"();

-- ---------------------------------------------------------------------------
-- Enrollments: the student bought one attempt of one paper
-- ---------------------------------------------------------------------------

CREATE TABLE "enrollments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "test_id" UUID NOT NULL,
    "test_version_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "coin_transaction_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "enrollments_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "tests"("id") ON DELETE RESTRICT,
    CONSTRAINT "enrollments_test_version_id_fkey" FOREIGN KEY ("test_version_id") REFERENCES "test_versions"("id") ON DELETE RESTRICT,
    CONSTRAINT "enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- One enrollment is one debit: the ledger row cannot be shared and cannot be deleted.
    CONSTRAINT "enrollments_coin_transaction_id_fkey" FOREIGN KEY ("coin_transaction_id") REFERENCES "coin_transactions"("id") ON DELETE RESTRICT,
    CONSTRAINT "enrollments_status_valid" CHECK ("status" IN ('OPEN', 'COMPLETED', 'EXPIRED')),
    CONSTRAINT "enrollments_attempt_number_positive" CHECK ("attempt_number" >= 1),
    CONSTRAINT "enrollments_idempotency_key_not_blank" CHECK (length(btrim("idempotency_key")) > 0 AND length("idempotency_key") <= 200)
);

CREATE UNIQUE INDEX "enrollments_coin_transaction_key" ON "enrollments" ("coin_transaction_id");
-- A retake is a new enrollment with its own attempt number; the same key cannot be replayed.
CREATE UNIQUE INDEX "enrollments_user_idempotency_key" ON "enrollments" ("user_id", "idempotency_key");
CREATE UNIQUE INDEX "enrollments_user_test_attempt_key" ON "enrollments" ("user_id", "test_id", "attempt_number");

-- One OPEN enrollment per student per test. Two simultaneous submissions cannot both win:
-- the second one meets this index, and the API maps the violation to a 409.
CREATE UNIQUE INDEX "enrollments_one_open_per_test"
    ON "enrollments" ("user_id", "test_id")
    WHERE "status" = 'OPEN';

CREATE INDEX "enrollments_user_status_idx" ON "enrollments" ("user_id", "status");
CREATE INDEX "enrollments_test_status_idx" ON "enrollments" ("test_id", "status");

-- The version an enrollment points at has to be a version of the test it names, and the
-- ledger row it points at has to be this student's, of type ENROLLMENT.
CREATE OR REPLACE FUNCTION "enrollments_consistent"() RETURNS trigger AS $$
DECLARE
    version_test UUID;
    ledger_user UUID;
    ledger_type TEXT;
BEGIN
    SELECT "test_id" INTO version_test FROM "test_versions" WHERE "id" = NEW."test_version_id";
    IF version_test IS NULL OR version_test <> NEW."test_id" THEN
        RAISE EXCEPTION 'enrollments: version % does not belong to test %', NEW."test_version_id", NEW."test_id";
    END IF;

    SELECT "user_id", "type" INTO ledger_user, ledger_type
    FROM "coin_transactions" WHERE "id" = NEW."coin_transaction_id";
    IF ledger_user IS NULL OR ledger_user <> NEW."user_id" THEN
        RAISE EXCEPTION 'enrollments: ledger row % does not belong to this student', NEW."coin_transaction_id";
    END IF;
    IF ledger_type <> 'ENROLLMENT' THEN
        RAISE EXCEPTION 'enrollments: ledger row % is a % row, not an ENROLLMENT', NEW."coin_transaction_id", ledger_type;
    END IF;

    NEW."updated_at" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "enrollments_consistent"
    BEFORE INSERT OR UPDATE OF "test_id", "test_version_id", "user_id", "coin_transaction_id" ON "enrollments"
    FOR EACH ROW EXECUTE FUNCTION "enrollments_consistent"();

-- ---------------------------------------------------------------------------
-- Permissions: question publishing gets its own code; tests.publish is Admin-only
-- ---------------------------------------------------------------------------

INSERT INTO "permissions" ("code", "description") VALUES
    ('content.publish', 'Publish a question version')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."code" IN ('ADMIN', 'EDITOR') AND p."code" = 'content.publish'
ON CONFLICT DO NOTHING;

-- Existing editor grants of `tests.publish` are revoked, not left to trip the trigger on the
-- next write. The rows are capability, not history, so the migration removes them rather than
-- failing the deploy.
DELETE FROM "user_permissions" up
USING "permissions" p, "users" u, "roles" r
WHERE up."permission_id" = p."id"
  AND p."code" = 'tests.publish'
  AND up."user_id" = u."id"
  AND u."role_id" = r."id"
  AND r."code" <> 'ADMIN';

-- The old function treated `tests.publish` as an editor flag. It is now the Administrator's
-- alone, and an editor flag is only ever `content.write` or `tests.write`.
CREATE OR REPLACE FUNCTION "user_permissions_editor_flags_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    code TEXT;
    role_code TEXT;
BEGIN
    SELECT p."code" INTO code FROM "permissions" p WHERE p."id" = NEW."permission_id";

    IF code NOT IN ('content.write', 'tests.write', 'tests.publish') THEN
        RETURN NEW;
    END IF;

    SELECT r."code" INTO role_code
    FROM "users" u
    JOIN "roles" r ON r."id" = u."role_id"
    WHERE u."id" = NEW."user_id";

    IF code = 'tests.publish' THEN
        IF role_code IS DISTINCT FROM 'ADMIN' THEN
            RAISE EXCEPTION 'tests.publish may only be held by an ADMIN account'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF role_code IS DISTINCT FROM 'EDITOR' THEN
        RAISE EXCEPTION 'Editor capability may only be granted to an EDITOR account'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;

$$;

-- A demoted editor loses the capability the old role justified; a demoted administrator loses
-- `tests.publish`, which only an Administrator may hold.
CREATE OR REPLACE FUNCTION "users_clear_editor_flags"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_role TEXT;
BEGIN
    SELECT r."code" INTO new_role FROM "roles" r WHERE r."id" = NEW."role_id";

    IF new_role = 'ADMIN' THEN
        RETURN NEW;
    END IF;

    DELETE FROM "user_permissions" up
    USING "permissions" p
    WHERE up."permission_id" = p."id"
      AND up."user_id" = NEW."id"
      AND p."code" IN ('content.write', 'tests.write', 'tests.publish');

    RETURN NEW;
END;

$$;

-- ---------------------------------------------------------------------------
-- Application role grants
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."tests" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."test_versions" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."test_questions" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."enrollments" TO "abhyas_app"', current_schema());
END
$$;
