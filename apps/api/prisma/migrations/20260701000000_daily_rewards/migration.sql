-- Phase 5, item 2: the daily reward, one row per person per Asia/Kolkata day.
--
-- The ledger row (type DAILY_REWARD) and this row are written in one transaction, so a
-- sign-in either pays once or pays nothing. The unique (user_id, reward_date) pair is what
-- makes ten parallel sign-ins from ten devices pay exactly once: the inserts serialise on
-- the wallet's row lock inside the ledger trigger, and the loser finds its own row.

CREATE TABLE "daily_rewards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "reward_date" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "coin_transaction_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "daily_rewards_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "daily_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "daily_rewards_coin_transaction_id_fkey" FOREIGN KEY ("coin_transaction_id")
        REFERENCES "coin_transactions"("id") ON DELETE RESTRICT,
    CONSTRAINT "daily_rewards_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "daily_rewards_user_date_key" ON "daily_rewards" ("user_id", "reward_date");
-- One ledger row backs at most one reward, so the two records cannot be confused.
CREATE UNIQUE INDEX "daily_rewards_coin_transaction_id_key" ON "daily_rewards" ("coin_transaction_id");

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT ON %I."daily_rewards" TO "abhyas_app"', current_schema());
END

$$;
