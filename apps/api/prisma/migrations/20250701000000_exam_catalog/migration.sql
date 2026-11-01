-- Phase 3: the exam catalog. Categories (two levels), exams, subjects and topics.
-- The database is the last line of defence: slugs are constrained and unique, a
-- category tree is two levels deep, and every row records who created it so the
-- API's object-level ownership rule has something to read.

CREATE TABLE "exam_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "parent_id" UUID,
    "logo_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "exam_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exam_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "exam_categories"("id") ON DELETE RESTRICT,
    CONSTRAINT "exam_categories_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "exam_categories_name_not_blank" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "exam_categories_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "exam_categories_sort_order_non_negative" CHECK ("sort_order" >= 0),
    CONSTRAINT "exam_categories_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

CREATE UNIQUE INDEX "exam_categories_slug_key" ON "exam_categories" ("slug");
CREATE INDEX "exam_categories_parent_id_idx" ON "exam_categories" ("parent_id");

CREATE TRIGGER "exam_categories_set_updated_at"
BEFORE UPDATE ON "exam_categories"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

-- Two levels: a subcategory may not have a parent, and a category with children may
-- not become a child. Enforced here so no API path can build a deeper tree.
CREATE FUNCTION "exam_categories_two_levels"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."parent_id" IS NULL THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1 FROM "exam_categories" c
        WHERE c."id" = NEW."parent_id" AND c."parent_id" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'exam categories are two levels deep: a subcategory cannot have children'
            USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM "exam_categories" c WHERE c."parent_id" = NEW."id") THEN
        RAISE EXCEPTION 'exam categories are two levels deep: a category with children cannot become a subcategory'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;

$$;

CREATE TRIGGER "exam_categories_two_levels"
BEFORE INSERT OR UPDATE OF "parent_id" ON "exam_categories"
FOR EACH ROW EXECUTE FUNCTION "exam_categories_two_levels"();

CREATE TABLE "exams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "logo_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "exams_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "exam_categories"("id") ON DELETE RESTRICT,
    CONSTRAINT "exams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "exams_name_not_blank" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "exams_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "exams_sort_order_non_negative" CHECK ("sort_order" >= 0)
);

CREATE UNIQUE INDEX "exams_slug_key" ON "exams" ("slug");
CREATE INDEX "exams_category_id_idx" ON "exams" ("category_id");
CREATE INDEX "exams_created_by_idx" ON "exams" ("created_by");

CREATE TRIGGER "exams_set_updated_at"
BEFORE UPDATE ON "exams"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE TABLE "subjects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "exam_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subjects_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT,
    CONSTRAINT "subjects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "subjects_name_not_blank" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "subjects_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "subjects_sort_order_non_negative" CHECK ("sort_order" >= 0)
);

CREATE UNIQUE INDEX "subjects_exam_slug_key" ON "subjects" ("exam_id", "slug");
CREATE INDEX "subjects_exam_id_idx" ON "subjects" ("exam_id");

CREATE TRIGGER "subjects_set_updated_at"
BEFORE UPDATE ON "subjects"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

CREATE TABLE "topics" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subject_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "topics_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT,
    CONSTRAINT "topics_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "topics_name_not_blank" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "topics_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT "topics_sort_order_non_negative" CHECK ("sort_order" >= 0)
);

CREATE UNIQUE INDEX "topics_subject_slug_key" ON "topics" ("subject_id", "slug");
CREATE INDEX "topics_subject_id_idx" ON "topics" ("subject_id");

CREATE TRIGGER "topics_set_updated_at"
BEFORE UPDATE ON "topics"
FOR EACH ROW EXECUTE FUNCTION "set_updated_at"();

-- The application role owns nothing; it only needs the four tables.
DO $$
BEGIN
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON %I."exam_categories", %I."exams", %I."subjects", %I."topics" TO "abhyas_app"',
        current_schema(), current_schema(), current_schema(), current_schema()
    );
END

$$;
