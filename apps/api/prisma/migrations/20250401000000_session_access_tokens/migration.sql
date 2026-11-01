-- Phase 2a: opaque access tokens, stored only as a hash on the session row.
-- Both columns are nullable so a session row can exist without an issued access token
-- (for example one created by a test); the API always sets both together.

ALTER TABLE "sessions" ADD COLUMN "access_token_hash" TEXT;
ALTER TABLE "sessions" ADD COLUMN "access_expires_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "sessions_access_token_hash_key" ON "sessions" ("access_token_hash")
    WHERE "access_token_hash" IS NOT NULL;

ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_access_token_pair" CHECK (("access_token_hash" IS NULL) = ("access_expires_at" IS NULL)),
    ADD CONSTRAINT "sessions_access_expiry_after_issue" CHECK (
        "access_expires_at" IS NULL OR "access_expires_at" > "issued_at"
    );

-- The application role may use the new columns.
DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."sessions" TO "abhyas_app"', current_schema());
END

$$;
