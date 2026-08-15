-- Add per-category x channel matrix columns
ALTER TABLE "notification_preferences" ADD COLUMN "security_email" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "security_push" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "security_in_app" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "forms_email" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "forms_push" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "forms_in_app" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "product_email" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "product_push" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "product_in_app" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "support_email" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "support_push" BOOLEAN DEFAULT true;
ALTER TABLE "notification_preferences" ADD COLUMN "support_in_app" BOOLEAN DEFAULT true;
-- Add quiet hours columns
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_hours_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_hours_start" TEXT DEFAULT '22:00';
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_hours_end" TEXT DEFAULT '08:00';
-- Add email digest columns
ALTER TABLE "notification_preferences" ADD COLUMN "digest_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "notification_preferences" ADD COLUMN "digest_frequency" TEXT DEFAULT 'daily';
