-- Persist the editable landing-page draft, the current public snapshot, and
-- immutable publication history for rollbacks and auditing.
CREATE TABLE IF NOT EXISTS "landing_pages" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "slug" TEXT NOT NULL DEFAULT 'home',
    "draft" JSONB NOT NULL DEFAULT '{}',
    "published_config" JSONB,
    "draft_version" INTEGER NOT NULL DEFAULT 1,
    "published_version" INTEGER,
    "published_at" TIMESTAMPTZ(6),
    "edited_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landing_pages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "landing_pages_slug_key" ON "landing_pages"("slug");
CREATE INDEX IF NOT EXISTS "idx_landing_pages_published_at" ON "landing_pages"("published_at" DESC);

CREATE TABLE IF NOT EXISTS "landing_page_publications" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "landing_page_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landing_page_publications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "landing_page_publications_landing_page_id_fkey"
      FOREIGN KEY ("landing_page_id") REFERENCES "landing_pages"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_page_publications_page_version"
  ON "landing_page_publications"("landing_page_id", "version");
CREATE INDEX IF NOT EXISTS "idx_landing_page_publications_page_published"
  ON "landing_page_publications"("landing_page_id", "published_at" DESC);
