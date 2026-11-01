-- PRD §11.3 recommendation store (zero-budget fallback: same Postgres, own tables).
CREATE TABLE IF NOT EXISTS recommendation_events (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content_id TEXT,
  content_type TEXT,
  source_feed TEXT,
  minute_bucket BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reco_dedupe
  ON recommendation_events (user_id, type, COALESCE(content_id, ''), minute_bucket);
CREATE INDEX IF NOT EXISTS reco_user_time ON recommendation_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_interest_scores (
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic)
);
