-- Tirbeo Dashboard — Common SQL Queries
-- Run against the API PostgreSQL database

-- ─── Profile Queries ────────────────────────────────────

-- Get full user profile
SELECT
  u.id, u.email, u.name, u.photo_url, u.secondary_email,
  u.phone_number, u.occupation, u.bio, u.country, u.language,
  u.theme, u.admin_role, u.is_2fa_enabled, u.email_verified,
  u.phone_verified, u.company_name, u.company_role, u.industry,
  u.company_size, u.created_at, u.last_active_at,
  u.website, u.linkedin, u.github, u.twitter,
  u.date_format, u.time_format, u.font_size, u.reduce_motion, u.high_contrast
FROM users u
WHERE u.id = $1;

-- Update profile fields
UPDATE users SET
  name = COALESCE($2, name),
  photo_url = COALESCE($3, photo_url),
  bio = COALESCE($4, bio),
  occupation = COALESCE($5, occupation),
  country = COALESCE($6, country),
  language = COALESCE($7, language),
  website = COALESCE($8, website),
  linkedin = COALESCE($9, linkedin),
  github = COALESCE($10, github),
  twitter = COALESCE($11, twitter),
  secondary_email = COALESCE($12, secondary_email),
  company_name = COALESCE($13, company_name),
  company_role = COALESCE($14, company_role),
  industry = COALESCE($15, industry),
  company_size = COALESCE($16, company_size),
  updated_at = now()
WHERE id = $1;

-- ─── Security Queries ───────────────────────────────────

-- Get active sessions for user
SELECT id, created_at, user_agent, ip_address, expires_at
FROM sessions
WHERE user_id = $1 AND expires_at > now()
ORDER BY created_at DESC;

-- Revoke a specific session
DELETE FROM sessions WHERE id = $1 AND user_id = $2;

-- Revoke all sessions except current
DELETE FROM sessions WHERE user_id = $1 AND id != $2;

-- Get recovery codes for user
SELECT id, code, used, created_at, used_at
FROM recovery_codes
WHERE user_id = $1
ORDER BY created_at DESC;

-- Mark recovery code as used
UPDATE recovery_codes SET used = true, used_at = now()
WHERE id = $1 AND user_id = $2 AND used = false;

-- Enable 2FA
UPDATE users SET
  is_2fa_enabled = true,
  totp_secret = $2,
  updated_at = now()
WHERE id = $1;

-- Disable 2FA
UPDATE users SET
  is_2fa_enabled = false,
  totp_secret = NULL,
  updated_at = now()
WHERE id = $1;

-- ─── Activity Queries ───────────────────────────────────

-- Get recent activity for user
SELECT id, action, target_type, target_id, metadata, created_at
FROM audit_events
WHERE actor_id = $1
ORDER BY created_at DESC
LIMIT $2;

-- Log an activity event
INSERT INTO audit_events (actor_id, action, target_type, target_id, metadata, severity)
VALUES ($1, $2, $3, $4, $5, $6);

-- Get last login info
SELECT ip_address, user_agent, created_at
FROM sessions
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT 1;

-- Update last active timestamp
UPDATE users SET last_active_at = now() WHERE id = $1;

-- Online users (active in last 5 minutes)
SELECT id, name, photo_url, last_active_at
FROM users
WHERE last_active_at > now() - INTERVAL '5 minutes'
ORDER BY last_active_at DESC;

-- ─── Notification Queries ───────────────────────────────

-- Get user notifications
SELECT id, type, title, body, link, icon, read, created_at
FROM notifications
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT $2;

-- Unread count
SELECT COUNT(*) as count
FROM notifications
WHERE user_id = $1 AND read = false;

-- Mark notification as read
UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2;

-- Mark all as read
UPDATE notifications SET read = true WHERE user_id = $1 AND read = false;

-- Delete old notifications (keep last 100)
DELETE FROM notifications
WHERE user_id = $1
AND id NOT IN (
  SELECT id FROM notifications
  WHERE user_id = $1
  ORDER BY created_at DESC
  LIMIT 100
);

-- Get notification preferences
SELECT * FROM notification_preferences WHERE user_id = $1;

-- Upsert notification preferences
INSERT INTO notification_preferences (user_id, email_digest, digest_time, mention, comment, report, system, marketing)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (user_id) DO UPDATE SET
  email_digest = EXCLUDED.email_digest,
  digest_time = EXCLUDED.digest_time,
  mention = EXCLUDED.mention,
  comment = EXCLUDED.comment,
  report = EXCLUDED.report,
  system = EXCLUDED.system,
  marketing = EXCLUDED.marketing,
  updated_at = now();

-- ─── Preference Queries ─────────────────────────────────

