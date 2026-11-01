-- Phase 0: the smallest table that proves the migration pipeline and DB-enforced
-- constraints work. Hand-written SQL, because constraints are the point.

CREATE TABLE "app_metadata" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_metadata_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_metadata_key_not_blank" CHECK (length(btrim("key")) > 0),
    CONSTRAINT "app_metadata_value_max_length" CHECK (length("value") <= 1000)
);

CREATE UNIQUE INDEX "app_metadata_key_key" ON "app_metadata"("key");
