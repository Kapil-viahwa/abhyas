-- Phase 4: media assets.
--
-- The bucket is private. Every read is a short-lived presigned URL issued by the API,
-- so the row records what was stored and who stored it, never a public address.

CREATE TABLE "media_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "media_assets_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT,
    -- The pipeline re-encodes everything to WebP, so nothing else can be stored.
    CONSTRAINT "media_assets_mime_type_valid" CHECK ("mime_type" IN ('image/webp')),
    CONSTRAINT "media_assets_byte_size_bounds" CHECK ("byte_size" > 0 AND "byte_size" <= 5242880),
    CONSTRAINT "media_assets_dimensions_positive" CHECK (
        "width" > 0 AND "height" > 0 AND "width" <= 2000 AND "height" <= 2000
    ),
    CONSTRAINT "media_assets_checksum_format" CHECK ("checksum_sha256" ~ '^[0-9a-f]{64}$'),
    -- Keys are generated, never supplied: question-image/<uuid>.webp and nothing else.
    CONSTRAINT "media_assets_object_key_format" CHECK (
        "object_key" ~ '^question-image/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    )
);

CREATE UNIQUE INDEX "media_assets_object_key_key" ON "media_assets" ("object_key");
CREATE INDEX "media_assets_uploaded_by_idx" ON "media_assets" ("uploaded_by");

DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I."media_assets" TO "abhyas_app"', current_schema());
END

$$;