-- Update user preferences (single column approach)
UPDATE users SET
  theme = COALESCE($2, theme),
  language = COALESCE($3, language),
  timezone = COALESCE($4, timezone),
  date_format = COALESCE($5, date_format),
  time_format = COALESCE($6, time_format),
  font_size = COALESCE($7, font_size),
  reduce_motion = COALESCE($8, reduce_motion),
  high_contrast = COALESCE($9, high_contrast),
  updated_at = now()
WHERE id = $1;

-- Update user preferences (JSONB approach)
UPDATE users SET
  preferences = preferences || $2::jsonb,
  updated_at = now()
WHERE id = $1;

-- ─── Integration Queries ────────────────────────────────

-- Get user integrations
SELECT id, provider, connected, metadata, created_at, updated_at
FROM integrations
WHERE user_id = $1
ORDER BY provider;

-- Connect integration
INSERT INTO integrations (user_id, provider, connected, access_token, metadata)
VALUES ($1, $2, true, $3, $4)
ON CONFLICT (user_id, provider) DO UPDATE SET
  connected = true,
  access_token = EXCLUDED.access_token,
  metadata = EXCLUDED.metadata,
  updated_at = now();

-- Disconnect integration
UPDATE integrations
SET connected = false, access_token = NULL, metadata = '{}', updated_at = now()
WHERE user_id = $1 AND provider = $2;

-- Delete integration
DELETE FROM integrations WHERE user_id = $1 AND provider = $2;

-- ─── Workspace Queries ──────────────────────────────────

-- Get user's workspaces
SELECT w.id, w.name, w.slug, m.role, w.created_at
FROM workspaces w
JOIN memberships m ON m.workspace_id = w.id
WHERE m.user_id = $1
ORDER BY w.created_at DESC;

-- Create workspace + owner membership
BEGIN;
  INSERT INTO workspaces (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id;
  INSERT INTO memberships (user_id, workspace_id, role) VALUES ($3, (SELECT id FROM workspaces WHERE slug = $2), 'ADMIN');
COMMIT;

-- Add member to workspace
INSERT INTO memberships (user_id, workspace_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = EXCLUDED.role;

-- Remove member from workspace
DELETE FROM memberships WHERE user_id = $1 AND workspace_id = $2;

-- Delete workspace (cascades to memberships)
DELETE FROM workspaces WHERE id = $1 AND owner_id = $2;

-- ─── Site Config Queries ────────────────────────────────

-- Get config for an app
SELECT config FROM site_configs WHERE app = $1;

-- Upsert config
INSERT INTO site_configs (app, config, updated_by)
VALUES ($1, $2, $3)
ON CONFLICT (app) DO UPDATE SET
  config = EXCLUDED.config,
  updated_by = EXCLUDED.updated_by,
  updated_at = now();

-- ─── Stats Queries ──────────────────────────────────────

-- Total users
SELECT COUNT(*) FROM users;

-- Users by role
SELECT admin_role, COUNT(*) as count
FROM users
WHERE admin_role IS NOT NULL
GROUP BY admin_role;

-- New users this month
SELECT COUNT(*) FROM users
WHERE created_at >= date_trunc('month', now());

-- Active users (last 7 days)
SELECT COUNT(DISTINCT id) FROM users
WHERE last_active_at > now() - INTERVAL '7 days';

-- Total sessions
SELECT COUNT(*) FROM sessions WHERE expires_at > now();

-- Total workspaces
SELECT COUNT(*) FROM workspaces;

-- Total notifications sent
SELECT COUNT(*) FROM notifications;

-- Audit events by severity
SELECT severity, COUNT(*) as count
FROM audit_events
WHERE created_at > now() - INTERVAL '30 days'
GROUP BY severity;

-- ─── User Management (Admin) ────────────────────────────

-- Ban user
UPDATE users SET is_banned = true, updated_at = now() WHERE id = $1;

-- Suspend user
UPDATE users SET is_suspended = true, updated_at = now() WHERE id = $1;

-- Unban user
UPDATE users SET is_banned = false, is_suspended = false, updated_at = now() WHERE id = $1;

-- Delete user (cascades to sessions, memberships, notifications, etc.)
DELETE FROM users WHERE id = $1;

-- Search users
SELECT id, email, name, photo_url, admin_role, is_banned, is_suspended, created_at
FROM users
WHERE email ILIKE '%' || $1 || '%'
   OR name ILIKE '%' || $1 || '%'
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- ─── Content Moderation ─────────────────────────────────

-- Get pending reports
SELECT cr.*, u.email as reporter_email
FROM content_reports cr
JOIN users u ON u.id = cr.reporter_id
WHERE cr.status = 'pending'
ORDER BY cr.created_at DESC;

-- Update report status
UPDATE content_reports SET
  status = $2,
  reviewed_by_id = $3,
  reviewed_at = now(),
  action = $4,
  notes = $5,
  updated_at = now()
WHERE id = $1;
