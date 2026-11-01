-- Phase 3: the settings the platform is actually run on, and the audit trail's guard
-- rails. Settings keep their type and their bounds in the row, so a value that the API
-- accepts is one the database can still refuse.

-- The coin settings get the names the rest of the platform now uses.
UPDATE "settings" SET "key" = 'default_enrollment_cost' WHERE "key" = 'coins.attempt_cost';
UPDATE "settings" SET "key" = 'signup_coins' WHERE "key" = 'coins.signup_bonus';
UPDATE "settings" SET "key" = 'daily_reward_coins' WHERE "key" = 'coins.daily_login_bonus';

INSERT INTO "settings" ("key", "value_type", "value_int", "min_int", "max_int", "description") VALUES
    ('topic_rating_window_days', 'integer', 7, 1, 90,
     'How many days of attempts a topic strength rating looks at'),
    ('topic_min_attempted', 'integer', 10, 0, 1000,
     'Attempts needed before a topic receives a strength rating'),
    ('topic_band_weak_below', 'integer', 40, 0, 100,
     'Below this percentage a topic is rated weak'),
    ('topic_band_average_below', 'integer', 70, 0, 100,
     'Below this percentage, and above the weak band, a topic is rated average'),
    ('topic_band_good_below', 'integer', 90, 0, 100,
     'Below this percentage, and above the average band, a topic is rated good')
ON CONFLICT ("key") DO NOTHING;

-- Three settings describe one ordered scale, so they are validated together. A CHECK
-- cannot see the other rows; a trigger can.
CREATE FUNCTION "settings_topic_bands_in_order"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    weak_band INTEGER;
    average_band INTEGER;
    good_band INTEGER;
BEGIN
    IF NEW."key" NOT IN ('topic_band_weak_below', 'topic_band_average_below', 'topic_band_good_below') THEN
        RETURN NEW;
    END IF;

    SELECT
        COALESCE(
            CASE WHEN NEW."key" = 'topic_band_weak_below' THEN NEW."value_int" END,
            (SELECT s."value_int" FROM "settings" s WHERE s."key" = 'topic_band_weak_below')
        ),
        COALESCE(
            CASE WHEN NEW."key" = 'topic_band_average_below' THEN NEW."value_int" END,
            (SELECT s."value_int" FROM "settings" s WHERE s."key" = 'topic_band_average_below')
        ),
        COALESCE(
            CASE WHEN NEW."key" = 'topic_band_good_below' THEN NEW."value_int" END,
            (SELECT s."value_int" FROM "settings" s WHERE s."key" = 'topic_band_good_below')
        )
    INTO weak_band, average_band, good_band;

    IF weak_band IS NOT NULL AND average_band IS NOT NULL AND good_band IS NOT NULL
        AND NOT (weak_band <= average_band AND average_band <= good_band) THEN
        RAISE EXCEPTION 'Topic bands must ascend: weak <= average <= good'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;

$$;

CREATE TRIGGER "settings_topic_bands_in_order"
BEFORE INSERT OR UPDATE OF "value_int", "key" ON "settings"
FOR EACH ROW EXECUTE FUNCTION "settings_topic_bands_in_order"();

-- The audit viewer filters by actor, action and a date range; one index serves it.
CREATE INDEX "audit_logs_actor_occurred_at_idx" ON "audit_logs" ("actor_user_id", "occurred_at");
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs" ("action", "occurred_at");
