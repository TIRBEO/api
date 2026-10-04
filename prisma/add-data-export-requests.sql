-- Tirbeo — add `activity.data_export_requests`
--
-- The "download my data" screen now asks which format the person wants (JSON or
-- HTML) *before* the file is made, so the choice has to live with the request
-- rather than only in the bytes handed to the browser. This table is that
-- request record; the archive itself is still never stored.
--
-- Source of truth: `prisma/schema.prisma` → model `DataExportRequest`
-- (DDL below is what `prisma migrate diff --from-config-datasource
-- --to-schema prisma/schema.prisma --script` produces for that model, wrapped so
-- the file can be re-run safely).
--
-- Apply:
--   npx prisma db execute --file prisma/add-data-export-requests.sql
--   npx prisma generate
-- Verify it left no drift:
--   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
--   → "-- This is an empty migration."
--
-- Nothing here drops or rewrites an existing table, and every statement is
-- idempotent.

-- CreateTable
CREATE TABLE IF NOT EXISTS "activity"."data_export_requests" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'json',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "file_name" TEXT NOT NULL,
    "bytes" INTEGER,
    "counts" JSONB DEFAULT '{}',
    "missing" JSONB,
    "truncated" JSONB,
    "error" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "built_at" TIMESTAMPTZ(6),

    CONSTRAINT "data_export_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_data_export_requests_user" ON "activity"."data_export_requests"("user_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_data_export_requests_status" ON "activity"."data_export_requests"("status");

-- AddForeignKey (guarded: ALTER TABLE has no IF NOT EXISTS)
DO $$ BEGIN
    ALTER TABLE "activity"."data_export_requests"
        ADD CONSTRAINT "data_export_requests_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill — the downloads already written on the account become requests here,
-- so the history a person sees does not empty out when the list starts reading
-- this table. Each row keeps the id of the activity event it came from, which is
-- what the existing `/settings/download-data/<id>` links point at, so those links
-- keep resolving.
--
-- Every one of them was a JSON file — the archive was JSON before a format
-- choice existed — so a row whose metadata names no format is written down as
-- 'json' rather than left blank. That is the one place legacy rows get their
-- format; the read path in `features/users/exportRequests.ts` says the same
-- thing for any row that still ends up without one.
INSERT INTO "activity"."data_export_requests" (
    "id", "user_id", "format", "status", "file_name", "bytes", "counts", "missing", "truncated",
    "requested_at", "built_at"
)
SELECT
    ae."id",
    ae."user_id",
    CASE
        WHEN lower(coalesce(ae."metadata" ->> 'format', '')) IN ('json', 'html')
            THEN lower(ae."metadata" ->> 'format')
        ELSE 'json'
    END,
    'ready',
    coalesce(ae."metadata" ->> 'fileName', 'tirbeo-account.json'),
    CASE WHEN ae."metadata" ->> 'bytes' ~ '^[0-9]+$' THEN (ae."metadata" ->> 'bytes')::integer ELSE NULL END,
    coalesce(ae."metadata" -> 'counts', '{}'::jsonb),
    ae."metadata" -> 'missing',
    ae."metadata" -> 'truncated',
    ae."created_at",
    ae."created_at"
FROM "activity"."activity_events" ae
WHERE ae."kind" = 'data.exported'
ON CONFLICT ("id") DO NOTHING;
