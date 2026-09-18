-- Add persistent per-user reference codes (SUS-… / BAN-…) so support & admins
-- can look up and unban/unsuspend a user from just the code shown on their
-- blocked page (e.g. SUS-5164ebcc). Nullable: generated on first ban/suspend.
ALTER TABLE "users" ADD COLUMN "ban_ref_code" TEXT;
ALTER TABLE "users" ADD COLUMN "suspend_ref_code" TEXT;
CREATE INDEX idx_users_ban_ref_code ON "users" ("ban_ref_code");
CREATE INDEX idx_users_suspend_ref_code ON "users" ("suspend_ref_code");