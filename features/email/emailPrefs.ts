import crypto from 'crypto';
import { prisma } from '@/infrastructure/db/prisma';
import { getDashboardBaseUrl } from '@/config/app-urls';

/** Check if current time is within user's quiet hours window. Shared with notifications.ts. */
export function isInQuietHours(prefs: { quietHoursEnabled?: boolean | null; quietHoursStart?: string | null; quietHoursEnd?: string | null } | null | undefined): boolean {
  try {
    if (!prefs?.quietHoursEnabled) return false;
    const now = new Date();
    const startStr = prefs.quietHoursStart || '22:00';
    const endStr = prefs.quietHoursEnd || '08:00';
    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    if (startMinutes > endMinutes) {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } catch { return false; }
}

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
  'delete_account_otp',
  // Admin
  'export_ready',
  'admin_alert',
  'system_alert',
  'admin_crash_report',
]);

// ─── Email Brain mandatory detection ────────────────────────────
// Brain templates use 'brain:<eventKey>' names. Mandatory security events
// (auth.*) are never suppressed — matching the registry's mandatory flag.
// Non-security brain events (activity, product) were already preference-checked
// by the Email Brain decision engine; only global toggle + quiet hours apply.
const BRAIN_MANDATORY_PREFIXES = ['auth.'];

/** Check if an Email Brain event key is mandatory (security/account-critical). */
export function isBrainMandatory(eventKey: string): boolean {
  return BRAIN_MANDATORY_PREFIXES.some(p => eventKey.startsWith(p));
}

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
  notification_digest: 'product',
  reactivation: 'product',
  maintenance_notification: 'product',
  maintenance_complete: 'product',

  // Tips — maps to tips/tipsEmail prefs (with fallback to product for backwards compat)
  account_tip: 'tips',
  
  // Support — all ticket lifecycle emails respect supportEmail + email prefs
  ticket_created: 'support',
  ticket_updated: 'support',
  ticket_closed: 'support',
  ticket_reopened: 'support',
  ticket_replied: 'support',
  ticket_assigned: 'support',
  admin_reply: 'support',
};

// ─── Unsubscribe tokens ──────────────────────────────────────────
// Signed with HMAC so users can't forge tokens.
// Token format: base64url(userId:category:expiry:hmac)

const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET || 'dev-fallback-unsubscribe-secret-do-not-use-in-production';
if (!process.env.UNSUBSCRIBE_SECRET && !process.env.SESSION_SECRET && !process.env.JWT_SECRET) {
  console.warn('[emailPrefs] UNSUBSCRIBE_SECRET/SESSION_SECRET/JWT_SECRET not set — using dev fallback. Set UNSUBSCRIBE_SECRET in production.');
}

function getUnsubscribeSecret(): string {
  return UNSUBSCRIBE_SECRET;
}

function hmac(data: string): string {
  return crypto.createHmac('sha256', getUnsubscribeSecret()).update(data).digest('base64url').slice(0, 32);
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
export async function shouldSuppressEmail(to: string, templateName: string, categoryOverride?: string): Promise<boolean> {
  // Essential emails always go through (includes all security emails)
  if (ESSENTIAL_TEMPLATES.has(templateName)) return false;

  // Email Brain templates: 'brain:<eventKey>' — mandatory security events never suppressed.
  const isBrain = templateName.startsWith('brain:');
  const brainEventKey = isBrain ? templateName.slice(6) : null;
  if (isBrain && brainEventKey && isBrainMandatory(brainEventKey)) return false;

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

  // Per-category check — skip for Email Brain templates (the decision engine
  // already evaluated preferences before enqueuing the job). Only global toggle
  // + global unsubscribe + quiet hours still apply.
  if (!isBrain) {
    // Category-specific check. Callers can override the category when the
    // template name doesn't reflect the notification's real category (e.g.
    // per-notification emails reuse the notification_digest template but must
    // respect the forms/support/tips toggles, not product). 'digest' marks the
    // periodic digest/weekly-summary emails: the sweep already checked
    // digestEnabled/weeklySummary opt-ins, so only the global email toggle and
    // global unsubscribe (both handled above) still suppress them.
    const category = categoryOverride || TEMPLATE_CATEGORY[templateName];
    if (category && category !== 'digest') {
      if (category === 'tips') {
        // Tips fallback: tips/tipsEmail → product/productEmail for backwards compat
        const tipsOn = prefs.tips !== undefined ? prefs.tips !== false : (prefs.product !== false);
        const tipsEmailOn = prefs.tipsEmail !== undefined ? prefs.tipsEmail !== false : (prefs.productEmail !== false);
        if (!tipsOn || !tipsEmailOn) return true;
      } else {
        const categoryEmailKey = `${category}Email`;
        if (prefs[categoryEmailKey] === false) return true;
      }
      if (globalUnsub?.[category] === true) return true;
    }
  }

  // Quiet hours — suppress non-essential emails during the user's quiet window
  // (security/essential/mandatory brain emails already returned above)
  if (isInQuietHours(prefs)) return true;

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

  const prefs: any = (user as any)?.notificationPreferences || {};
  const emailUnsub: any = (user as any)?.emailUnsubscribed || {};

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
