-- Phase 2c, item 1: the OTP request record, the SMS cost ledger, and the one mobile a
-- person has proven they control.
--
-- The code itself is never stored: `code_hmac` is an HMAC of the digits with a server
-- secret, so a database read cannot recover a live code. The destination is stored twice —
-- the E.164 number for sending, and a hash for every later query and log, so a support
-- export or an audit row never carries a phone number.

ALTER TABLE "users" ADD COLUMN "first_verified_mobile" TEXT;

-- One person, one phone. The constraint is the only thing that can guarantee it: a second
-- account cannot claim a number that has already been verified elsewhere.
CREATE UNIQUE INDEX "users_first_verified_mobile_key"
    ON "users" ("first_verified_mobile")
    WHERE "first_verified_mobile" IS NOT NULL;

CREATE TABLE "otp_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "destination" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hmac" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "ip_hash" TEXT,
    "device_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "otp_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "otp_requests_purpose_valid" CHECK ("purpose" IN ('SIGNUP', 'LOGIN', 'LINK')),
    -- E.164: a plus, a non-zero country digit, and at most fifteen digits in total.
    CONSTRAINT "otp_requests_destination_e164" CHECK ("destination" ~ '^\+[1-9][0-9]{7,14}$'),
    CONSTRAINT "otp_requests_destination_hash_shape" CHECK ("destination_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "otp_requests_code_hmac_shape" CHECK ("code_hmac" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "otp_requests_attempts_range" CHECK ("attempts" >= 0 AND "attempts" <= 10),
    CONSTRAINT "otp_requests_expiry_after_creation" CHECK ("expires_at" > "created_at")
);

CREATE INDEX "otp_requests_destination_hash_idx" ON "otp_requests" ("destination_hash");
CREATE INDEX "otp_requests_created_at_idx" ON "otp_requests" ("created_at");

-- One row per message actually handed to a provider, so the daily budget and the invoice
-- can both be reconciled against something the platform wrote down itself.
CREATE TABLE "sms_cost_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "cost" NUMERIC(10, 4) NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "sms_cost_ledger_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sms_cost_ledger_cost_range" CHECK ("cost" >= 0 AND "cost" <= 100),
    CONSTRAINT "sms_cost_ledger_destination_hash_shape" CHECK ("destination_hash" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "sms_cost_ledger_created_at_idx" ON "sms_cost_ledger" ("created_at");

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."otp_requests" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT ON %I."sms_cost_ledger" TO "abhyas_app"', current_schema());
END
$$;
