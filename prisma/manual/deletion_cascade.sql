-- Permanent deletion: four foreign keys that refused to let an account go.
--
-- `jobs/jobs-permanent-deletion.ts` removes an account whose 30-day window has
-- run out. It used to stamp the request executed BEFORE deleting, then ask the
-- database to cascade the rest — and four keys said no:
--
--   blocklist.blocked_by        NO ACTION  a profile the person blocked
--   tickets.customer_id         RESTRICT   a thread they opened with support
--   ticket_messages.author_id   RESTRICT   a reply they wrote in one
--   media.uploaded_by           NO ACTION  a file they uploaded
--
-- Each one made `DELETE FROM users` throw P2003. The throw was caught per
-- account and logged, so the row stayed marked handled: the account remained
-- `deletion_pending`, every record of it stayed on file, and the lock screen
-- kept quoting a date the deletion did not happen on.
--
-- All four become ON DELETE CASCADE. The sweep now also clears them
-- explicitly, so this file is the guarantee rather than the only defence.
--
-- This project has no prisma/migrations folder (db-push workflow); the matching
-- `onDelete: Cascade` is set in schema.prisma for `Blocklist`, and the three
-- others have no model.
--
-- Apply with:
--   npx prisma db execute --file prisma/manual/deletion_cascade.sql
--
-- Safe to re-run. Each block resolves the table through to_regclass because
-- `prisma/SCHEMAS.md` describes a named-schema layout (`support`, `media`)
-- while `schema.prisma` and the raw SQL in the apps use `public` — whichever
-- this database actually holds is the one that gets altered, and a table that
-- is not here at all is left alone rather than guessed at.

-- blocklist.blocked_by → users.id
DO $$
DECLARE
  tbl   regclass;
  users regclass;
BEGIN
  tbl   := coalesce(to_regclass('public.blocklist'),    to_regclass('security.blocklist'));
  users := coalesce(to_regclass('public.users'),        to_regclass('user.users'));
  IF tbl IS NULL OR users IS NULL THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS "blocklist_blocked_by_fkey"', tbl);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT "blocklist_blocked_by_fkey" '
    || 'FOREIGN KEY (blocked_by) REFERENCES %s (id) ON DELETE CASCADE', tbl, users);
END $$;

-- tickets.customer_id → users.id
DO $$
DECLARE
  tbl   regclass;
  users regclass;
BEGIN
  tbl   := coalesce(to_regclass('public.tickets'),      to_regclass('support.tickets'));
  users := coalesce(to_regclass('public.users'),        to_regclass('user.users'));
  IF tbl IS NULL OR users IS NULL THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS "tickets_customer_id_fkey"', tbl);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT "tickets_customer_id_fkey" '
    || 'FOREIGN KEY (customer_id) REFERENCES %s (id) ON DELETE CASCADE', tbl, users);
END $$;

-- ticket_messages.author_id → users.id
-- (ticket_messages.ticket_id already cascades from tickets, so a thread the
--  account opened goes with it, staff replies included.)
DO $$
DECLARE
  tbl   regclass;
  users regclass;
BEGIN
  tbl   := coalesce(to_regclass('public.ticket_messages'), to_regclass('support.ticket_messages'));
  users := coalesce(to_regclass('public.users'),           to_regclass('user.users'));
  IF tbl IS NULL OR users IS NULL THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS "ticket_messages_author_id_fkey"', tbl);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT "ticket_messages_author_id_fkey" '
    || 'FOREIGN KEY (author_id) REFERENCES %s (id) ON DELETE CASCADE', tbl, users);
END $$;

-- media.uploaded_by → users.id
--
-- The row goes with the account. What the row pointed at does NOT: the bytes
-- live in object storage, and no code here deletes an object when its record
-- dies. Erasing an account therefore leaves its uploads in a bucket, named by
-- a key nobody can any longer say belongs to whom. Closing that is a storage
-- sweep, not a constraint, and it is not done here.
DO $$
DECLARE
  tbl   regclass;
  users regclass;
BEGIN
  tbl   := coalesce(to_regclass('public.media'), to_regclass('media.media'));
  users := coalesce(to_regclass('public.users'), to_regclass('user.users'));
  IF tbl IS NULL OR users IS NULL THEN RETURN; END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS "media_uploaded_by_fkey"', tbl);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT "media_uploaded_by_fkey" '
    || 'FOREIGN KEY (uploaded_by) REFERENCES %s (id) ON DELETE CASCADE', tbl, users);
END $$;
