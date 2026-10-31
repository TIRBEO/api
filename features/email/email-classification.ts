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
  'account_reinstated',
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

/**
 * Which provider sends which mail.
 *
 * The split follows what each service's reputation is for: Brevo carries the
 * marketing/digest family (product news, digests, recaps, tips, reactivation,
 * maintenance) where an unsubscribe link and a bulk-sending domain belong —
 * updates.tirbeo.com is authenticated and branded there. Resend keeps every
 * essential/auth delivery (OTPs, resets, magic links, security alerts, support
 * replies), because a one-time code must never share sending history with a
 * promotional blast. Anything unknown stays on Resend: it is the path that has
 * always worked, and a misclassified digest is a annoyance while a misclassified
 * OTP is a failed login.
 */
export const BREVO_TEMPLATES = new Set([
  'product_update',
  'notification_digest',
  'weekly_summary',
  'security_tip',
  'reactivation',
  'maintenance_notification',
  'maintenance_complete',
]);

/** True when this template should go out through Brevo. */
export function usesBrevo(templateName?: string): boolean {
  if (!templateName || templateName.startsWith('brain:')) return false;
  if ((ESSENTIAL_TEMPLATES as Set<string>).has(templateName)) return false;
  return BREVO_TEMPLATES.has(templateName);
}
