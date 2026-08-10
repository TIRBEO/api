-- Added in app code: recovery email verification state is now persisted.
ALTER TABLE "users" ADD COLUMN "secondary_email_verified" BOOLEAN NOT NULL DEFAULT false;
