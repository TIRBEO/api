-- Add Cooldown table for DB-based rate limiting (replaces in-memory Map)
CREATE TABLE IF NOT EXISTS cooldowns (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    key TEXT UNIQUE NOT NULL,
    last_sent TIMESTAMPTZ NOT NULL DEFAULT now(),
    count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cooldowns_expires ON cooldowns(expires_at);

-- Add MagicLink table for tracking active (unsent) magic links
CREATE TABLE IF NOT EXISTS magic_links (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    jti TEXT UNIQUE NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_user ON magic_links(user_id);
