-- CreateEnum
-- (enums already exist or not needed for these tables)

-- CreateTable
CREATE TABLE "cdn_files" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "path" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "commit_sha" TEXT,
    "github_commit_sha" TEXT,
    "uploaded_by" TEXT,
    "status" TEXT NOT NULL DEFAULT 'published',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cdn_activity" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "type" TEXT NOT NULL,
    "file_id" TEXT,
    "path" TEXT,
    "result" TEXT NOT NULL DEFAULT 'ok',
    "actor" TEXT,
    "actor_label" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cdn_settings" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cdn_categories" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "path_prefix" TEXT NOT NULL,
    "suggested_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cdn_files_path_key" ON "cdn_files"("path");

-- CreateIndex
CREATE INDEX "idx_cdn_files_uploader" ON "cdn_files"("uploaded_by");

-- CreateIndex
CREATE INDEX "idx_cdn_files_status" ON "cdn_files"("status");

-- CreateIndex
CREATE INDEX "idx_cdn_files_mime" ON "cdn_files"("mime_type");

-- CreateIndex
CREATE INDEX "idx_cdn_files_created" ON "cdn_files"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_cdn_files_filename" ON "cdn_files"("filename");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_type" ON "cdn_activity"("type");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_file" ON "cdn_activity"("file_id");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_actor" ON "cdn_activity"("actor");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_created" ON "cdn_activity"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cdn_settings_key_key" ON "cdn_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "cdn_categories_key_key" ON "cdn_categories"("key");

-- CreateIndex
CREATE INDEX "idx_cdn_categories_key" ON "cdn_categories"("key");

-- CreateIndex
CREATE INDEX "idx_cdn_categories_order" ON "cdn_categories"("order");

-- AddForeignKey
ALTER TABLE "cdn_files" ADD CONSTRAINT "cdn_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
