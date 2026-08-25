-- Performance indexes for common query patterns

-- Security events: user activity page queries by userId + createdAt
CREATE INDEX IF NOT EXISTS idx_security_events_user_created
  ON security_events (user_id, created_at DESC);

-- Security events: admin security score queries by severity + createdAt
CREATE INDEX IF NOT EXISTS idx_security_events_severity_created
  ON security_events (severity, created_at DESC);

-- Tickets: list queries by status + createdAt and customerId + createdAt
CREATE INDEX IF NOT EXISTS idx_tickets_status_created
  ON tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_customer_created
  ON tickets (customer_id, created_at DESC);

-- Notifications: user inbox queries by userId + isRead and userId + createdAt
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications (user_id, is_read);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- Login history: user login history queries by userId + createdAt
CREATE INDEX IF NOT EXISTS idx_login_history_user_created
  ON login_history (user_id, created_at DESC);

-- Form submissions: optimize the existing composite index for DESC ordering
DROP INDEX IF EXISTS form_submissions_form_id_created_at_idx;
CREATE INDEX idx_form_submissions_form_created_desc
  ON form_submissions (form_id, created_at DESC);
