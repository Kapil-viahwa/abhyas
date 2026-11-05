-- Phase 5, item 1: the coin wallet and the append-only ledger behind it.
--
-- The wallet balance is a cache of the ledger, never a number a request may set:
--   * the ledger is append-only (a trigger, and the application role has no privilege
--     to update or delete a row);
--   * every ledger row must continue the wallet's balance exactly, and a CHECK ties
--     new_balance to previous_balance + amount;
--   * the ledger's trigger moves the wallet inside the same statement, so a row and
--     the balance it produces cannot be written apart from each other;
--   * the application role cannot move a wallet's balance any other way. The table's
--     owner (migrations, an operator) still can, deliberately, and the nightly
--     reconciliation reports any wallet that no longer matches its ledger.

-- ---------------------------------------------------------------------------
-- coin_wallets (one per user; balance is a cache of the ledger)
-- ---------------------------------------------------------------------------

CREATE TABLE "coin_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "coin_wallets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coin_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "coin_wallets_balance_non_negative" CHECK ("balance" >= 0)
);

CREATE UNIQUE INDEX "coin_wallets_user_id_key" ON "coin_wallets" ("user_id");

CREATE TRIGGER "coin_wallets_set_updated_at"
BEFORE UPDATE ON "coin_wallets"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

-- ---------------------------------------------------------------------------
-- coin_transactions (append-only; the only record of what moved)
-- ---------------------------------------------------------------------------

CREATE TABLE "coin_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "previous_balance" INTEGER NOT NULL,
    "new_balance" INTEGER NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "description" TEXT,
    "created_by" UUID,
    "idempotency_key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "coin_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coin_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "coin_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "coin_transactions_type_valid" CHECK (
        "type" IN ('SIGNUP_GRANT', 'DAILY_REWARD', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'ENROLLMENT')
    ),
    CONSTRAINT "coin_transactions_amount_non_zero" CHECK ("amount" <> 0),
    CONSTRAINT "coin_transactions_previous_balance_non_negative" CHECK ("previous_balance" >= 0),
    CONSTRAINT "coin_transactions_new_balance_non_negative" CHECK ("new_balance" >= 0),
    CONSTRAINT "coin_transactions_balance_delta" CHECK ("new_balance" = "previous_balance" + "amount"),
    CONSTRAINT "coin_transactions_reference_pair" CHECK (("reference_type" IS NULL) = ("reference_id" IS NULL)),
    CONSTRAINT "coin_transactions_idempotency_key_length" CHECK (length("idempotency_key") BETWEEN 8 AND 200),
    CONSTRAINT "coin_transactions_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$')
);

-- One intent, one key: a replay cannot write a second row.
CREATE UNIQUE INDEX "coin_transactions_user_idempotency_key"
    ON "coin_transactions" ("user_id", "idempotency_key");

-- The wallet page reads one person's history newest first; the admin viewer filters by type.
CREATE INDEX "coin_transactions_user_created_at_idx" ON "coin_transactions" ("user_id", "created_at" DESC);
CREATE INDEX "coin_transactions_type_created_at_idx" ON "coin_transactions" ("type", "created_at" DESC);

-- ---------------------------------------------------------------------------
-- Append-only: no rewrite, no erasure, whoever asks
-- ---------------------------------------------------------------------------

CREATE FUNCTION "coin_transactions_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'coin_transactions is append-only: % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;

$$;

CREATE TRIGGER "coin_transactions_reject_mutation"
BEFORE UPDATE OR DELETE ON "coin_transactions"
FOR EACH ROW EXECUTE FUNCTION "coin_transactions_reject_mutation"();

-- ---------------------------------------------------------------------------
-- The wallet is moved by the row that explains the movement
-- ---------------------------------------------------------------------------

CREATE FUNCTION "coin_transactions_apply"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    wallet_balance INTEGER;
BEGIN
    -- Lock the wallet for the rest of this statement as well as this transaction, so
    -- two writers of one ledger cannot both decide what the next balance is.
    SELECT w."balance" INTO wallet_balance
    FROM "coin_wallets" w
    WHERE w."user_id" = NEW."user_id"
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'A coin wallet must exist before its ledger is written (user %)', NEW."user_id"
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW."previous_balance" <> wallet_balance THEN
        RAISE EXCEPTION 'previous_balance % does not match the wallet balance % for user %',
            NEW."previous_balance", wallet_balance, NEW."user_id"
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE "coin_wallets"
    SET "balance" = NEW."new_balance"
    WHERE "user_id" = NEW."user_id";

    RETURN NEW;
END;

$$;

CREATE TRIGGER "coin_transactions_apply"
BEFORE INSERT ON "coin_transactions"
FOR EACH ROW EXECUTE FUNCTION "coin_transactions_apply"();

-- Only the ledger moves a balance. The owner may still repair one deliberately (and the
-- reconciliation job reports it); the application role may not move one at all. The
-- ledger's own trigger runs at depth 2, which is how it is told apart from a direct write.
CREATE FUNCTION "coin_wallets_only_via_ledger"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner_name TEXT;
BEGIN
    IF NEW."balance" IS NOT DISTINCT FROM OLD."balance" THEN
        RETURN NEW;
    END IF;

    IF pg_trigger_depth() >= 2 THEN
        RETURN NEW;
    END IF;

    SELECT pg_get_userbyid(c."relowner") INTO owner_name
    FROM pg_class c
    WHERE c."oid" = 'coin_wallets'::regclass;

    IF current_user IS DISTINCT FROM owner_name THEN
        RAISE EXCEPTION 'coin_wallets.balance changes only through coin_transactions'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;

$$;

CREATE TRIGGER "coin_wallets_only_via_ledger"
BEFORE UPDATE ON "coin_wallets"
FOR EACH ROW EXECUTE FUNCTION "coin_wallets_only_via_ledger"();

-- ---------------------------------------------------------------------------
-- The application's database role: read and append the ledger, never rewrite it
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I."coin_wallets" TO "abhyas_app"', current_schema());
    EXECUTE format('GRANT SELECT, INSERT ON %I."coin_transactions" TO "abhyas_app"', current_schema());
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I."coin_transactions" FROM "abhyas_app"', current_schema());
END

$$;
