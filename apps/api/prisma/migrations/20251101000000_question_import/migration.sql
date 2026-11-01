-- Phase 4: bulk import staging.
--
-- A file is validated row by row into import_rows before anything is written to the
-- authoring tables. The commit is all or nothing, and import_commits is the idempotency
-- key: a worker that restarts mid-commit finds the row and stops.

CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_by" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "source_key" TEXT NOT NULL,
    "source_name" TEXT NOT NULL,
    "image_key" TEXT,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "committed_questions" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "import_jobs_status_valid" CHECK (
        "status" IN ('QUEUED', 'RUNNING', 'READY', 'REJECTED', 'COMMITTED', 'FAILED')
    ),
    CONSTRAINT "import_jobs_counts_non_negative" CHECK (
        "total_rows" >= 0 AND "valid_rows" >= 0 AND "invalid_rows" >= 0 AND "committed_questions" >= 0
    )
);

CREATE INDEX "import_jobs_created_by_idx" ON "import_jobs" ("created_by");

CREATE TABLE "import_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errors" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "question_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "import_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE,
    CONSTRAINT "import_rows_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE SET NULL,
    CONSTRAINT "import_rows_status_valid" CHECK ("status" IN ('PENDING', 'VALID', 'INVALID', 'IMPORTED')),
    CONSTRAINT "import_rows_row_positive" CHECK ("row_number" >= 1),
    CONSTRAINT "import_rows_errors_array" CHECK (jsonb_typeof("errors") = 'array'),
    CONSTRAINT "import_rows_payload_object" CHECK (jsonb_typeof("payload") = 'object')
);

CREATE UNIQUE INDEX "import_rows_job_row_key" ON "import_rows" ("job_id", "row_number");

CREATE TABLE "import_commits" (
    "job_id" UUID NOT NULL,
    "questions" INTEGER NOT NULL,
    "committed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "import_commits_pkey" PRIMARY KEY ("job_id"),
    CONSTRAINT "import_commits_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE,
    CONSTRAINT "import_commits_questions_positive" CHECK ("questions" > 0)
);

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."import_jobs" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."import_rows" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."import_commits" TO "abhyas_app"', current_schema());
END

$$;
