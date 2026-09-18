-- Tirbeo CDN product model: Bucket → Folder → File → Public CDN URL.
-- All sizes are integer BYTES. Additive-only migration (safe to apply).

-- Extend cdn_files with bucket + delivery metadata (nullable, additive).
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "bucket_id" TEXT;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "storage_key" TEXT;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "visibility" TEXT DEFAULT 'public';
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "etag" TEXT;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "height" INTEGER;
CREATE INDEX IF NOT EXISTS "idx_cdn_files_bucket" ON "cdn_files"("bucket_id");

-- Top-level CDN containers.
CREATE TABLE IF NOT EXISTS "cdn_buckets" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "storage_provider" TEXT NOT NULL DEFAULT 'tirbeo',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_buckets_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cdn_buckets_project_slug') THEN
        ALTER TABLE "cdn_buckets" ADD CONSTRAINT "uq_cdn_buckets_project_slug" UNIQUE ("project_id", "slug");
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "idx_cdn_buckets_project" ON "cdn_buckets"("project_id");

-- Seed default buckets (idempotent).
INSERT INTO "cdn_buckets" ("project_id", "name", "slug", "visibility")
SELECT 'default', 'production', 'production', 'public'
WHERE NOT EXISTS (SELECT 1 FROM "cdn_buckets" WHERE project_id = 'default' AND slug = 'production');
INSERT INTO "cdn_buckets" ("project_id", "name", "slug", "visibility")
SELECT 'default', 'development', 'development', 'private'
WHERE NOT EXISTS (SELECT 1 FROM "cdn_buckets" WHERE project_id = 'default' AND slug = 'development');
INSERT INTO "cdn_buckets" ("project_id", "name", "slug", "visibility")
SELECT 'default', 'user-uploads', 'user-uploads', 'private'
WHERE NOT EXISTS (SELECT 1 FROM "cdn_buckets" WHERE project_id = 'default' AND slug = 'user-uploads');

-- Custom CDN domains with verification state.
CREATE TABLE IF NOT EXISTS "cdn_domains" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_domains_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cdn_domains_domain_key" UNIQUE ("domain")
);
CREATE INDEX IF NOT EXISTS "idx_cdn_domains_project" ON "cdn_domains"("project_id");
CREATE INDEX IF NOT EXISTS "idx_cdn_domains_status" ON "cdn_domains"("status");
