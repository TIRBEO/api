-- Tirbeo API Database Schema
-- Mirrors prisma/schema.prisma — run against the API PostgreSQL database
-- NOT the Supabase database (that has tirbeo.* tables)

-- ─── Enums ──────────────────────────────────────────────

CREATE TYPE workspace_role AS ENUM ('ADMIN', 'MEMBER');

-- ─── Users ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL DEFAULT '',
  name            TEXT,
  photo_url       TEXT,
  secondary_email TEXT,
  phone_number    TEXT,
  occupation      TEXT,
  google_id       TEXT UNIQUE,
  github_id       TEXT UNIQUE,
  admin_role      TEXT,          -- 'super_admin' | 'admin' | 'manager' | 'editor' | NULL
  totp_secret     TEXT,
  is_2fa_enabled  BOOLEAN DEFAULT false,
  is_banned       BOOLEAN DEFAULT false,
  is_suspended    BOOLEAN DEFAULT false,
  last_active_at  TIMESTAMPTZ,
  preferences     JSONB DEFAULT '{}',
  bio             TEXT,
  website         TEXT,
  linkedin        TEXT,
  github          TEXT,
  twitter         TEXT,
  country         TEXT,
  timezone        TEXT,
  language        TEXT DEFAULT 'en',
  theme           TEXT DEFAULT 'system',
  date_format     TEXT DEFAULT 'MM/DD/YYYY',
  time_format     TEXT DEFAULT '12h',
  font_size       TEXT DEFAULT 'default',
  reduce_motion   BOOLEAN DEFAULT false,
  high_contrast    BOOLEAN DEFAULT false,
  email_verified  BOOLEAN DEFAULT false,
  phone_verified  BOOLEAN DEFAULT false,
  company_name    TEXT,
  company_role    TEXT,
  industry        TEXT,
  company_size    TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at);

-- ─── Workspaces ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);

