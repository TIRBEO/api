-- Fix slow /api/security/events (full table scan on audit_events.actorId).
-- Adds a descending actor+date index so 'where actorId order by createdAt desc'
-- no longer scans the whole audit_events table.
CREATE INDEX IF NOT EXISTS "idx_audit_events_actor_created" ON "audit_events" ("actor_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "idx_audit_events_actor" ON "audit_events" ("actor_id");
