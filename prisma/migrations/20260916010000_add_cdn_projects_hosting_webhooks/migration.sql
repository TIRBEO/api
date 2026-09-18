-- Tirbeo CDN production PRD: projects, hosting, webhooks, cache purges.
-- Public model is Project → path. Buckets stay an internal detail.
-- Additive-only migration (safe to apply).

ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "duration_ms" INTEGER;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "checksum" TEXT;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "cache_control" TEXT;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "content_disposition" TEXT;
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}';
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "cdn_files" ADD COLUMN IF NOT EXISTS "project_id" TEXT DEFAULT 'default';

ALTER TABLE "cdn_domains" ADD COLUMN IF NOT EXISTS "type" TEXT DEFAULT 'cdn';
ALTER TABLE "cdn_domains" ADD COLUMN IF NOT EXISTS "path_prefix" TEXT;
ALTER TABLE "cdn_domains" ADD COLUMN IF NOT EXISTS "txt_token" TEXT;
ALTER TABLE "cdn_domains" ADD COLUMN IF NOT EXISTS "ssl_status" TEXT DEFAULT 'pending';
ALTER TABLE "cdn_domains" ADD COLUMN IF NOT EXISTS "ssl_expires_at" TIMESTAMPTZ(6);
CREATE INDEX IF NOT EXISTS "idx_cdn_domains_type" ON "cdn_domains"("type");

CREATE TABLE IF NOT EXISTS "cdn_projects" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "owner_id" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "settings" JSONB DEFAULT '{}',
    "quotas" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_projects_pkey" PRIMARY KEY ("id")
);
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_cdn_projects_owner_slug') THEN
        ALTER TABLE "cdn_projects" ADD CONSTRAINT "uq_cdn_projects_owner_slug" UNIQUE ("owner_id", "slug");
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS "idx_cdn_projects_owner" ON "cdn_projects"("owner_id");

INSERT INTO "cdn_projects" ("id", "name", "slug")
SELECT 'default', 'Default project', 'default'
WHERE NOT EXISTS (SELECT 1 FROM "cdn_projects" WHERE id = 'default');

CREATE TABLE IF NOT EXISTS "cdn_hosting_configs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "root_path" TEXT NOT NULL,
    "index" TEXT NOT NULL DEFAULT 'index.html',
    "not_found" TEXT,
    "spa_fallback" BOOLEAN NOT NULL DEFAULT false,
    "domain_id" TEXT,
    "redirects" JSONB DEFAULT '[]',
    "headers" JSONB DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_hosting_configs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cdn_hosting_project" ON "cdn_hosting_configs"("project_id");

CREATE TABLE IF NOT EXISTS "cdn_webhooks" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "url" TEXT NOT NULL,
    "events" TEXT[] NOT NULL DEFAULT '{}',
    "secret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_webhooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cdn_webhooks_project" ON "cdn_webhooks"("project_id");

CREATE TABLE IF NOT EXISTS "cdn_webhook_deliveries" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "webhook_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'retrying',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_status" INTEGER,
    "next_retry" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cdn_webhook_deliveries_hook" ON "cdn_webhook_deliveries"("webhook_id");
CREATE INDEX IF NOT EXISTS "idx_cdn_webhook_deliveries_status" ON "cdn_webhook_deliveries"("status");

CREATE TABLE IF NOT EXISTS "cdn_cache_purges" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "paths" TEXT[] NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cdn_cache_purges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_cdn_cache_purges_project" ON "cdn_cache_purges"("project_id");
