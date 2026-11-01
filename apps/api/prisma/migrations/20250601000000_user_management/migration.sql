-- Phase 3: editor capability is an explicit per-editor grant.
--
-- An editor's write access no longer comes from the role: it comes from rows in
-- "user_permissions", one per ticked flag. An omitted flag is a denial, not a
-- default, and two triggers keep the two tables in step:
--   * editor capability may only be granted to an EDITOR account;
--   * demoting an editor clears the capability they no longer qualify for.

-- The role stops carrying write access. Reading stays with the role, so an editor
-- with no flags can still read what they are allowed to read.
DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND r."code" = 'EDITOR'
  AND p."code" IN ('content.write', 'tests.write');

-- ---------------------------------------------------------------------------
-- Editor capability may only exist on an EDITOR account
-- ---------------------------------------------------------------------------

CREATE FUNCTION "user_permissions_editor_flags_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    is_editor_flag BOOLEAN;
    role_code TEXT;
BEGIN
    SELECT p."code" IN ('content.write', 'tests.write', 'tests.publish')
        INTO is_editor_flag
    FROM "permissions" p
    WHERE p."id" = NEW."permission_id";

    IF NOT is_editor_flag THEN
        RETURN NEW;
    END IF;

    SELECT r."code" INTO role_code
    FROM "users" u
    JOIN "roles" r ON r."id" = u."role_id"
    WHERE u."id" = NEW."user_id";

    IF role_code IS DISTINCT FROM 'EDITOR' THEN
        RAISE EXCEPTION 'Editor capability may only be granted to an EDITOR account'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;

$$;

CREATE TRIGGER "user_permissions_editor_flags_only"
BEFORE INSERT OR UPDATE OF "user_id", "permission_id" ON "user_permissions"
FOR EACH ROW EXECUTE FUNCTION "user_permissions_editor_flags_only"();

-- ---------------------------------------------------------------------------
-- A demoted editor loses the capability the old role justified
-- ---------------------------------------------------------------------------

CREATE FUNCTION "users_clear_editor_flags"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    new_role TEXT;
BEGIN
    SELECT r."code" INTO new_role FROM "roles" r WHERE r."id" = NEW."role_id";

    IF new_role IS DISTINCT FROM 'EDITOR' THEN
        DELETE FROM "user_permissions" up
        USING "permissions" p
        WHERE up."permission_id" = p."id"
          AND up."user_id" = NEW."id"
          AND p."code" IN ('content.write', 'tests.write', 'tests.publish');
    END IF;

    RETURN NEW;
END;

$$;

CREATE TRIGGER "users_clear_editor_flags"
AFTER UPDATE OF "role_id" ON "users"
FOR EACH ROW EXECUTE FUNCTION "users_clear_editor_flags"();
