-- Tirbeo — add `public.staff_roles`
--
-- Until now the console had one switch: `users.is_admin`. Somebody was staff
-- or was not, and every staff member could do everything — which is the reason
-- `requireRole('manager')` and `requireRole('admin')` behave identically today,
-- and the reason a helper who should answer tickets but not touch the blocklist
-- cannot exist.
--
-- This table is the assignment: one row per staff member, holding which role
-- they hold. What each role *means* is code (`features/auth/roles.ts`), because
-- a permission set is behaviour and behaviour belongs with the code that
-- enforces it; a row in the database cannot be reviewed by the person writing
-- the endpoint that checks it.
--
-- `users.is_admin` stays. It is the flag that makes an account staff at all,
-- and it is what the rest of the product already reads; this table says what
-- kind of staff. An account with `is_admin = true` and no row here is treated
-- as the legacy `admin` role, so nothing is locked out by this migration — the
-- seed below simply makes that explicit.
--
-- Source of truth: `prisma/schema.prisma` → model `StaffRole`.
--
-- Apply:
--   npx prisma db execute --file prisma/staff-roles.sql
--   npx prisma generate
-- Verify it left no drift:
--   npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
--   → "-- This is an empty migration."
--
-- Nothing here drops or rewrites an existing table, and every statement is
-- idempotent.

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."staff_roles" (
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "granted_by" TEXT,
    "note" TEXT,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_roles_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
-- Who handed the role over. Every grant is a staff action, and a console that
-- cannot say who made somebody an admin has no trail for its own most
-- consequential write.
CREATE INDEX IF NOT EXISTS "idx_staff_roles_granted_by" ON "public"."staff_roles"("granted_by");

-- CreateIndex
-- Reading the roster by role (the support queue asks "who can answer tickets")
-- is the other direction the table is queried from.
CREATE INDEX IF NOT EXISTS "idx_staff_roles_role" ON "public"."staff_roles"("role");

-- AddForeignKey (guarded: ALTER TABLE has no IF NOT EXISTS)
DO $$ BEGIN
    ALTER TABLE "public"."staff_roles"
        ADD CONSTRAINT "staff_roles_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey (guarded) — `granted_by` is an account too, but it is allowed to
-- outlive the account that granted it: deleting a staff member must not erase
-- the record of who appointed their replacement.
DO $$ BEGIN
    ALTER TABLE "public"."staff_roles"
        ADD CONSTRAINT "staff_roles_granted_by_fkey"
        FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed — everybody the old single switch already treats as staff becomes an
-- `owner`, which is the role that can hand out roles. Choosing `owner` rather
-- than `admin` is deliberate: it keeps the person who ran the platform in
-- control of who joins, and it makes the guard that refuses to remove the last
-- owner true from the first moment rather than only after somebody remembers to
-- create one.
INSERT INTO "public"."staff_roles" ("user_id", "role", "note")
SELECT "id", 'owner', 'Seeded from is_admin when staff roles were introduced.'
FROM "public"."users"
WHERE "is_admin" = true
ON CONFLICT ("user_id") DO NOTHING;
