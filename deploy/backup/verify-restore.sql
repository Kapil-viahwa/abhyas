-- Post-restore verification for an Abhyas backup.
--
-- Run by restore.sh through psql with four variables taken from the backup's manifest:
--   expected_migrations    a JSON array of migration names
--   expected_tables        a JSON object of table name -> row count
--   expected_owner         the role that owned public.test_questions at backup time
--   expected_constraints   the number of CHECK/UNIQUE/PRIMARY KEY/FOREIGN KEY constraints
--
-- Every row it prints is `STATUS|name|detail`, with STATUS one of PASS, FAIL or SKIP; restore.sh
-- prints those and counts the FAILs. The whole file runs inside one transaction that is rolled
-- back, so the live probes below can attempt real DML and leave no trace either way.
--
-- Nothing here prints a row's contents: names and counts only.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The applied migrations are exactly the ones the manifest recorded
-- ---------------------------------------------------------------------------

WITH actual AS (
    SELECT coalesce(json_agg(migration_name ORDER BY migration_name), '[]'::json) AS names
    FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
),
counts AS (
    SELECT (SELECT count(*) FROM _prisma_migrations
            WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS n,
           (SELECT count(*) FROM jsonb_array_elements((actual.names)::jsonb)) AS m
    FROM actual
)
SELECT
    CASE WHEN (SELECT names FROM actual)::jsonb = :'expected_migrations'::jsonb THEN 'PASS' ELSE 'FAIL' END,
    '1 applied migrations match the manifest',
    (SELECT n FROM counts) || ' applied, ' ||
    (SELECT m FROM counts) || ' in the manifest'
FROM actual;

-- ---------------------------------------------------------------------------
-- 2. Every table's row count matches the manifest
-- ---------------------------------------------------------------------------

WITH actual AS (
    SELECT c.relname,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
),
expected AS (
    SELECT key AS relname, value::bigint AS n
    FROM jsonb_each_text(:'expected_tables'::jsonb)
),
-- A FULL JOIN, so both directions are caught: a table with the wrong count, a table the
-- restore invented, and a table that is missing entirely.
bad AS (
    SELECT coalesce(a.relname, e.relname) AS relname, a.n AS actual_n, e.n AS expected_n
    FROM actual a
    FULL OUTER JOIN expected e ON e.relname = a.relname
    WHERE a.n IS DISTINCT FROM e.n
),
detail AS (
    SELECT coalesce(string_agg(
               relname || '=' || coalesce(actual_n::text, 'missing') || '/expected ' || coalesce(expected_n::text, 'absent'), ', '), '') AS text
    FROM (SELECT * FROM bad ORDER BY relname LIMIT 5) b
)
SELECT
    CASE WHEN (SELECT count(*) FROM bad) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '2 row counts of every table match the manifest',
    (SELECT count(*) FROM actual) || ' tables; ' || (SELECT count(*) FROM bad) || ' differ' ||
    CASE WHEN (SELECT text FROM detail) = '' THEN '' ELSE ' (' || (SELECT text FROM detail) || ')' END;

-- ---------------------------------------------------------------------------
-- 3. The coin ledger and its wallets
-- ---------------------------------------------------------------------------

WITH wallets AS (
    SELECT w.id, w.balance, coalesce(sum(t.amount), 0) AS ledger
    FROM coin_wallets w
    LEFT JOIN coin_transactions t ON t.user_id = w.user_id
    GROUP BY w.id, w.balance
),
bad AS (
    SELECT * FROM wallets WHERE balance <> ledger
)
SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '3a every wallet balance equals the sum of its ledger',
    count(*) || ' mismatch(es)'
FROM bad;

SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '3b no wallet is negative',
    count(*) || ' negative'
FROM coin_wallets
WHERE balance < 0;

WITH debits AS (
    SELECT t.id, t.reference_type, t.reference_id
    FROM coin_transactions t
    WHERE t.type = 'ENROLLMENT'
),
bad AS (
    SELECT d.id
    FROM debits d
    WHERE d.reference_type IS DISTINCT FROM 'enrollment'
       OR d.reference_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.id::text = d.reference_id)
)
SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '3c every ENROLLMENT debit references an enrollment',
    count(*) || ' bad of ' || (SELECT count(*) FROM debits)
FROM bad;

-- ---------------------------------------------------------------------------
-- 4. Attempts, answers and results
-- ---------------------------------------------------------------------------

SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '4a every ended attempt has exactly one result',
    count(*) || ' wrong'
FROM attempts a
WHERE a.status <> 'IN_PROGRESS'
  AND (SELECT count(*) FROM results r WHERE r.attempt_id = a.id) <> 1;

SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '4b no result exists for a running attempt',
    count(*) || ' wrong'
FROM results r
JOIN attempts a ON a.id = r.attempt_id
WHERE a.status = 'IN_PROGRESS';

-- Answers are written before the status flips, in the same transaction, so an answer's
-- created_at can never be later than its attempt's submitted_at.
SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '4c no answer was written after its attempt ended',
    count(*) || ' wrong'
FROM attempt_answers aa
JOIN attempts a ON a.id = aa.attempt_id
WHERE a.status <> 'IN_PROGRESS'
  AND aa.created_at > a.submitted_at;

SELECT
    CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '4d every published or archived paper is fully pinned',
    count(*) || ' unpinned'
FROM test_questions tq
JOIN test_versions tv ON tv.id = tq.test_version_id
JOIN tests t ON t.id = tv.test_id
WHERE (tv.published_at IS NOT NULL OR t.status = 'ARCHIVED')
  AND tq.question_version_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5. The integrity machinery survived the round trip
