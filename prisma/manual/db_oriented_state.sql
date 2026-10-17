-- DB-oriented state: durable fallbacks for state that used to live only in
-- Redis / process memory (rate-limit windows, spent refresh tokens).
--
-- This project has no prisma/migrations folder (db-push workflow), so the new
-- models in schema.prisma (RateLimitWindow, RefreshTokenSpent) must be created
-- in the database with this file before the Postgres fallback path can be used.
-- Until it is applied, every guarded access throws, is caught, and the code
-- drops to its existing Redis / in-memory behavior — nothing breaks, it just
-- isn't durable yet.
--
-- Apply with EITHER:
--   psql "$DATABASE_URL" -f prisma/manual/db_oriented_state.sql
-- OR (equivalent, regenerates types too):
--   npx prisma db push
--
-- Safe to re-run: CREATE TABLE/INDEX ... IF NOT EXISTS.

-- rate_limit_windows: fixed-window counters. bucket = floor(epochMs / windowMs);
-- reset_at is the wall-clock end of the window, kept so a sweeper can prune old
-- buckets. The unique (key, bucket) is what the atomic upsert-increment targets.
CREATE TABLE IF NOT EXISTS "rate_limit_windows" (
  id       TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  key      TEXT NOT NULL,
  bucket   BIGINT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_rate_limit_windows_key_bucket" ON "rate_limit_windows"("key", "bucket");
CREATE INDEX IF NOT EXISTS "idx_rate_limit_windows_reset" ON "rate_limit_windows"("reset_at");

-- refresh_token_spent: rotated refresh tokens. The unique token_hash is the
-- reuse detector itself — a second spend of an already-rotated token violates
-- it, which is the theft signature. session_id names the family to kill.
CREATE TABLE IF NOT EXISTS "refresh_token_spent" (
  id         TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
  token_hash TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  spent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_refresh_token_spent_at" ON "refresh_token_spent"("spent_at");
