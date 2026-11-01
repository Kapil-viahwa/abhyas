-- Phase 2a: sessions, email tokens, role permissions and the transactional event outbox.
-- Every rule that must not be bypassable lives here rather than in application code.

-- ---------------------------------------------------------------------------
-- role_permissions (the matrix in docs/permissions.md, as data)
-- ---------------------------------------------------------------------------

CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id"),
    CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE,
    CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE
);

CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions" ("permission_id");

-- ADMIN holds every code; EDITOR holds the content codes only; USER holds attempts.take.
-- Object-level rules ("own only", "published only") are not permission codes and are
-- enforced by the handler that reads the row, never by the token.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON (
    r."code" = 'ADMIN'
    OR (r."code" = 'EDITOR' AND p."code" IN ('content.read', 'content.write', 'tests.read', 'tests.write'))
    OR (r."code" = 'USER' AND p."code" IN ('attempts.take'))
)
WHERE r."code" IN ('ADMIN', 'EDITOR', 'USER');

-- ---------------------------------------------------------------------------
-- sessions (opaque refresh tokens, stored hashed, rotated within a family)
-- ---------------------------------------------------------------------------

CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "rotated_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "device_label" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "sessions_refresh_token_hash_length" CHECK (length("refresh_token_hash") >= 32),
    CONSTRAINT "sessions_expiry_after_issue" CHECK ("expires_at" > "issued_at"),
    CONSTRAINT "sessions_revoke_reason_valid" CHECK (
        "revoke_reason" IS NULL
        OR "revoke_reason" IN (
            'LOGOUT', 'ROTATED', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'PASSWORD_RESET',
            'ACCOUNT_DEACTIVATED', 'ROLE_CHANGED', 'ADMIN_REVOKED'
        )
    ),
    CONSTRAINT "sessions_revoked_at_requires_reason" CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL)),
    CONSTRAINT "sessions_rotation_after_issue" CHECK ("rotated_at" IS NULL OR "rotated_at" >= "issued_at")
);

CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions" ("refresh_token_hash");
CREATE INDEX "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX "sessions_family_id_idx" ON "sessions" ("family_id");

-- ---------------------------------------------------------------------------
-- email_tokens (verification and password reset; hashed, single use)
-- ---------------------------------------------------------------------------

CREATE TABLE "email_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "request_ip" TEXT,

    CONSTRAINT "email_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "email_tokens_purpose_valid" CHECK ("purpose" IN ('VERIFY_EMAIL', 'RESET_PASSWORD')),
    CONSTRAINT "email_tokens_token_hash_length" CHECK (length("token_hash") >= 32),
    CONSTRAINT "email_tokens_expiry_after_creation" CHECK ("expires_at" > "created_at")
);

CREATE UNIQUE INDEX "email_tokens_token_hash_key" ON "email_tokens" ("token_hash");
CREATE INDEX "email_tokens_user_purpose_idx" ON "email_tokens" ("user_id", "purpose");

-- ---------------------------------------------------------------------------
-- domain_events (transactional outbox: user.registered and later wallet events)
-- ---------------------------------------------------------------------------

CREATE TABLE "domain_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "domain_events_name_format" CHECK ("name" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$'),
    CONSTRAINT "domain_events_payload_object" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "domain_events_attempts_non_negative" CHECK ("attempts" >= 0)
);

CREATE INDEX "domain_events_occurred_at_idx" ON "domain_events" ("occurred_at");

-- ---------------------------------------------------------------------------
-- The application's database role: owns nothing, is not a superuser, and may
-- read and append to audit_logs but never rewrite it.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abhyas_app') THEN
        CREATE ROLE "abhyas_app" NOLOGIN;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO "abhyas_app"', current_schema());
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I."audit_logs" FROM "abhyas_app"', current_schema());
END

$$;
