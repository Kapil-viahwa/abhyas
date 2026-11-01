-- Development and CI: provision the application's database role.
-- Production creates this role out of band with its own secret and no NOLOGIN gap;
-- see docs/deployment.md. The migrations grant it privileges and revoke the ones it
-- must never hold (UPDATE/DELETE on audit_logs).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abhyas_app') THEN
        CREATE ROLE "abhyas_app" LOGIN PASSWORD 'abhyas_app';
    END IF;
END

$$;
