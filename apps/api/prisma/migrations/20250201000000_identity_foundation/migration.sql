-- Phase 1: identity foundation.
-- users, roles, permissions, user_permissions, settings, audit_logs.
-- Constraints, normalising triggers and append-only rules are deliberately in SQL:
-- the database is the last line of defence and the only place they cannot be bypassed.

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Keeps updated_at truthful for raw SQL writes as well as ORM writes.
CREATE FUNCTION "set_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW."updated_at" := now();
    RETURN NEW;
END;

$$;

-- ---------------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------------

CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "roles_code_format" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
    CONSTRAINT "roles_name_not_blank" CHECK (length(btrim("name")) > 0)
);

CREATE UNIQUE INDEX "roles_code_key" ON "roles" ("code");

CREATE TRIGGER "roles_set_updated_at"
BEFORE UPDATE ON "roles"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

INSERT INTO "roles" ("code", "name", "description", "is_system") VALUES
    ('ADMIN', 'Administrator', 'Full control of the platform', true),
    ('EDITOR', 'Editor', 'Content only: never users, roles, coins or settings', true),
    ('USER', 'Student', 'Takes mock tests', true);

-- ---------------------------------------------------------------------------
-- permissions
-- ---------------------------------------------------------------------------

CREATE TABLE "permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "permissions_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$')
);

CREATE UNIQUE INDEX "permissions_code_key" ON "permissions" ("code");

INSERT INTO "permissions" ("code", "description") VALUES
    ('users.read', 'List and read any user'),
    ('users.write', 'Create, suspend, restore and edit any user'),
    ('roles.write', 'Assign roles and change a role''s permissions'),
    ('permissions.assign', 'Grant or revoke a per-user permission override'),
    ('settings.read', 'Read platform settings'),
    ('settings.write', 'Change platform settings'),
    ('coins.read', 'Read any user''s coin history'),
    ('coins.adjust', 'Add or deduct coins outside the automatic rules'),
    ('audit.read', 'Read the audit log'),
    ('content.read', 'Read content, including unpublished'),
    ('content.write', 'Create and edit exams, subjects, topics, questions and options'),
    ('tests.read', 'Read tests, including drafts'),
    ('tests.write', 'Create and edit tests, sections and question placement'),
    ('tests.publish', 'Publish or archive a test'),
    ('attempts.take', 'Start and submit an attempt'),
    ('attempts.read.all', 'Read any user''s attempts and results'),
    ('analytics.read', 'Read platform analytics');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(6),
    "mobile_verified_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT,
    CONSTRAINT "users_email_not_blank" CHECK (length(btrim("email")) > 0),
    CONSTRAINT "users_email_format" CHECK ("email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT "users_email_is_normalised" CHECK ("email" = lower(btrim("email"))),
    CONSTRAINT "users_mobile_ten_digits" CHECK ("mobile" IS NULL OR "mobile" ~ '^[0-9]{10}$'),
    CONSTRAINT "users_status_valid" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
    CONSTRAINT "users_full_name_not_blank" CHECK (length(btrim("full_name")) > 0),
    CONSTRAINT "users_password_hash_not_blank" CHECK (length("password_hash") > 0)
);

-- Uniqueness is on the normalised value, so it is case-insensitive by construction.
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");
CREATE UNIQUE INDEX "users_mobile_key" ON "users" ("mobile") WHERE "mobile" IS NOT NULL;

CREATE TRIGGER "users_set_updated_at"
BEFORE UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE FUNCTION "users_normalize_contact"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    digits TEXT;
BEGIN
    NEW."email" := lower(btrim(NEW."email"));

    IF NEW."mobile" IS NULL THEN
        RETURN NEW;
    END IF;

    digits := regexp_replace(NEW."mobile", '[^0-9]', '', 'g');

    -- Strip a leading country code (91) or trunk prefix (0).
    IF length(digits) = 12 AND left(digits, 2) = '91' THEN
        digits := substr(digits, 3);
    ELSIF length(digits) = 11 AND left(digits, 1) = '0' THEN
        digits := substr(digits, 2);
    END IF;

    NEW."mobile" := NULLIF(btrim(digits), '');
    RETURN NEW;
