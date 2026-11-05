-- Phase 5, item 3: one permission for the Administrator's coin tools.
--
-- `coins.adjust` already existed for "add or deduct outside the automatic rules"; the whole
-- toolset (search, adjust, bulk, ledger viewer, export) is one capability held by ADMIN
-- alone, so it gets one code and the matrix gains a row rather than a second flavour.

INSERT INTO "permissions" ("code", "description") VALUES
    ('coins.write', 'Use the Administrator coin tools: adjust, bulk assign, read and export')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r, "permissions" p
WHERE r."code" = 'ADMIN' AND p."code" = 'coins.write'
ON CONFLICT DO NOTHING;
