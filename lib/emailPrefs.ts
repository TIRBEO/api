import crypto from 'crypto';
import { prisma } from './db/prisma';
import { getDashboardBaseUrl } from './app-urls';

// ─── Email classification ──────────────────────────────────────────
// Essential emails are NEVER suppressed — they are security-critical
// (OTPs, password resets, magic links, account recovery, account status).
// Security emails (login_alert, suspicious_login) are ALSO essential —
// users cannot unsubscribe from security notifications.

export const ESSENTIAL_TEMPLATES = new Set([
  // Auth / OTPs
  'signup_otp',
  'login_otp',
  'verify_email',
  'password_reset_otp',
  'password_reset_link',
  'magic_link',
  'password_changed',
  'welcome',
  // Security (compulsory — no unsubscribe)
  'login_alert',
  'suspicious_login',
  // Account
  'account_recovery',
  'account_suspended',
  'account_deleted',
  // Admin
  'export_ready',
  'admin_alert',
  'system_alert',
]);

// Map template → notification preference category.
// Only suppressible templates belong here — security/essential are excluded.
export const TEMPLATE_CATEGORY: Record<string, string> = {
  // Forms
  form_submission_confirmation: 'forms',
  form_notification: 'forms',
  form_response: 'forms',
  form_milestone: 'forms',
  form_spike: 'forms',
  form_revival: 'forms',
  form_test: 'forms',
  form_summary_daily: 'forms',
  form_summary_weekly: 'forms',
  form_flagged: 'forms',
  form_published: 'forms',
  form_closed: 'forms',
  form_deleted: 'forms',
  form_archived: 'forms',
  form_scheduled: 'forms',
  response_updated: 'forms',
  response_deleted: 'forms',
  response_limit_reached: 'forms',
  webhook_failed: 'forms',
  collaborator_added: 'forms',
  form_auto_reply: 'forms',
  form_submission_notification: 'forms',
  
  // Product
  product_update: 'product',
  weekly_summary: 'product',
  account_tip: 'product',
  notification_digest: 'product',
  
  // Support
  ticket_created: 'support',
  ticket_updated: 'support',
  ticket_closed: 'support',
  admin_reply: 'support',
};

// ─── Unsubscribe tokens ──────────────────────────────────────────
// Signed with HMAC so users can't forge tokens.
// Token format: base64url(userId:category:expiry:hmac)

const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || 'tirbeo-unsub-default';

function hmac(data: string): string {
  return crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(data).digest('base64url').slice(0, 32);
}

/** Generate a signed unsubscribe token for a user+category. Expires in 365 days. */
export function generateUnsubscribeToken(userId: string, category: string): string {
  const expiry = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const payload = `${userId}:${category}:${expiry}`;
  const sig = hmac(payload);
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

/** Verify and decode an unsubscribe token. Returns { userId, category } or null. */
export function verifyUnsubscribeToken(token: string): { userId: string; category: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 4) return null;
    const [userId, category, expiryStr, sig] = parts;
    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || Date.now() > expiry) return null;
    const payload = `${userId}:${category}:${expiry}`;
    const expected = hmac(payload);
    if (sig !== expected) return null;
    return { userId, category };
  } catch {
    return null;
  }
}

/** Build the full unsubscribe URL — redirects to dashboard notification settings. */
export function getUnsubscribeUrl(userId: string, category: string): string {
  const token = generateUnsubscribeToken(userId, category);
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app';
  return `${apiBase}/api/email/unsubscribe?token=${token}`;
}

/** Build the manage-preferences URL. */
export function getManagePreferencesUrl(): string {
  return `${getDashboardBaseUrl()}/account/notifications`;
}

// ─── Suppression check ────────────────────────────────────────────

/**
 * Check if an email should be suppressed for the given user.
 * Returns true if the email should be BLOCKED (not sent).
 *
 * Rules:
 * 1. Essential emails (OTP, password reset, security alerts, etc.) → NEVER suppressed
 * 2. If user's global email toggle is off → suppressed (except essential)
 * 3. If category-specific email toggle is off → suppressed
 * 4. If user has unsubscribed from category via token → suppressed
 */
export async function shouldSuppressEmail(to: string, templateName: string): Promise<boolean> {
  // Essential emails always go through (includes all security emails)
  if (ESSENTIAL_TEMPLATES.has(templateName)) return false;

  // Look up user by email
  const user = await prisma.user.findUnique({
    where: { email: to },
    select: { id: true, notificationPreferences: true, emailUnsubscribed: true },
  });
  if (!user) return false; // unknown user — let it through

  // Check global unsubscribe (e.g., from /email/unsubscribe with category='all')
  const globalUnsub = (user as any).emailUnsubscribed as Record<string, unknown> | null;
  if (globalUnsub?.all === true) return true;

  // Read notification preferences
  let prefs: any = (user as any).notificationPreferences;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    prefs = {}; // use defaults
  }

  // Global email toggle — if false, suppress ALL non-essential
  if (prefs.email === false) return true;

  // Category-specific check
  const category = TEMPLATE_CATEGORY[templateName];
  if (category) {
    const categoryEmailKey = `${category}Email`;
    if (prefs[categoryEmailKey] === false) return true;
    if (globalUnsub?.[category] === true) return true;
  }

  return false; // not suppressed — send it
}

/**
 * Process an unsubscribe action. Returns the updated prefs.
 * Security emails cannot be unsubscribed from — they are compulsory.
 */
export async function processUnsubscribe(userId: string, category: string): Promise<Record<string, unknown>> {
  // Security is compulsory — ignore attempts to unsubscribe
  if (category === 'security') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationPreferences: true },
    });
    return (user as any)?.notificationPreferences || {};
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPreferences: true, emailUnsubscribed: true },
  });

  let prefs: any = (user as any)?.notificationPreferences || {};
  let emailUnsub: any = (user as any)?.emailUnsubscribed || {};

  if (category === 'all') {
    prefs.email = false;
    emailUnsub.all = true;
  } else {
    const categoryEmailKey = `${category}Email`;
    prefs[categoryEmailKey] = false;
    emailUnsub[category] = true;
  }

  await prisma.$executeRaw`
    UPDATE "users"
    SET "notification_preferences" = ${JSON.stringify(prefs)}::jsonb,
        "email_unsubscribed" = ${JSON.stringify(emailUnsub)}::jsonb
    WHERE "id" = ${userId}`;

  return prefs;
}
