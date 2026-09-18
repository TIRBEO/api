-- Index typed event IDs stored in incident_events.metadata ("SY" family:
-- 5359-xxxx-xxxx). Supports the admin event-ID lookup:
--   WHERE metadata->>'eventId' = '5359-bc55-d1f8'
-- GIN + jsonb_path_ops keeps the index small; only equality on the scalar
-- value is needed.

CREATE INDEX IF NOT EXISTS "incident_events_metadata_eventId_idx"
  ON "incident_events" USING gin (("metadata" -> 'eventId') jsonb_path_ops);
