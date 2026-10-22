/**
 * Which mail a reader cannot opt out of.
 *
 * This is a plain set, but it used to live in emailPrefs.ts — the module that
 * reads a user's preferences out of Postgres. Anything that only needed to ask
 * "does this one get an unsubscribe link?" therefore also instantiated the
 * Prisma client, which is fine in a request and fatal in an offline script:
 * the preview renderer sat in the pool warm-up retry loop and never wrote a
 * file. It lives here so the answer costs nothing to look up.
 */
export const ESSENTIAL_TEMPLATES = new Set([
  // Auth / OTPs
  'signup_otp',
  'login_otp',
  'reauth_otp',
  'verify_email',
  'password_reset_otp',
  'password_reset_otp_recovery',
  'password_reset_link',
  'magic_link',
  'password_changed',
  'welcome',
  // Security (compulsory — no unsubscribe)
  'login_alert',
  'suspicious_login',
  'two_factor_disabled',
  'two_factor_enabled',
  // Account
  'account_recovery',
  'account_suspended',
  'account_deleted',
  'account_deactivated',
  'delete_account_otp',
  // Admin
  'export_ready',
  'admin_alert',
  // Support — a conversation the reader started. Suppressing it on a switch
  // would answer their question with silence. `support_request_admin` is the
  // staff side of that same conversation, and an admin who muted product mail
  // still has to see what they are being asked to answer.
  'support_request_received',
  'support_reply',
  'support_request_admin',
]);
