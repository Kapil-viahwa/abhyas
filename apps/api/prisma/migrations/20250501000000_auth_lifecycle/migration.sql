-- Phase 2b: the session lifecycle (a last-used stamp and user-initiated revocation)
-- and the password-reset flow. Every rule that must not be bypassable stays here.

-- When a session was last used, so the account page can show "last seen" per device.
ALTER TABLE "sessions" ADD COLUMN "last_used_at" TIMESTAMPTZ(6);

-- Existing rows are stamped with the moment they were issued: the honest answer,
-- since nothing recorded their later use.
UPDATE "sessions" SET "last_used_at" = "issued_at" WHERE "last_used_at" IS NULL;

ALTER TABLE "sessions" ALTER COLUMN "last_used_at" SET DEFAULT now();
ALTER TABLE "sessions" ALTER COLUMN "last_used_at" SET NOT NULL;

ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_last_used_after_issue" CHECK ("last_used_at" >= "issued_at");

-- A person ending their own sessions from the account page is not an administrator
-- action, and the audit trail must be able to tell the two apart.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_revoke_reason_valid";

ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_revoke_reason_valid" CHECK (
        "revoke_reason" IS NULL
        OR "revoke_reason" IN (
            'LOGOUT', 'ROTATED', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'PASSWORD_RESET',
            'ACCOUNT_DEACTIVATED', 'ROLE_CHANGED', 'ADMIN_REVOKED', 'USER_REVOKED'
        )
    );

-- The application role may use the new column and reason.
DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."sessions" TO "abhyas_app"', current_schema());
END

$$;
