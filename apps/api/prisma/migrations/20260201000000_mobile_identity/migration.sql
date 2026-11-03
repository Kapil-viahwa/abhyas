-- Phase 2c, item 3: an account may be identified by a verified mobile number, and the
-- setting that records which verified identifier earns the signup coin grant.
--
-- A mobile-first account has no email address until one is linked, so `users.email` stops
-- being mandatory. Both identifiers are only ever written after they have been verified,
-- and every row must still carry at least one of them: an account with no identifier at
-- all could not be signed into or recovered.

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Existing rows all have an email, so the constraint can be validated immediately.
ALTER TABLE "users"
    ADD CONSTRAINT "users_identifier_present"
    CHECK ("email" IS NOT NULL OR "first_verified_mobile" IS NOT NULL) NOT VALID;

ALTER TABLE "users" VALIDATE CONSTRAINT "users_identifier_present";

-- Phase 5 grants the signup coins against the identifier named here. While OTP is off the
-- requirement is a verified email address; docs/otp-enable-runbook.md flips it to 'mobile'
-- when SMS is switched on, and the change is audited like every other setting.
INSERT INTO "settings" ("key", "value_type", "value_text", "description") VALUES
    ('signup_grant_requirement', 'string', 'email',
     'Which verified identifier earns the signup coin grant: email or mobile')
ON CONFLICT ("key") DO NOTHING;

-- The row declares its own allowed values, so a typo is refused by the database and not
-- only by the service that happens to write it.
ALTER TABLE "settings"
    ADD CONSTRAINT "settings_signup_grant_requirement_valid"
    CHECK ("key" <> 'signup_grant_requirement' OR "value_text" IN ('email', 'mobile'));
