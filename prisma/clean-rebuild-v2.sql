DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA IF NOT EXISTS "public";
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "activity";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "content";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "email";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "forms";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "media";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ops";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "preferences";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "security";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "status";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "support";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "user";

-- CreateEnum
CREATE TYPE "user"."user_status_kind" AS ENUM ('active', 'restricted', 'suspended', 'deactivated', 'deletion_pending', 'deleted');

-- CreateEnum
CREATE TYPE "activity"."severity" AS ENUM ('info', 'warning', 'error', 'critical');

-- CreateEnum
CREATE TYPE "email"."email_job_kind" AS ENUM ('otp', 'verify', 'reset', 'digest', 'notice', 'test');

-- CreateEnum
CREATE TYPE "security"."session_status" AS ENUM ('active', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "user"."users" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL DEFAULT '',
    "name" TEXT,
    "photo_url" TEXT,
    "status" "user"."user_status_kind" NOT NULL DEFAULT 'active',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "admin_role" TEXT,
    "email_verified" BOOLEAN DEFAULT false,
    "phone_verified" BOOLEAN DEFAULT false,
    "google_id" TEXT,
    "github_id" TEXT,
    "discord_id" TEXT,
    "theme" TEXT DEFAULT 'system',
    "language" TEXT DEFAULT 'en',
    "timezone" TEXT,
    "consents" JSONB DEFAULT '{}',
    "notification_preferences" JSONB DEFAULT '{"email":true,"push":true,"security":true,"forms":true,"product":false,"support":true,"formsEmail":true,"formsPush":true,"productEmail":false,"productPush":true,"supportEmail":true,"supportPush":true,"digestEnabled":false,"digestFrequency":"daily"}',
    "email_unsubscribed" JSONB DEFAULT '{}',
    "totp_secret" TEXT,
    "is_2fa_enabled" BOOLEAN DEFAULT false,
    "backupCodes" JSONB DEFAULT '[]',
    "must_change_password" BOOLEAN DEFAULT false,
    "is_banned" BOOLEAN DEFAULT false,
    "is_suspended" BOOLEAN DEFAULT false,
    "suspend_reason" TEXT,
    "suspended_until" TIMESTAMPTZ(6),
    "ban_ref_code" TEXT,
    "suspend_ref_code" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "scheduled_deletion_at" TIMESTAMPTZ(6),
    "deletion_reason" TEXT,
    "last_active_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user"."user_profile" (
    "user_id" TEXT NOT NULL,
    "name" TEXT,
    "bio" TEXT,
    "gender" TEXT,
    "birthday" DATE,
    "photo_url" TEXT,
    "banner_url" TEXT,
    "pronouns" TEXT,
    "location" TEXT,
    "website" TEXT,
    "job_role" TEXT,
    "job_company" TEXT,
    "job_place" TEXT,
    "job_started" TEXT,
    "skills" JSONB NOT NULL DEFAULT '[]',
    "followers" INTEGER NOT NULL DEFAULT 0,
    "following" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "preferences"."user_preferences" (
    "user_id" TEXT NOT NULL,
    "appearance" JSONB NOT NULL DEFAULT '{}',
    "notif" JSONB NOT NULL DEFAULT '{}',
    "privacy" JSONB NOT NULL DEFAULT '{}',
    "misc" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "email"."user_email" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'primary',
    "verified_at" TIMESTAMPTZ(6),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user"."user_phone" (
    "user_id" TEXT NOT NULL,
    "number" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_phone_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "security"."user_security" (
    "user_id" TEXT NOT NULL,
    "totp_secret" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "backup_codes" JSONB NOT NULL DEFAULT '[]',
    "must_change_pw" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_security_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "security"."passkeys" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "credential_pubkey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT,
    "device_name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "passkeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."user_sessions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "security"."session_status" DEFAULT 'active',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "device_name" TEXT,
    "location" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."user_devices" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "device_name" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."otps" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "kind" TEXT NOT NULL,
    "address" TEXT,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status"."user_status_events" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "from_status" "user"."user_status_kind",
    "to_status" "user"."user_status_kind" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status"."user_deletion_requests" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "reason" TEXT,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "final_at" TIMESTAMPTZ(6) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    "executed_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status"."user_deactivations" (
    "user_id" TEXT NOT NULL,
    "reason" TEXT,
    "paused_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_deactivations_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "status"."user_restrictions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "guideline" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status"."user_appeals" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "restriction_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "decision" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity"."activity_events" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "severity" "activity"."severity" NOT NULL DEFAULT 'info',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user"."notifications" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "icon" TEXT,
    "link" TEXT,
    "is_read" BOOLEAN DEFAULT false,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."user_logins" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "location" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_logins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_templates" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "slug" TEXT NOT NULL,
    "label" TEXT,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_jobs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "dedupe_key" TEXT,
    "event_key" TEXT NOT NULL DEFAULT '',
    "to_email" TEXT NOT NULL DEFAULT '',
    "to_address" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'other',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "kind" "email"."email_job_kind" NOT NULL DEFAULT 'notice',
    "template_slug" TEXT,
    "subject" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "content_version_id" TEXT,
    "definition_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "last_error" TEXT,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_deliveries" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "job_id" TEXT,
    "user_id" TEXT,
    "to_email" TEXT NOT NULL DEFAULT '',
    "event_key" TEXT NOT NULL DEFAULT '',
    "event" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'other',
    "subject" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'sent',
    "provider" TEXT,
    "provider_id" TEXT,
    "message_id" TEXT,
    "content_version_id" TEXT,
    "opened_at" TIMESTAMPTZ(6),
    "clicked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_suppressions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "address" TEXT,
    "to_email" TEXT NOT NULL DEFAULT '',
    "event_key" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL DEFAULT 'unsubscribe',
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."app_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ops"."api_keys" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "permissions" JSONB DEFAULT '{}',
    "is_active" BOOLEAN DEFAULT true,
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."blocklist" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT,
    "blocked_by" TEXT,
    "is_active" BOOLEAN DEFAULT true,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."media" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "uploaded_by" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "duration" DOUBLE PRECISION,
    "alt_text" TEXT,
    "is_public" BOOLEAN DEFAULT true,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."captcha_challenges" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "difficulty" TEXT NOT NULL DEFAULT 'easy',
    "challengeType" TEXT NOT NULL DEFAULT 'image',
    "question" TEXT NOT NULL,
    "answer_hash" TEXT NOT NULL,
    "options" JSONB,
    "image_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "solved" BOOLEAN NOT NULL DEFAULT false,
    "solved_at" TIMESTAMPTZ(6),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "rayId" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,

    CONSTRAINT "captcha_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."captcha_attempts" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "challenge_id" TEXT NOT NULL,
    "user_id" TEXT,
    "session_id" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "is_correct" BOOLEAN NOT NULL DEFAULT false,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "captcha_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."captcha_blocks" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "session_id" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'hard',
    "blocked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "unblocked_at" TIMESTAMPTZ(6),
    "unblocked_by" TEXT,
    "rayId" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "metadata" JSONB,

    CONSTRAINT "captcha_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."captcha_logs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "session_id" TEXT NOT NULL,
    "ip_address" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "difficulty" TEXT,
    "ray_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "captcha_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."captcha_settings" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "captcha_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content"."incident_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "user_id" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity" TEXT NOT NULL DEFAULT 'error',
    "source" TEXT NOT NULL DEFAULT 'client',
    "stack" TEXT,
    "url" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."forms" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "access_key" TEXT NOT NULL DEFAULT '',
    "form_type" TEXT NOT NULL DEFAULT 'custom',
    "website_url" TEXT,
    "success_message" TEXT DEFAULT 'Thanks! Your submission has been received.',
    "success_redirect" TEXT,
    "redirect_target" TEXT NOT NULL DEFAULT '_self',
    "custom_success_html" TEXT,
    "notification_emails" TEXT[],
    "cc_emails" TEXT[],
    "bcc_emails" TEXT[],
    "reply_to_email" TEXT,
    "email_subject" TEXT,
    "from_name" TEXT,
    "auto_reply" BOOLEAN NOT NULL DEFAULT false,
    "auto_reply_subject" TEXT,
    "auto_reply_body" TEXT,
    "spam_protection" TEXT NOT NULL DEFAULT 'automatic',
    "turnstile_key" TEXT,
    "rate_limit" INTEGER NOT NULL DEFAULT 60,
    "allowed_origins" TEXT[],
    "honeypot" BOOLEAN NOT NULL DEFAULT true,
    "store_responses" BOOLEAN NOT NULL DEFAULT true,
    "retention" TEXT NOT NULL DEFAULT 'forever',
    "show_metadata" BOOLEAN NOT NULL DEFAULT false,
    "layout" TEXT NOT NULL DEFAULT 'comfortable',
    "width" TEXT NOT NULL DEFAULT 'full',
    "alignment" TEXT NOT NULL DEFAULT 'left',
    "label_position" TEXT NOT NULL DEFAULT 'above',
    "theme" TEXT NOT NULL DEFAULT 'light',
    "custom_css" TEXT,
    "headless" BOOLEAN NOT NULL DEFAULT false,
    "header_image" TEXT,
    "accent_color" TEXT NOT NULL DEFAULT '#09090b',
    "bg_color" TEXT NOT NULL DEFAULT '#ffffff',
    "header_font" TEXT NOT NULL DEFAULT 'Roboto',
    "question_font" TEXT NOT NULL DEFAULT 'Roboto',
    "header_image_height" INTEGER NOT NULL DEFAULT 200,
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "last_submission_at" TIMESTAMPTZ(6),
    "conversion_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."form_fields" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "form_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "placeholder" TEXT,
    "help_text" TEXT,
    "default_value" JSONB,
    "options" JSONB,
    "validation" JSONB,
    "appearance" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "read_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."form_submissions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "form_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB,
    "source" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "referrer" TEXT,
    "country" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."form_analytics" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "form_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "starts" INTEGER NOT NULL DEFAULT 0,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "failed_submissions" INTEGER NOT NULL DEFAULT 0,
    "avg_completion_time" DOUBLE PRECISION,
    "device_breakdown" JSONB,
    "country_breakdown" JSONB,
    "referrer_breakdown" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forms"."form_connections" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "form_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."tickets" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'open',
    "source" TEXT NOT NULL DEFAULT 'web',
    "application" TEXT,
    "assigned_id" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."ticket_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "read_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support"."ticket_attachments" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "ticket_id" TEXT NOT NULL,
    "message_id" TEXT,
    "file_name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" INTEGER,
    "mime_type" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_files" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "path" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "folder" BOOLEAN NOT NULL DEFAULT false,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bucket_id" TEXT,
    "storage_key" TEXT,
    "visibility" TEXT DEFAULT 'public',
    "etag" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "checksum" TEXT,
    "cache_control" TEXT,
    "content_disposition" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "deleted_at" TIMESTAMPTZ(6),
    "project_id" TEXT,
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
CREATE TABLE "media"."cdn_buckets" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "storage_provider" TEXT NOT NULL DEFAULT 'tirbeo',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_projects" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "owner_id" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "settings" JSONB DEFAULT '{}',
    "quotas" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_domains" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "domain" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'cdn',
    "path_prefix" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "txt_token" TEXT,
    "ssl_status" TEXT DEFAULT 'pending',
    "ssl_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_hosting_configs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
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

-- CreateTable
CREATE TABLE "media"."cdn_webhooks" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_webhook_deliveries" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
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

-- CreateTable
CREATE TABLE "media"."cdn_cache_purges" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "project_id" TEXT NOT NULL DEFAULT 'default',
    "paths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_cache_purges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_activity" (
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
CREATE TABLE "media"."cdn_settings" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cdn_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."cdn_categories" (
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

-- CreateTable
CREATE TABLE "ops"."verification_limits" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "method" TEXT NOT NULL,
    "max" INTEGER NOT NULL,
    "window_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."cooldowns" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "key" TEXT NOT NULL,
    "last_sent" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cooldowns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content"."landing_pages" (
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

-- CreateTable
CREATE TABLE "content"."landing_page_publications" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "landing_page_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "published_by" TEXT,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "landing_page_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops"."ai_generations" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
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

-- CreateTable
CREATE TABLE "security"."security_events" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "severity" "activity"."severity" NOT NULL DEFAULT 'info',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security"."device_accounts" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity"."user_tip_logs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "tip_id" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tip_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user"."push_subscriptions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user"."identities" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "verified_source" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_configs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "provider" TEXT NOT NULL DEFAULT 'resend',
    "resendApiKey" TEXT,
    "resendDomain" TEXT DEFAULT 'send.tirbeo.com',
    "smtpHost" TEXT,
    "smtpPort" INTEGER DEFAULT 587,
    "smtpUser" TEXT,
    "smtpPass" TEXT,
    "defaultFromEmail" TEXT NOT NULL DEFAULT 'noreply@send.tirbeo.com',
    "defaultFromName" TEXT NOT NULL DEFAULT 'Tirbeo',
    "welcomeFromEmail" TEXT,
    "welcomeFromName" TEXT,
    "otpFromEmail" TEXT,
    "otpFromName" TEXT,
    "resetFromEmail" TEXT,
    "resetFromName" TEXT,
    "notifyFromEmail" TEXT,
    "notifyFromName" TEXT,
    "alertFromEmail" TEXT,
    "alertFromName" TEXT,
    "formsFromEmail" TEXT DEFAULT 'forms@send.tirbeo.com',
    "formsFromName" TEXT DEFAULT 'Tirbeo Forms',
    "customDomain" TEXT,
    "dkimEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_events" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "event_key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "delivery" TEXT NOT NULL DEFAULT 'immediate',
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "default_vars" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_definitions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "event_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "active_version_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_versions" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
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

-- CreateTable
CREATE TABLE "email"."email_preferences" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "user_id" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'default',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email"."email_digest_items" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
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

-- CreateTable
CREATE TABLE "email"."email_digests" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
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

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "user"."users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "user"."users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_id_key" ON "user"."users"("google_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_github_id_key" ON "user"."users"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_discord_id_key" ON "user"."users"("discord_id");

-- CreateIndex
CREATE INDEX "idx_users_status" ON "user"."users"("status");

-- CreateIndex
CREATE INDEX "idx_users_created" ON "user"."users"("created_at");

-- CreateIndex
CREATE INDEX "idx_users_last_active" ON "user"."users"("last_active_at");

-- CreateIndex
CREATE INDEX "idx_users_deleted" ON "user"."users"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_user_email_user" ON "email"."user_email"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_user_id_address_key" ON "email"."user_email"("user_id", "address");

-- CreateIndex
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "security"."passkeys"("credential_id");

-- CreateIndex
CREATE INDEX "idx_passkeys_user" ON "security"."passkeys"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_sessions_user" ON "security"."user_sessions"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_sessions_hash" ON "security"."user_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "idx_user_sessions_expires" ON "security"."user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "idx_user_devices_user" ON "security"."user_devices"("user_id");

-- CreateIndex
CREATE INDEX "idx_otps_user" ON "security"."otps"("user_id");

-- CreateIndex
CREATE INDEX "idx_otps_expires" ON "security"."otps"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "otps_kind_address_key" ON "security"."otps"("kind", "address");

-- CreateIndex
CREATE INDEX "idx_user_status_events_user" ON "status"."user_status_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_deletion_requests_user_id_key" ON "status"."user_deletion_requests"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_deletion_pending" ON "status"."user_deletion_requests"("final_at");

-- CreateIndex
CREATE INDEX "idx_user_restrictions_user" ON "status"."user_restrictions"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_appeals_restriction" ON "status"."user_appeals"("restriction_id");

-- CreateIndex
CREATE INDEX "idx_activity_user" ON "activity"."activity_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_activity_kind" ON "activity"."activity_events"("kind");

-- CreateIndex
CREATE INDEX "idx_activity_created" ON "activity"."activity_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_notifications_created" ON "user"."notifications"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_notifications_read" ON "user"."notifications"("is_read");

-- CreateIndex
CREATE INDEX "idx_notifications_user" ON "user"."notifications"("user_id");

-- CreateIndex
CREATE INDEX "idx_notifications_user_read" ON "user"."notifications"("user_id", "is_read");

-- CreateIndex
CREATE INDEX "idx_notifications_user_created" ON "user"."notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_user_logins_user" ON "security"."user_logins"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "email_templates_slug_key" ON "email"."email_templates"("slug");

-- CreateIndex
CREATE INDEX "idx_email_jobs_poll" ON "email"."email_jobs"("status", "available_at");

-- CreateIndex
CREATE INDEX "idx_email_jobs_event_time" ON "email"."email_jobs"("event_key", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_jobs_recipient_time" ON "email"."email_jobs"("to_email", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_jobs_status" ON "email"."email_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_jobs_user" ON "email"."email_jobs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_email_jobs_dedupe" ON "email"."email_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "idx_email_deliveries_job" ON "email"."email_deliveries"("job_id");

-- CreateIndex
CREATE INDEX "idx_email_deliveries_event_time" ON "email"."email_deliveries"("event_key", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_deliveries_user_time" ON "email"."email_deliveries"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_deliveries_message" ON "email"."email_deliveries"("message_id");

-- CreateIndex
CREATE INDEX "idx_email_deliveries_status" ON "email"."email_deliveries"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_address_key" ON "email"."email_suppressions"("address");

-- CreateIndex
CREATE INDEX "idx_email_suppressions_event" ON "email"."email_suppressions"("event_key", "created_at");

-- CreateIndex
CREATE INDEX "idx_email_suppressions_user" ON "email"."email_suppressions"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "ops"."api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_api_keys_hash" ON "ops"."api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "idx_api_keys_prefix" ON "ops"."api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "idx_api_keys_user" ON "ops"."api_keys"("user_id");

-- CreateIndex
CREATE INDEX "idx_blocklist_active" ON "security"."blocklist"("is_active");

-- CreateIndex
CREATE INDEX "idx_blocklist_type" ON "security"."blocklist"("target_type");

-- CreateIndex
CREATE UNIQUE INDEX "blocklist_target_type_target_id_key" ON "security"."blocklist"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "idx_media_mime" ON "media"."media"("mime_type");

-- CreateIndex
CREATE INDEX "idx_media_public" ON "media"."media"("is_public");

-- CreateIndex
CREATE INDEX "idx_media_uploader" ON "media"."media"("uploaded_by");

-- CreateIndex
CREATE UNIQUE INDEX "captcha_challenges_rayId_key" ON "security"."captcha_challenges"("rayId");

-- CreateIndex
CREATE INDEX "captcha_challenges_session_id_idx" ON "security"."captcha_challenges"("session_id");

-- CreateIndex
CREATE INDEX "captcha_challenges_user_id_idx" ON "security"."captcha_challenges"("user_id");

-- CreateIndex
CREATE INDEX "captcha_challenges_rayId_idx" ON "security"."captcha_challenges"("rayId");

-- CreateIndex
CREATE INDEX "captcha_challenges_difficulty_idx" ON "security"."captcha_challenges"("difficulty");

-- CreateIndex
CREATE INDEX "captcha_attempts_challenge_id_idx" ON "security"."captcha_attempts"("challenge_id");

-- CreateIndex
CREATE INDEX "captcha_attempts_user_id_idx" ON "security"."captcha_attempts"("user_id");

-- CreateIndex
CREATE INDEX "captcha_attempts_session_id_idx" ON "security"."captcha_attempts"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "captcha_blocks_rayId_key" ON "security"."captcha_blocks"("rayId");

-- CreateIndex
CREATE INDEX "captcha_blocks_user_id_idx" ON "security"."captcha_blocks"("user_id");

-- CreateIndex
CREATE INDEX "captcha_blocks_session_id_idx" ON "security"."captcha_blocks"("session_id");

-- CreateIndex
CREATE INDEX "captcha_blocks_ip_address_idx" ON "security"."captcha_blocks"("ip_address");

-- CreateIndex
CREATE INDEX "captcha_blocks_rayId_idx" ON "security"."captcha_blocks"("rayId");

-- CreateIndex
CREATE INDEX "captcha_logs_user_id_idx" ON "security"."captcha_logs"("user_id");

-- CreateIndex
CREATE INDEX "captcha_logs_session_id_idx" ON "security"."captcha_logs"("session_id");

-- CreateIndex
CREATE INDEX "captcha_logs_ip_address_idx" ON "security"."captcha_logs"("ip_address");

-- CreateIndex
CREATE INDEX "captcha_logs_event_type_idx" ON "security"."captcha_logs"("event_type");

-- CreateIndex
CREATE INDEX "captcha_logs_ray_id_idx" ON "security"."captcha_logs"("ray_id");

-- CreateIndex
CREATE UNIQUE INDEX "captcha_settings_key_key" ON "security"."captcha_settings"("key");

-- CreateIndex
CREATE INDEX "incident_events_type_idx" ON "content"."incident_events"("type");

-- CreateIndex
CREATE INDEX "incident_events_user_id_idx" ON "content"."incident_events"("user_id");

-- CreateIndex
CREATE INDEX "incident_events_created_at_idx" ON "content"."incident_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "forms_slug_key" ON "forms"."forms"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "forms_access_key_key" ON "forms"."forms"("access_key");

-- CreateIndex
CREATE INDEX "forms_user_id_idx" ON "forms"."forms"("user_id");

-- CreateIndex
CREATE INDEX "forms_status_idx" ON "forms"."forms"("status");

-- CreateIndex
CREATE INDEX "forms_slug_idx" ON "forms"."forms"("slug");

-- CreateIndex
CREATE INDEX "form_fields_form_id_idx" ON "forms"."form_fields"("form_id");

-- CreateIndex
CREATE INDEX "form_submissions_form_id_idx" ON "forms"."form_submissions"("form_id");

-- CreateIndex
CREATE INDEX "form_submissions_created_at_idx" ON "forms"."form_submissions"("created_at");

-- CreateIndex
CREATE INDEX "form_submissions_form_id_created_at_idx" ON "forms"."form_submissions"("form_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "form_analytics_form_id_idx" ON "forms"."form_analytics"("form_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_analytics_form_id_date_key" ON "forms"."form_analytics"("form_id", "date");

-- CreateIndex
CREATE INDEX "form_connections_form_id_idx" ON "forms"."form_connections"("form_id");

-- CreateIndex
CREATE INDEX "tickets_customer_id_idx" ON "support"."tickets"("customer_id");

-- CreateIndex
CREATE INDEX "tickets_status_idx" ON "support"."tickets"("status");

-- CreateIndex
CREATE INDEX "tickets_assigned_id_idx" ON "support"."tickets"("assigned_id");

-- CreateIndex
CREATE INDEX "tickets_created_at_idx" ON "support"."tickets"("created_at");

-- CreateIndex
CREATE INDEX "tickets_priority_idx" ON "support"."tickets"("priority");

-- CreateIndex
CREATE INDEX "idx_tickets_status_created" ON "support"."tickets"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_tickets_customer_created" ON "support"."tickets"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_messages_ticket_id_idx" ON "support"."ticket_messages"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_messages_author_id_idx" ON "support"."ticket_messages"("author_id");

-- CreateIndex
CREATE INDEX "ticket_attachments_ticket_id_idx" ON "support"."ticket_attachments"("ticket_id");

-- CreateIndex
CREATE INDEX "ticket_attachments_message_id_idx" ON "support"."ticket_attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "cdn_files_path_key" ON "media"."cdn_files"("path");

-- CreateIndex
CREATE INDEX "idx_cdn_files_uploader" ON "media"."cdn_files"("uploaded_by");

-- CreateIndex
CREATE INDEX "idx_cdn_files_status" ON "media"."cdn_files"("status");

-- CreateIndex
CREATE INDEX "idx_cdn_files_mime" ON "media"."cdn_files"("mime_type");

-- CreateIndex
CREATE INDEX "idx_cdn_files_created" ON "media"."cdn_files"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_cdn_files_filename" ON "media"."cdn_files"("filename");

-- CreateIndex
CREATE INDEX "idx_cdn_files_bucket" ON "media"."cdn_files"("bucket_id");

-- CreateIndex
CREATE INDEX "idx_cdn_buckets_project" ON "media"."cdn_buckets"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cdn_buckets_project_slug" ON "media"."cdn_buckets"("project_id", "slug");

-- CreateIndex
CREATE INDEX "idx_cdn_projects_owner" ON "media"."cdn_projects"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cdn_projects_owner_slug" ON "media"."cdn_projects"("owner_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "cdn_domains_domain_key" ON "media"."cdn_domains"("domain");

-- CreateIndex
CREATE INDEX "idx_cdn_domains_project" ON "media"."cdn_domains"("project_id");

-- CreateIndex
CREATE INDEX "idx_cdn_domains_status" ON "media"."cdn_domains"("status");

-- CreateIndex
CREATE INDEX "idx_cdn_domains_type" ON "media"."cdn_domains"("type");

-- CreateIndex
CREATE INDEX "idx_cdn_hosting_project" ON "media"."cdn_hosting_configs"("project_id");

-- CreateIndex
CREATE INDEX "idx_cdn_webhooks_project" ON "media"."cdn_webhooks"("project_id");

-- CreateIndex
CREATE INDEX "idx_cdn_webhook_deliveries_hook" ON "media"."cdn_webhook_deliveries"("webhook_id");

-- CreateIndex
CREATE INDEX "idx_cdn_webhook_deliveries_status" ON "media"."cdn_webhook_deliveries"("status");

-- CreateIndex
CREATE INDEX "idx_cdn_cache_purges_project" ON "media"."cdn_cache_purges"("project_id");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_type" ON "media"."cdn_activity"("type");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_file" ON "media"."cdn_activity"("file_id");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_actor" ON "media"."cdn_activity"("actor");

-- CreateIndex
CREATE INDEX "idx_cdn_activity_created" ON "media"."cdn_activity"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cdn_settings_key_key" ON "media"."cdn_settings"("key");

-- CreateIndex
CREATE UNIQUE INDEX "cdn_categories_key_key" ON "media"."cdn_categories"("key");

-- CreateIndex
CREATE INDEX "idx_cdn_categories_key" ON "media"."cdn_categories"("key");

-- CreateIndex
CREATE INDEX "idx_cdn_categories_order" ON "media"."cdn_categories"("order");

-- CreateIndex
CREATE UNIQUE INDEX "verification_limits_method_key" ON "ops"."verification_limits"("method");

-- CreateIndex
CREATE UNIQUE INDEX "cooldowns_key_key" ON "ops"."cooldowns"("key");

-- CreateIndex
CREATE INDEX "idx_cooldowns_expires" ON "ops"."cooldowns"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "landing_pages_slug_key" ON "content"."landing_pages"("slug");

-- CreateIndex
CREATE INDEX "idx_landing_pages_published_at" ON "content"."landing_pages"("published_at" DESC);

-- CreateIndex
CREATE INDEX "idx_landing_page_publications_page_published" ON "content"."landing_page_publications"("landing_page_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "idx_landing_page_publications_page_version" ON "content"."landing_page_publications"("landing_page_id", "version");

-- CreateIndex
CREATE INDEX "idx_ai_generations_fingerprint" ON "ops"."ai_generations"("fingerprint");

-- CreateIndex
CREATE INDEX "idx_ai_generations_task_time" ON "ops"."ai_generations"("task", "created_at");

-- CreateIndex
CREATE INDEX "idx_security_events_created" ON "security"."security_events"("created_at");

-- CreateIndex
CREATE INDEX "idx_security_events_type" ON "security"."security_events"("event_type");

-- CreateIndex
CREATE INDEX "idx_security_events_user" ON "security"."security_events"("user_id");

-- CreateIndex
CREATE INDEX "idx_security_events_user_created" ON "security"."security_events"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_security_events_severity_created" ON "security"."security_events"("severity", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_device_accounts_user" ON "security"."device_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_device_accounts_device_user" ON "security"."device_accounts"("device_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_tip_logs_user" ON "activity"."user_tip_logs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tip_logs_user_id_tip_id_key" ON "activity"."user_tip_logs"("user_id", "tip_id");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "user"."push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "idx_push_subscriptions_user" ON "user"."push_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "idx_push_subscriptions_endpoint" ON "user"."push_subscriptions"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "identities_username_key" ON "user"."identities"("username");

-- CreateIndex
CREATE INDEX "idx_tirbeo_identities_user" ON "user"."identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_events_event_key_key" ON "email"."email_events"("event_key");

-- CreateIndex
CREATE INDEX "email_events_category_idx" ON "email"."email_events"("category");

-- CreateIndex
CREATE INDEX "email_definitions_status_idx" ON "email"."email_definitions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "idx_email_definitions_event_name" ON "email"."email_definitions"("event_key", "name");

-- CreateIndex
CREATE INDEX "idx_email_versions_def_status" ON "email"."email_versions"("definition_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "idx_email_versions_def_lang_ver" ON "email"."email_versions"("definition_id", "language", "version");

-- CreateIndex
CREATE UNIQUE INDEX "idx_email_prefs_user_event" ON "email"."email_preferences"("user_id", "event_key");

-- CreateIndex
CREATE INDEX "idx_email_digest_items_poll" ON "email"."email_digest_items"("user_id", "consumed", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idx_email_digest_items_dedupe" ON "email"."email_digest_items"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "idx_email_digests_user" ON "email"."email_digests"("user_id", "cadence", "created_at");

-- AddForeignKey
ALTER TABLE "user"."user_profile" ADD CONSTRAINT "user_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preferences"."user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email"."user_email" ADD CONSTRAINT "user_email_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user"."user_phone" ADD CONSTRAINT "user_phone_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security"."user_security" ADD CONSTRAINT "user_security_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security"."passkeys" ADD CONSTRAINT "passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security"."user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security"."user_devices" ADD CONSTRAINT "user_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security"."otps" ADD CONSTRAINT "otps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status"."user_status_events" ADD CONSTRAINT "user_status_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status"."user_deletion_requests" ADD CONSTRAINT "user_deletion_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status"."user_deactivations" ADD CONSTRAINT "user_deactivations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status"."user_restrictions" ADD CONSTRAINT "user_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status"."user_appeals" ADD CONSTRAINT "user_appeals_restriction_id_fkey" FOREIGN KEY ("restriction_id") REFERENCES "status"."user_restrictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status"."user_appeals" ADD CONSTRAINT "user_appeals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity"."activity_events" ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user"."notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "security"."user_logins" ADD CONSTRAINT "user_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email"."email_jobs" ADD CONSTRAINT "email_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ops"."api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "security"."blocklist" ADD CONSTRAINT "blocklist_blocked_by_fkey" FOREIGN KEY ("blocked_by") REFERENCES "user"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "media"."media" ADD CONSTRAINT "media_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "security"."captcha_attempts" ADD CONSTRAINT "captcha_attempts_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "security"."captcha_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."forms" ADD CONSTRAINT "forms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."form_fields" ADD CONSTRAINT "form_fields_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."form_submissions" ADD CONSTRAINT "form_submissions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."form_analytics" ADD CONSTRAINT "form_analytics_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forms"."form_connections" ADD CONSTRAINT "form_connections_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"."forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_assigned_id_fkey" FOREIGN KEY ("assigned_id") REFERENCES "user"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "user"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."ticket_messages" ADD CONSTRAINT "ticket_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "user"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support"."ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support"."tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media"."cdn_files" ADD CONSTRAINT "cdn_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "user"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content"."landing_page_publications" ADD CONSTRAINT "landing_page_publications_landing_page_id_fkey" FOREIGN KEY ("landing_page_id") REFERENCES "content"."landing_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "security"."security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "security"."device_accounts" ADD CONSTRAINT "device_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "activity"."user_tip_logs" ADD CONSTRAINT "user_tip_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user"."push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user"."identities" ADD CONSTRAINT "identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "email"."email_definitions" ADD CONSTRAINT "email_definitions_event_key_fkey" FOREIGN KEY ("event_key") REFERENCES "email"."email_events"("event_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email"."email_versions" ADD CONSTRAINT "email_versions_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "email"."email_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

