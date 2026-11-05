-- Phase 5, item 3b: an Administrator's coin write is idempotent by the key the browser sends.
--
-- A double-submitted form must not credit twice, and the same key naming a different request
-- is a bug rather than a retry: the fingerprint is compared and the answer is 409. The row
-- stores the first answer so a replay can return it without touching the ledger.

CREATE TABLE "coin_admin_requests" (
    "actor_id" uuid NOT NULL,
    "key" uuid NOT NULL,
    "route" text NOT NULL,
    "request_fingerprint" text NOT NULL,
    "response" jsonb NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT now(),

    CONSTRAINT "coin_admin_requests_pkey" PRIMARY KEY ("actor_id", "key"),

    CONSTRAINT "coin_admin_requests_route_valid" CHECK ("route" IN ('adjust', 'bulk')),
    CONSTRAINT "coin_admin_requests_fingerprint_format" CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),

    CONSTRAINT "coin_admin_requests_actor_fkey"
        FOREIGN KEY ("actor_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "coin_admin_requests_created_at_idx" ON "coin_admin_requests" ("created_at");

GRANT SELECT, INSERT ON "coin_admin_requests" TO "abhyas_app";
