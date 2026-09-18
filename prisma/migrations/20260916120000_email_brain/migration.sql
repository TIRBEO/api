-- Tirbeo Email Brain: event registry, versioned content, queue, digests, AI ledger.
-- Additive-only migration (safe to apply). Docs: docs/email-brain/01-architecture.md

CREATE TABLE IF NOT EXISTS "email_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "event_key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "delivery" TEXT NOT NULL DEFAULT 'immediate',
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "default_vars" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_events_event_key_key" ON "email_events"("event_key");
CREATE INDEX IF NOT EXISTS "email_events_category_idx" ON "email_events"("category");

CREATE TABLE IF NOT EXISTS "email_definitions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "event_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "active_version_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_definitions_event_name" ON "email_definitions"("event_key", "name");
CREATE INDEX IF NOT EXISTS "email_definitions_status_idx" ON "email_definitions"("status");

CREATE TABLE IF NOT EXISTS "email_versions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "definition_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "origin" TEXT NOT NULL DEFAULT 'ai',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_versions_def_lang_ver" ON "email_versions"("definition_id", "language", "version");
CREATE INDEX IF NOT EXISTS "idx_email_versions_def_status" ON "email_versions"("definition_id", "status");

CREATE TABLE IF NOT EXISTS "email_jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "dedupe_key" TEXT,
    "event_key" TEXT NOT NULL,
    "user_id" TEXT,
    "to_email" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "content_version_id" TEXT,
    "definition_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_jobs_dedupe" ON "email_jobs"("dedupe_key");
CREATE INDEX IF NOT EXISTS "idx_email_jobs_poll" ON "email_jobs"("status", "available_at");
CREATE INDEX IF NOT EXISTS "idx_email_jobs_event_time" ON "email_jobs"("event_key", "created_at");
CREATE INDEX IF NOT EXISTS "idx_email_jobs_recipient_time" ON "email_jobs"("to_email", "created_at");

CREATE TABLE IF NOT EXISTS "email_deliveries" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT,
    "to_email" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "provider" TEXT,
    "message_id" TEXT,
    "content_version_id" TEXT,
    "opened_at" TIMESTAMPTZ(6),
    "clicked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_email_deliveries_event_time" ON "email_deliveries"("event_key", "created_at");
CREATE INDEX IF NOT EXISTS "idx_email_deliveries_user_time" ON "email_deliveries"("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_email_deliveries_message" ON "email_deliveries"("message_id");

CREATE TABLE IF NOT EXISTS "email_preferences" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'default',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_prefs_user_event" ON "email_preferences"("user_id", "event_key");

CREATE TABLE IF NOT EXISTS "email_digest_items" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "entity_group" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "importance" INTEGER NOT NULL DEFAULT 0,
    "dedupe_key" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_digest_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_email_digest_items_dedupe" ON "email_digest_items"("user_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "idx_email_digest_items_poll" ON "email_digest_items"("user_id", "consumed", "created_at");

CREATE TABLE IF NOT EXISTS "email_digests" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "range_start" TIMESTAMPTZ(6) NOT NULL,
    "range_end" TIMESTAMPTZ(6) NOT NULL,
    "ai_enhanced" BOOLEAN NOT NULL DEFAULT false,
    "content_version_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_digests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_email_digests_user" ON "email_digests"("user_id", "cadence", "created_at");

CREATE TABLE IF NOT EXISTS "email_suppressions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "user_id" TEXT,
    "to_email" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_email_suppressions_event" ON "email_suppressions"("event_key", "created_at");

CREATE TABLE IF NOT EXISTS "email_provider_events" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "provider" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "message_id" TEXT,
    "to_email" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_provider_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_email_provider_events_message" ON "email_provider_events"("message_id");
CREATE INDEX IF NOT EXISTS "idx_email_provider_events_processed" ON "email_provider_events"("processed");

CREATE TABLE IF NOT EXISTS "ai_generations" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "task" TEXT NOT NULL,
    "fingerprint" TEXT,
    "event_key" TEXT,
    "model" TEXT NOT NULL,
    "tone" TEXT,
    "instruction" TEXT,
    "target_lang" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_estimate" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "error" TEXT,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "requested_by" TEXT,
    "result_subject" TEXT,
    "result_blocks" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_generations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_ai_generations_fingerprint" ON "ai_generations"("fingerprint");
CREATE INDEX IF NOT EXISTS "idx_ai_generations_task_time" ON "ai_generations"("task", "created_at");
