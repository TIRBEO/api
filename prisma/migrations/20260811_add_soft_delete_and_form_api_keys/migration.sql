-- AlterTable: Add soft delete fields to forms
ALTER TABLE "forms" ADD COLUMN "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "forms" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "forms" ADD COLUMN "deleted_by" TEXT;

-- AlterTable: Add soft delete fields to responses
ALTER TABLE "responses" ADD COLUMN "is_deleted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "responses" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "responses" ADD COLUMN "deleted_by" TEXT;
ALTER TABLE "responses" ADD COLUMN "is_starred" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "responses" ADD COLUMN "tags" JSONB DEFAULT '[]';

-- CreateTable: Form-specific API keys
CREATE TABLE "form_api_keys" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "form_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "permissions" JSONB DEFAULT '{"submit": true}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "form_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Form audit logs
CREATE TABLE "form_audit_logs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "form_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "metadata" JSONB DEFAULT '{}',
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Form API keys
CREATE UNIQUE INDEX "form_api_keys_key_hash_key" ON "form_api_keys"("key_hash");
CREATE INDEX "form_api_keys_form_id_idx" ON "form_api_keys"("form_id");
CREATE INDEX "form_api_keys_owner_id_idx" ON "form_api_keys"("owner_id");
CREATE INDEX "form_api_keys_key_hash_idx" ON "form_api_keys"("key_hash");
CREATE INDEX "form_api_keys_key_prefix_idx" ON "form_api_keys"("key_prefix");

-- CreateIndex: Form audit logs
CREATE INDEX "form_audit_logs_form_id_idx" ON "form_audit_logs"("form_id");
CREATE INDEX "form_audit_logs_actor_id_idx" ON "form_audit_logs"("actor_id");
CREATE INDEX "form_audit_logs_action_idx" ON "form_audit_logs"("action");
CREATE INDEX "form_audit_logs_target_type_target_id_idx" ON "form_audit_logs"("target_type", "target_id");
CREATE INDEX "form_audit_logs_created_at_idx" ON "form_audit_logs"("created_at");

-- CreateIndex: Soft delete indexes
CREATE INDEX "forms_is_deleted_idx" ON "forms"("is_deleted");
CREATE INDEX "forms_deleted_at_idx" ON "forms"("deleted_at");
CREATE INDEX "responses_is_deleted_idx" ON "responses"("is_deleted");
CREATE INDEX "responses_deleted_at_idx" ON "responses"("deleted_at");
CREATE INDEX "responses_is_starred_idx" ON "responses"("is_starred");

-- AddForeignKey: Form API keys
ALTER TABLE "form_api_keys" ADD CONSTRAINT "form_api_keys_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "form_api_keys" ADD CONSTRAINT "form_api_keys_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey: Form audit logs
ALTER TABLE "form_audit_logs" ADD CONSTRAINT "form_audit_logs_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "form_audit_logs" ADD CONSTRAINT "form_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
