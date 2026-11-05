-- Phase 5, item 1b: the ledger review's findings, in their own migration.
--
-- Nothing here edits 20260601000000_coins: a migration that has run in CI is history, and
-- the next environment applies both in order.

-- ---------------------------------------------------------------------------
-- 1. A wallet is opened empty, by anyone
-- ---------------------------------------------------------------------------
--
-- The trigger to stop a wallet being moved outside the ledger already existed; it did not
-- stop a wallet being *created* with a balance, which is the same hole one step earlier.
-- The stopgap is the same one the update path uses: the application role is refused and the
-- table's owner (migrations, an operator) may still do it deliberately. The better design is
-- recorded in docs/decisions.md 0061: move the wallet write into a SECURITY DEFINER function
-- and grant the application role no INSERT or UPDATE on coin_wallets at all, so the guard
-- stops being a depth heuristic and becomes a privilege the role does not hold.

CREATE FUNCTION "coin_wallets_start_at_zero"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner_name TEXT;
BEGIN
    IF NEW."balance" = 0 THEN
        RETURN NEW;
    END IF;

    SELECT pg_get_userbyid(c."relowner") INTO owner_name
    FROM pg_class c
    WHERE c."oid" = 'coin_wallets'::regclass;

    IF current_user IS DISTINCT FROM owner_name THEN
        RAISE EXCEPTION 'coin_wallets.balance starts at zero; only the ledger moves it'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;

$$;

CREATE TRIGGER "coin_wallets_start_at_zero"
BEFORE INSERT ON "coin_wallets"
FOR EACH ROW EXECUTE FUNCTION "coin_wallets_start_at_zero"();

-- ---------------------------------------------------------------------------
-- 2. One grant per person, one charge per reference
-- ---------------------------------------------------------------------------
--
-- The idempotency key stops the same request being written twice. It does not stop two
-- different requests asking for the same thing, which is what these partial unique indexes
-- are for: a second SIGNUP_GRANT for one account, or a second ENROLLMENT charge against one
-- attempt, is a bug in the caller and the database says so.

CREATE UNIQUE INDEX "coin_transactions_one_signup_grant_per_user"
    ON "coin_transactions" ("user_id")
    WHERE "type" = 'SIGNUP_GRANT';

CREATE UNIQUE INDEX "coin_transactions_one_enrollment_per_reference"
    ON "coin_transactions" ("reference_type", "reference_id")
    WHERE "type" = 'ENROLLMENT';

-- ---------------------------------------------------------------------------
-- 3. The ledger records who caused it, and cannot forget
-- ---------------------------------------------------------------------------
--
-- SET NULL would rewrite an append-only row the day its creator was deleted. The ledger is
-- history: the account that caused an entry cannot be deleted while the entry exists.

ALTER TABLE "coin_transactions" DROP CONSTRAINT "coin_transactions_created_by_fkey";
ALTER TABLE "coin_transactions"
    ADD CONSTRAINT "coin_transactions_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. One entry cannot be a treasury
-- ---------------------------------------------------------------------------
--
-- A single movement is bounded so a malformed admin request (or a bad bulk job) cannot move
-- a surreal number in one statement. Bulk work composes several entries, each bounded.

ALTER TABLE "coin_transactions"
    ADD CONSTRAINT "coin_transactions_amount_within_range" CHECK (abs("amount") <= 1000000);
