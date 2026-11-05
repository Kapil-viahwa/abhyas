-- Phase 5, item 2b: one mailbox, one signup grant.
--
-- Registration still stores the address a person typed, because that is the address they
-- read mail at. This table records the *identity* a grant was paid against, and it is used
-- for nothing else: Gmail ignores dots and everything from a plus onwards, so a+1@gmail.com
-- and a.b@gmail.com are one inbox and must not each earn a signup grant. The unique key is
-- what enforces it, inside the same transaction as the grant, so the second attempt changes
-- nothing rather than reporting an error.

CREATE TABLE "coin_grant_identities" (
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "coin_grant_identities_pkey" PRIMARY KEY ("kind", "value"),
    CONSTRAINT "coin_grant_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "coin_grant_identities_kind_valid" CHECK ("kind" IN ('EMAIL')),
    CONSTRAINT "coin_grant_identities_value_present" CHECK (length(btrim("value")) > 0)
);

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT ON %I."coin_grant_identities" TO "abhyas_app"', current_schema());
END

$$;