-- ---------------------------------------------------------------------------

WITH expected(name) AS (
    VALUES
        ('roles_set_updated_at'),
        ('users_set_updated_at'),
        ('users_normalize_contact'),
        ('settings_set_updated_at'),
        ('audit_logs_no_update'),
        ('audit_logs_no_delete'),
        ('audit_logs_no_truncate'),
        ('exam_categories_set_updated_at'),
        ('exam_categories_two_levels'),
        ('exams_set_updated_at'),
        ('subjects_set_updated_at'),
        ('topics_set_updated_at'),
        ('questions_catalog_alignment'),
        ('question_versions_frozen'),
        ('question_options_frozen'),
        ('question_options_answer_key'),
        ('coin_wallets_set_updated_at'),
        ('coin_transactions_reject_mutation'),
        ('coin_transactions_apply'),
        ('coin_wallets_only_via_ledger'),
        ('coin_wallets_start_at_zero'),
        ('tests_published_frozen'),
        ('test_versions_frozen'),
        ('test_questions_frozen'),
        ('test_questions_version_matches'),
        ('test_versions_pinned_before_publish'),
        ('enrollments_consistent'),
        ('attempts_started_at_from_database'),
        ('attempts_consistent'),
        ('attempts_one_way'),
        ('attempt_answers_guard'),
        ('results_only_after_end'),
        ('results_immutable')
),
found AS (
    SELECT e.name,
           EXISTS (
               SELECT 1
               FROM pg_trigger tg
               JOIN pg_class c ON c.oid = tg.tgrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND tg.tgname = e.name AND tg.tgenabled <> 'D'
           ) AS ok
    FROM expected e
)
SELECT
    CASE WHEN count(*) FILTER (WHERE NOT ok) = 0 THEN 'PASS' ELSE 'FAIL' END,
    '5a the integrity triggers exist and are enabled',
    count(*) || ' expected; missing or disabled: ' ||
    coalesce(string_agg(name, ', ') FILTER (WHERE NOT ok), 'none')
FROM found;

WITH constraints AS (
    SELECT count(*) AS n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.contype IN ('c', 'u', 'p', 'f')
)
SELECT
    CASE WHEN n = :'expected_constraints'::bigint THEN 'PASS' ELSE 'FAIL' END,
    '5b the constraint count matches the manifest',
    n || ' present, ' || :'expected_constraints' || ' expected'
FROM constraints;

-- 5c and 5d: live probes. The UPDATE sets a column to itself, so an accepted update would
-- change nothing; the DELETE would remove a row, and the enclosing transaction is rolled back
-- at the end of this file either way.

CREATE FUNCTION pg_temp.probe_update_pinned() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
    accepted text := 'no';
BEGIN
    SELECT tq.id INTO target
    FROM test_questions tq
    JOIN test_versions tv ON tv.id = tq.test_version_id
    WHERE tv.published_at IS NOT NULL AND tq.question_version_id IS NOT NULL
    LIMIT 1;

    IF target IS NULL THEN
        RETURN 'SKIP|5c an update of a pinned row is refused|no pinned row in this database';
    END IF;

    BEGIN
        UPDATE test_questions SET position = position WHERE id = target;
        accepted := 'yes';
    EXCEPTION WHEN others THEN
        accepted := 'no';
    END;

    IF accepted = 'yes' THEN
        RETURN 'FAIL|5c an update of a pinned row is refused|the UPDATE was accepted';
    END IF;

    RETURN 'PASS|5c an update of a pinned row is refused|the trigger raised';
END;
$$;

CREATE FUNCTION pg_temp.probe_delete_result() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
    accepted text := 'no';
BEGIN
    SELECT id INTO target FROM results LIMIT 1;

    IF target IS NULL THEN
        RETURN 'SKIP|5d a delete of a result is refused|no result in this database';
    END IF;

    BEGIN
        DELETE FROM results WHERE id = target;
        accepted := 'yes';
    EXCEPTION WHEN others THEN
        accepted := 'no';
    END;

    IF accepted = 'yes' THEN
        RETURN 'FAIL|5d a delete of a result is refused|the DELETE was accepted';
    END IF;

    RETURN 'PASS|5d a delete of a result is refused|the trigger raised';
END;
$$;

SELECT detail FROM (SELECT pg_temp.probe_update_pinned() AS detail) p;
SELECT detail FROM (SELECT pg_temp.probe_delete_result() AS detail) p;

-- ---------------------------------------------------------------------------
-- 6. Defaults still produce fresh identifiers
-- ---------------------------------------------------------------------------

WITH inserted AS (
    INSERT INTO app_metadata (key, value)
    VALUES ('restore-probe-' || gen_random_uuid()::text, 'probe')
    RETURNING id
)
SELECT
    CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END,
    '6 a default id is generated after the restore',
    count(*) || ' row(s) inserted (rolled back)'
FROM inserted;

-- ---------------------------------------------------------------------------
-- 7. Ownership: the migration role owns the table the pinning migration must alter
-- ---------------------------------------------------------------------------

SELECT
    CASE
        WHEN (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.test_questions'::regclass) = :'expected_owner'
            THEN 'PASS' ELSE 'FAIL'
    END,
    '7 test_questions is owned by the migration role',
    (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.test_questions'::regclass)
    || ', expected ' || :'expected_owner';

ROLLBACK;
