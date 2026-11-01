-- Phase 4: questions, their immutable published versions, and their options.
--
-- Everything the rules say must not be bypassable lives here: the answer key, the
-- option count, the numeric answer, and the fact that a published version is frozen.

-- ---------------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------------

CREATE TABLE "questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "topic_id" UUID,
    "created_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "questions_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT,
    CONSTRAINT "questions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT,
    CONSTRAINT "questions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE RESTRICT,
    CONSTRAINT "questions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "questions_status_valid" CHECK ("status" IN ('DRAFT', 'PUBLISHED')),
    CONSTRAINT "questions_current_version_positive" CHECK ("current_version" >= 1)
);

CREATE INDEX "questions_exam_id_idx" ON "questions" ("exam_id");
CREATE INDEX "questions_subject_id_idx" ON "questions" ("subject_id");
CREATE INDEX "questions_topic_id_idx" ON "questions" ("topic_id");
CREATE INDEX "questions_created_by_idx" ON "questions" ("created_by");
CREATE INDEX "questions_status_idx" ON "questions" ("status");

-- The subject has to belong to the exam, and the topic to the subject. Enforced here
-- because a handler is one code path and the data is the thing that must stay true.
CREATE OR REPLACE FUNCTION "questions_catalog_alignment"() RETURNS trigger AS $$
DECLARE
    subject_exam UUID;
    topic_subject UUID;
BEGIN
    SELECT "exam_id" INTO subject_exam FROM "subjects" WHERE "id" = NEW."subject_id";
    IF subject_exam IS NULL OR subject_exam <> NEW."exam_id" THEN
        RAISE EXCEPTION 'questions: subject % does not belong to exam %', NEW."subject_id", NEW."exam_id";
    END IF;

    IF NEW."topic_id" IS NOT NULL THEN
        SELECT "subject_id" INTO topic_subject FROM "topics" WHERE "id" = NEW."topic_id";
        IF topic_subject IS NULL OR topic_subject <> NEW."subject_id" THEN
            RAISE EXCEPTION 'questions: topic % does not belong to subject %', NEW."topic_id", NEW."subject_id";
        END IF;
    END IF;

    NEW."updated_at" = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "questions_catalog_alignment"
    BEFORE INSERT OR UPDATE ON "questions"
    FOR EACH ROW EXECUTE FUNCTION "questions_catalog_alignment"();

-- ---------------------------------------------------------------------------
-- question_versions
-- ---------------------------------------------------------------------------

CREATE TABLE "question_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "question_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "question_type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "content_html" TEXT NOT NULL,
    "explanation_html" TEXT,
    "latex" TEXT,
    "numerical_answer" TEXT,
    "marks" NUMERIC(6, 2) NOT NULL DEFAULT 1,
    "negative_marks" NUMERIC(6, 2) NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(6),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "question_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "question_versions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE,
    CONSTRAINT "question_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "question_versions_type_valid" CHECK ("question_type" IN ('MCQ', 'NUMERICAL')),
    CONSTRAINT "question_versions_language_valid" CHECK ("language" IN ('EN', 'HI')),
    CONSTRAINT "question_versions_difficulty_valid" CHECK ("difficulty" IN ('EASY', 'MEDIUM', 'HARD')),
    CONSTRAINT "question_versions_version_positive" CHECK ("version" >= 1),
    CONSTRAINT "question_versions_marks_range" CHECK ("marks" > 0 AND "marks" <= 100),
    CONSTRAINT "question_versions_negative_marks_range" CHECK ("negative_marks" >= 0 AND "negative_marks" <= 100),
    CONSTRAINT "question_versions_content_not_blank" CHECK (length(btrim("content_html")) > 0),
    CONSTRAINT "question_versions_numerical_answer_shape" CHECK (
        ("question_type" = 'NUMERICAL' AND "numerical_answer" IS NOT NULL AND "numerical_answer" ~ '^-?[0-9]+(\.[0-9]{1,6})?$')
        OR ("question_type" = 'MCQ' AND "numerical_answer" IS NULL)
    )
);

CREATE UNIQUE INDEX "question_versions_question_version_key" ON "question_versions" ("question_id", "version");

-- A published version is frozen: it can be read and referenced, never rewritten.
CREATE OR REPLACE FUNCTION "question_versions_frozen"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."published_at" IS NOT NULL THEN
            RAISE EXCEPTION 'question_versions: a published version cannot be deleted';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD."published_at" IS NOT NULL THEN
        RAISE EXCEPTION 'question_versions: a published version cannot be updated';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "question_versions_frozen"
    BEFORE UPDATE OR DELETE ON "question_versions"
    FOR EACH ROW EXECUTE FUNCTION "question_versions_frozen"();

-- ---------------------------------------------------------------------------
-- question_options
-- ---------------------------------------------------------------------------

CREATE TABLE "question_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "question_version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "option_html" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "image_id" UUID,

    CONSTRAINT "question_options_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "question_options_version_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE,
    CONSTRAINT "question_options_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "media_assets"("id") ON DELETE SET NULL,
    CONSTRAINT "question_options_position_range" CHECK ("position" >= 1 AND "position" <= 6),
    CONSTRAINT "question_options_text_not_blank" CHECK (length(btrim("option_html")) > 0)
);

CREATE UNIQUE INDEX "question_options_version_position_key" ON "question_options" ("question_version_id", "position");

-- Exactly one correct option for an MCQ, between two and six options, and no options
-- at all for a numerical answer. Checked when the transaction commits, so rows can be
-- written option by option.
CREATE OR REPLACE FUNCTION "question_version_answer_key"() RETURNS trigger AS $$
DECLARE
    target UUID;
    version_type TEXT;
    option_count INTEGER;
    correct_count INTEGER;
BEGIN
    target := COALESCE(NEW."question_version_id", OLD."question_version_id");

    SELECT "question_type" INTO version_type FROM "question_versions" WHERE "id" = target;
    IF version_type IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*), count(*) FILTER (WHERE "is_correct") INTO option_count, correct_count
    FROM "question_options" WHERE "question_version_id" = target;

    IF version_type = 'MCQ' THEN
        IF option_count < 2 OR option_count > 6 THEN
            RAISE EXCEPTION 'question_options: an MCQ needs between 2 and 6 options (has %)', option_count;
        END IF;
        IF correct_count <> 1 THEN
            RAISE EXCEPTION 'question_options: an MCQ needs exactly 1 correct option (has %)', correct_count;
        END IF;
    ELSE
        IF option_count <> 0 THEN
            RAISE EXCEPTION 'question_options: a numerical question takes no options (has %)', option_count;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "question_options_answer_key"
    AFTER INSERT OR UPDATE OR DELETE ON "question_options"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "question_version_answer_key"();

-- An option of a published version is frozen with its parent.
CREATE OR REPLACE FUNCTION "question_options_frozen"() RETURNS trigger AS $$
DECLARE
    parent_published TIMESTAMPTZ;
BEGIN
    SELECT "published_at" INTO parent_published FROM "question_versions"
    WHERE "id" = COALESCE(NEW."question_version_id", OLD."question_version_id");

    IF parent_published IS NOT NULL THEN
        RAISE EXCEPTION 'question_options: options of a published version cannot be changed';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "question_options_frozen"
    BEFORE INSERT OR UPDATE OR DELETE ON "question_options"
    FOR EACH ROW EXECUTE FUNCTION "question_options_frozen"();

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."questions" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."question_versions" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."question_options" TO "abhyas_app"', current_schema());
END

$$;