END;

$$;

CREATE TRIGGER "users_normalize_contact"
BEFORE INSERT OR UPDATE OF "email", "mobile" ON "users"
FOR EACH ROW EXECUTE FUNCTION "users_normalize_contact"();

-- ---------------------------------------------------------------------------
-- user_permissions (per-user overrides on top of the role)
-- ---------------------------------------------------------------------------

CREATE TABLE "user_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "user_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT,
    CONSTRAINT "user_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "user_permissions_not_self_granted" CHECK ("granted_by" IS NULL OR "granted_by" <> "user_id")
);

CREATE UNIQUE INDEX "user_permissions_user_permission_key" ON "user_permissions" ("user_id", "permission_id");

-- ---------------------------------------------------------------------------
-- settings (type and bounds travel with the row)
-- ---------------------------------------------------------------------------

CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "value_text" TEXT,
    "value_int" INTEGER,
    "value_bool" BOOLEAN,
    "min_int" INTEGER,
    "max_int" INTEGER,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "settings_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_.]{2,63}$'),
    CONSTRAINT "settings_value_type_valid" CHECK ("value_type" IN ('string', 'integer', 'boolean')),
    CONSTRAINT "settings_value_shape" CHECK (
        ("value_type" = 'string'
            AND "value_text" IS NOT NULL AND "value_int" IS NULL AND "value_bool" IS NULL
            AND "min_int" IS NULL AND "max_int" IS NULL)
        OR ("value_type" = 'integer'
            AND "value_int" IS NOT NULL AND "value_text" IS NULL AND "value_bool" IS NULL
            AND ("min_int" IS NULL OR "value_int" >= "min_int")
            AND ("max_int" IS NULL OR "value_int" <= "max_int")
            AND ("min_int" IS NULL OR "max_int" IS NULL OR "min_int" <= "max_int"))
        OR ("value_type" = 'boolean'
            AND "value_bool" IS NOT NULL AND "value_text" IS NULL AND "value_int" IS NULL
            AND "min_int" IS NULL AND "max_int" IS NULL)
    ),
    CONSTRAINT "settings_value_text_length" CHECK ("value_text" IS NULL OR length("value_text") BETWEEN 1 AND 1000)
);

CREATE TRIGGER "settings_set_updated_at"
BEFORE UPDATE ON "settings"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

INSERT INTO "settings" ("key", "value_type", "value_int", "min_int", "max_int", "description") VALUES
    ('coins.signup_bonus', 'integer', 1000, 0, 100000, 'Coins granted once per person at signup'),
    ('coins.daily_login_bonus', 'integer', 10, 0, 1000, 'Coins granted on the first login of each Asia/Kolkata day'),
    ('coins.attempt_cost', 'integer', 100, 0, 100000, 'Default coins charged for one mock test attempt; a test may override it');

-- ---------------------------------------------------------------------------
-- audit_logs (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "actor_user_id" UUID,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "ip" TEXT,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "audit_logs_action_format" CHECK ("action" ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    CONSTRAINT "audit_logs_metadata_object" CHECK (jsonb_typeof("metadata") = 'object')
);

CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs" ("occurred_at");
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" ("entity_type", "entity_id");

CREATE FUNCTION "audit_logs_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;

$$;

CREATE TRIGGER "audit_logs_no_update"
BEFORE UPDATE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "audit_logs_reject_mutation"();

CREATE TRIGGER "audit_logs_no_delete"
BEFORE DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION "audit_logs_reject_mutation"();

CREATE TRIGGER "audit_logs_no_truncate"
BEFORE TRUNCATE ON "audit_logs"
FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_reject_mutation"();

-- The application's database role: may read and append, never rewrite history.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abhyas_app') THEN
        CREATE ROLE "abhyas_app" NOLOGIN;
    END IF;
END

$$;

DO $$
BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT ON %I."audit_logs" TO "abhyas_app"', current_schema());
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I."audit_logs" FROM "abhyas_app"', current_schema());
END

$$;
