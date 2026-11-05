-- Phase 5, item 3: the records the admin coin tools need.
--
-- A bulk assignment is a job and a row per person. The row is the unit of work and the
-- place a failure is remembered; the ledger row is the money. The idempotency key on the
-- ledger is `<job_id>:<user_id>`, so a job that is killed halfway and run again credits
-- every person exactly once, whatever the job row says.

CREATE TABLE "coin_bulk_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_by" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "remark" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "total_users" INTEGER NOT NULL DEFAULT 0,
    "credited_users" INTEGER NOT NULL DEFAULT 0,
    "failed_users" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "coin_bulk_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coin_bulk_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "coin_bulk_jobs_amount_non_zero" CHECK ("amount" <> 0),
    CONSTRAINT "coin_bulk_jobs_remark_present" CHECK (length(btrim("remark")) > 0),
    CONSTRAINT "coin_bulk_jobs_status_valid" CHECK ("status" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
    CONSTRAINT "coin_bulk_jobs_counts_non_negative" CHECK ("total_users" >= 0 AND "credited_users" >= 0 AND "failed_users" >= 0)
);

CREATE INDEX "coin_bulk_jobs_status_created_at_idx" ON "coin_bulk_jobs" ("status", "created_at");

CREATE TABLE "coin_bulk_job_rows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "coin_transaction_id" UUID,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "coin_bulk_job_rows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coin_bulk_job_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "coin_bulk_jobs"("id") ON DELETE CASCADE,
    CONSTRAINT "coin_bulk_job_rows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "coin_bulk_job_rows_coin_transaction_id_fkey" FOREIGN KEY ("coin_transaction_id")
        REFERENCES "coin_transactions"("id") ON DELETE RESTRICT,
    CONSTRAINT "coin_bulk_job_rows_status_valid" CHECK ("status" IN ('PENDING', 'CREDITED', 'FAILED'))
);

-- One row per person per job: the job cannot name somebody twice and pay them twice.
CREATE UNIQUE INDEX "coin_bulk_job_rows_job_user_key" ON "coin_bulk_job_rows" ("job_id", "user_id");
CREATE UNIQUE INDEX "coin_bulk_job_rows_coin_transaction_id_key" ON "coin_bulk_job_rows" ("coin_transaction_id");
CREATE INDEX "coin_bulk_job_rows_pending_idx" ON "coin_bulk_job_rows" ("job_id") WHERE "status" = 'PENDING';

-- The bounds an Administrator's single operation and bulk job are held to. They are
-- settings so changing them is `settings.write` and audited like every other setting.
INSERT INTO "settings" ("key", "value_type", "value_int", "min_int", "max_int", "description") VALUES
    ('coin_max_adjustment_per_operation', 'integer', 10000, 1, 1000000,
     'The most coins one Administrator add or deduct may move'),
    ('coin_max_bulk_users', 'integer', 5000, 1, 50000,
     'The most accounts one bulk coin assignment may name'),
    ('coin_max_bulk_coins', 'integer', 1000000, 1, 100000000,
     'The most coins one bulk coin assignment may move in total')
ON CONFLICT ("key") DO NOTHING;

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."coin_bulk_jobs" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."coin_bulk_job_rows" TO "abhyas_app"', current_schema());
END

$$;
