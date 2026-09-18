-- Seed verification_limits table with default rate limits
-- These limits match the frontend DEFAULT_SEND_LIMITS and backend enforcement

INSERT INTO verification_limits (method, max, "window_ms") VALUES
  ('login-otp', 5, 900000),
  ('magic-link', 3, 900000),
  ('otp', 5, 900000),
  ('recovery', 5, 900000),
  ('signup-otp', 5, 900000),
  ('global-email', 5, 900000),
  ('global-ip', 20, 900000)
ON CONFLICT (method) DO UPDATE SET
  max = EXCLUDED.max,
  "window_ms" = EXCLUDED."window_ms",
  updated_at = now();
