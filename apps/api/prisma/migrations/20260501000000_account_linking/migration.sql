-- Phase 2c, item 3: linking a second identifier to an existing account.
--
-- A link token must name the address it will confirm, so `destination` joins
-- `email_tokens`: null for the tokens that already exist (verification and reset, whose
-- address is the account's own), mandatory for a link and always stored normalized.

ALTER TABLE "email_tokens" ADD COLUMN "destination" TEXT;

ALTER TABLE "email_tokens" DROP CONSTRAINT "email_tokens_purpose_valid";

ALTER TABLE "email_tokens"
    ADD CONSTRAINT "email_tokens_purpose_valid"
    CHECK ("purpose" IN ('VERIFY_EMAIL', 'RESET_PASSWORD', 'LINK_EMAIL'));

ALTER TABLE "email_tokens"
    ADD CONSTRAINT "email_tokens_destination_shape"
    CHECK (
        ("purpose" = 'LINK_EMAIL'
            AND "destination" IS NOT NULL
            AND "destination" = lower(btrim("destination")))
        OR ("purpose" <> 'LINK_EMAIL' AND "destination" IS NULL)
    );
