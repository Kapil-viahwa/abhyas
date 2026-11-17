-- ---------------------------------------------------------------------------
-- Phase 7, A5b: a published paper pins the question version it froze
--
-- Phase 6 froze a paper's own rows — the version, its standings, the ordered question list —
-- but `test_questions` named only a question, not a version of it. Every reader therefore
-- resolved the question's content through `questions.current_version`, which an editor can
-- move: an attempt started on one paper could be scored against another, and a finished
-- attempt's review would show content beside an immutable result (decision 0082).
--
-- This migration adds the pin: `test_questions.question_version_id`. A DRAFT or SUBMITTED
-- paper may leave it null, and the builder keeps showing each question's current version; a
-- paper is pinned by `TestsService.publish` inside the publishing transaction, before the
-- version is stamped, and the trigger below refuses to publish a paper with any unpinned row.
--
-- BACKFILL, and what it means. Every row of a published or archived version is pinned to the
-- question's CURRENT version, because that is the only content the database still has. That
-- is exactly right for a paper whose questions were never edited after it was published. For
-- a paper whose question was edited after publishing it is an approximation: the pin is the
-- content as of this migration, which is what a reader was already seeing. The history cannot
-- be reconstructed from the data, so it is not invented here.
--
-- The backfill writes rows the `test_questions_frozen` trigger guards, so that one trigger is
-- disabled for the duration of the statement and re-enabled immediately after it. `ALTER TABLE
-- ... DISABLE TRIGGER` is used rather than `SET LOCAL session_replication_role = replica`
-- because it needs only table ownership (the migration owner always has it) and not a
-- superuser, which a production database may not give the migration role. Nothing else is
-- disabled; the trigger is active again before the assertions below run.
-- ---------------------------------------------------------------------------

ALTER TABLE "test_questions" ADD COLUMN "question_version_id" UUID;

ALTER TABLE "test_questions"
    ADD CONSTRAINT "test_questions_question_version_id_fkey"
    FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE RESTRICT;

CREATE INDEX "test_questions_question_version_id_idx" ON "test_questions" ("question_version_id");

-- ---------------------------------------------------------------------------
-- Backfill: the papers that are already sold
-- ---------------------------------------------------------------------------

ALTER TABLE "test_questions" DISABLE TRIGGER "test_questions_frozen";

UPDATE "test_questions" AS tq
SET "question_version_id" = (
    SELECT qv."id"
    FROM "questions" AS q
    JOIN "question_versions" AS qv
        ON qv."question_id" = q."id" AND qv."version" = q."current_version"
    WHERE q."id" = tq."question_id"
)
WHERE tq."question_version_id" IS NULL
  AND EXISTS (
      SELECT 1
      FROM "test_versions" AS tv
      WHERE tv."id" = tq."test_version_id" AND tv."published_at" IS NOT NULL
  );

ALTER TABLE "test_questions" ENABLE TRIGGER "test_questions_frozen";

-- ---------------------------------------------------------------------------
-- The pin has to name a version of the same question
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "test_questions_version_matches"() RETURNS trigger AS $$
DECLARE
    pinned_question UUID;
BEGIN
    IF NEW."question_version_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "question_id" INTO pinned_question
    FROM "question_versions" WHERE "id" = NEW."question_version_id";

    IF pinned_question IS NULL THEN
        RAISE EXCEPTION 'test_questions: question version % does not exist', NEW."question_version_id";
    END IF;

    IF pinned_question <> NEW."question_id" THEN
        RAISE EXCEPTION 'test_questions: question version % belongs to question %, not %',
            NEW."question_version_id", pinned_question, NEW."question_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_questions_version_matches"
    BEFORE INSERT OR UPDATE ON "test_questions"
    FOR EACH ROW EXECUTE FUNCTION "test_questions_version_matches"();

-- ---------------------------------------------------------------------------
-- The paper's freeze now covers the pin, and a published paper cannot be unpinned
-- ---------------------------------------------------------------------------

-- The phase 6 function read only the destination parent, so on an UPDATE it took `NEW`'s
-- version and let a row be moved OUT of a published paper. Both ends are checked now: a row
-- cannot appear in, change in, or leave a published paper.
CREATE OR REPLACE FUNCTION "test_questions_frozen"() RETURNS trigger AS $$
DECLARE
    parent_published TIMESTAMPTZ;
    previous_parent_published TIMESTAMPTZ;
BEGIN
    SELECT "published_at" INTO parent_published FROM "test_versions"
    WHERE "id" = COALESCE(NEW."test_version_id", OLD."test_version_id");

    IF parent_published IS NOT NULL THEN
        RAISE EXCEPTION 'test_questions: a published paper cannot be changed';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT "published_at" INTO previous_parent_published FROM "test_versions"
        WHERE "id" = OLD."test_version_id";

        IF previous_parent_published IS NOT NULL THEN
            RAISE EXCEPTION 'test_questions: a published paper cannot be changed';
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Publishing is the moment a paper becomes history. It is refused while any placement is
-- unpinned, so a published or archived version can never hold one and no reader has to
-- choose between a pin and a moving pointer.
CREATE OR REPLACE FUNCTION "test_versions_pinned_before_publish"() RETURNS trigger AS $$
DECLARE
    unpinned INTEGER;
BEGIN
    IF NEW."published_at" IS NOT NULL AND OLD."published_at" IS NULL THEN
        SELECT count(*) INTO unpinned
        FROM "test_questions"
        WHERE "test_version_id" = NEW."id" AND "question_version_id" IS NULL;

        IF unpinned > 0 THEN
            RAISE EXCEPTION 'test_versions: % question(s) of this paper are not pinned to a question version', unpinned;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_versions_pinned_before_publish"
    BEFORE UPDATE ON "test_versions"
    FOR EACH ROW EXECUTE FUNCTION "test_versions_pinned_before_publish"();

-- ---------------------------------------------------------------------------
-- Assertions: what the backfill was supposed to leave behind
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    unpinned INTEGER;
    mismatched INTEGER;
BEGIN
    SELECT count(*) INTO unpinned
    FROM "test_questions" tq
    JOIN "test_versions" tv ON tv."id" = tq."test_version_id"
    WHERE tv."published_at" IS NOT NULL AND tq."question_version_id" IS NULL;

    IF unpinned > 0 THEN
        RAISE EXCEPTION 'test_questions: % row(s) of published papers are unpinned after the backfill', unpinned;
    END IF;

    SELECT count(*) INTO mismatched
    FROM "test_questions" tq
    JOIN "question_versions" qv ON qv."id" = tq."question_version_id"
    WHERE qv."question_id" <> tq."question_id";

    IF mismatched > 0 THEN
        RAISE EXCEPTION 'test_questions: % pinned row(s) name another question''s version', mismatched;
    END IF;
END
$$;