-- ─── Memberships ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memberships (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         workspace_role DEFAULT 'MEMBER',
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_workspace ON memberships(workspace_id);

-- ─── Sessions ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  user_agent TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- ─── Routes (API Gateway) ───────────────────────────────

CREATE TABLE IF NOT EXISTS routes (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  path          TEXT NOT NULL,
  method        TEXT NOT NULL DEFAULT 'GET',
  target        TEXT,
  allowed_roles TEXT[] DEFAULT ARRAY['member'],
  internal      BOOLEAN DEFAULT false,
  enabled       BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(path, method)
);

-- ─── Logs ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS logs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ip         TEXT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  user_id    TEXT,
  status     INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_ip ON logs(ip);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(user_id);

-- ─── Blocklist ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS blocklist (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ip         TEXT,
  user_id    TEXT,
  reason     TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blocklist_ip ON blocklist(ip);
CREATE INDEX IF NOT EXISTS idx_blocklist_user ON blocklist(user_id);

-- ─── Site Config ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS site_configs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  app        TEXT UNIQUE NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_site_configs_app ON site_configs(app);

-- ─── App Roles ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_roles (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  color       TEXT DEFAULT '#4f7aff',
  icon        TEXT DEFAULT 'shield',
  is_system   BOOLEAN DEFAULT false,
  permissions JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_roles_name ON app_roles(name);

-- ─── User Roles (join) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS user_roles (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    TEXT NOT NULL REFERENCES app_roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

-- ─── OTPs ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS otps (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,     -- 'email' | 'phone'
  otp_hash   TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otps_user ON otps(user_id);
CREATE INDEX IF NOT EXISTS idx_otps_type ON otps(type);

-- ─── Signup OTPs ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signup_otps (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email      TEXT NOT NULL,
  otp_hash   TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signup_otps_email ON signup_otps(email);

-- ─── Email System ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_configs (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider   TEXT DEFAULT 'resend',
  api_key    TEXT,
  smtp_host  TEXT,
  smtp_port  INTEGER,
  smtp_user  TEXT,
  smtp_pass  TEXT,
  from_email TEXT DEFAULT 'noreply@tirbeo.app',
  from_name  TEXT DEFAULT 'Tirbeo',
  enabled    BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_templates (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  subject     TEXT NOT NULL,
  html_body   TEXT NOT NULL,
  variables   JSONB DEFAULT '[]',
  from_email  TEXT,
  from_name   TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_name ON email_templates(name);

-- ─── Notifications ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,    -- 'mention' | 'comment' | 'report' | 'system' | 'digest'
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  icon        TEXT,
  read        BOOLEAN DEFAULT false,
  email_sent  BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);

-- ─── Notification Preferences ───────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_digest  TEXT DEFAULT 'daily',
  digest_time   TEXT DEFAULT '08:00',
  mention       BOOLEAN DEFAULT true,
  comment       BOOLEAN DEFAULT true,
  report        BOOLEAN DEFAULT true,
  system        BOOLEAN DEFAULT true,
  marketing     BOOLEAN DEFAULT false,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ─── Content Reports ────────────────────────────────────

CREATE TABLE IF NOT EXISTS content_reports (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  reporter_id    TEXT NOT NULL REFERENCES users(id),
  target_type    TEXT NOT NULL,   -- 'user' | 'post' | 'comment' | 'media'
  target_id      TEXT NOT NULL,
  reason         TEXT NOT NULL,   -- 'spam' | 'abuse' | 'harassment' | 'illegal' | 'other'
  description    TEXT,
  status         TEXT DEFAULT 'pending',
  reviewed_by_id TEXT REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  action         TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status);
CREATE INDEX IF NOT EXISTS idx_content_reports_target ON content_reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_created ON content_reports(created_at);

-- ─── Media Library ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  mime_type    TEXT NOT NULL,
  url          TEXT NOT NULL,
  thumbnail    TEXT,
  alt_text     TEXT,
  width        INTEGER,
  height       INTEGER,
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  folder       TEXT DEFAULT 'general',
  tags         JSONB DEFAULT '[]',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_media_folder ON media(folder);
CREATE INDEX IF NOT EXISTS idx_media_mime ON media(mime_type);
CREATE INDEX IF NOT EXISTS idx_media_uploaded ON media(uploaded_by);

-- ─── Audit Events ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB DEFAULT '{}',
  severity    TEXT DEFAULT 'info',
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_target ON audit_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);

-- ─── Recovery Codes (2FA) ───────────────────────────────

CREATE TABLE IF NOT EXISTS recovery_codes (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  used       BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_code ON recovery_codes(code);

-- ─── Subscribers ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscribers (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email      TEXT UNIQUE NOT NULL,
  name       TEXT,
  source     TEXT DEFAULT 'landing',
  status     TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers(status);

-- ─── Integrations ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,   -- 'google' | 'github' | 'slack' | 'discord' | etc
  connected     BOOLEAN DEFAULT false,
  access_token  TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integrations_user ON integrations(user_id);

-- ─── Theme Configuration ────────────────────────────────

CREATE TABLE IF NOT EXISTS theme_configs (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name        TEXT UNIQUE NOT NULL,
  is_active   BOOLEAN DEFAULT false,

  bg_primary      TEXT DEFAULT '#08150F',
  bg_secondary    TEXT DEFAULT '#101c13',
  bg_card         TEXT DEFAULT '#12271D',
  bg_elevated     TEXT DEFAULT '#1a3326',

  text_primary    TEXT DEFAULT '#F2EEE8',
  text_secondary  TEXT DEFAULT '#B7C6BE',
  text_muted      TEXT DEFAULT '#6b8a7a',

  accent_primary   TEXT DEFAULT '#569578',
  accent_secondary TEXT DEFAULT '#275d46',
  accent_hover     TEXT DEFAULT '#6aab8d',

  success    TEXT DEFAULT '#59C173',
  warning    TEXT DEFAULT '#F4B942',
  error      TEXT DEFAULT '#E45D5D',

  border_color TEXT DEFAULT 'rgba(255,255,255,0.08)',
  border_hover TEXT DEFAULT 'rgba(255,255,255,0.14)',

  font_primary  TEXT DEFAULT 'Inter',
  font_heading  TEXT DEFAULT 'Plus Jakarta Sans',
  border_radius TEXT DEFAULT '16px',

  logo_url       TEXT,
  brand_name     TEXT DEFAULT 'Tirbeo',
  brand_tagline  TEXT DEFAULT 'Premium Social Platform',

  light_bg_primary     TEXT,
  light_bg_secondary   TEXT,
  light_text_primary   TEXT,
  light_accent_primary TEXT,

  email_header_bg    TEXT DEFAULT 'linear-gradient(135deg,#022B22,#275D46,#569578)',
  email_button_color TEXT DEFAULT '#569578',
  email_text_color   TEXT DEFAULT '#B7C6BE',

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_theme_configs_active ON theme_configs(is_active);
