import crypto from 'crypto';
import { prisma } from '@/infrastructure/db/prisma';
import { getDashboardBaseUrl } from '@/config/app-urls';
import { getGlobalEmailSwitches, SWITCH_BY_CATEGORY } from '@/features/email/emailSwitches';

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
  'reauth_otp',
  'verify_email',
  'password_reset_otp',
  'password_reset_link',
  'magic_link',
  'password_changed',
  'welcome',
  // Security (compulsory — no unsubscribe)
  'login_alert',
  'suspicious_login',
  'two_factor_disabled',
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
  form_milestone: 'forms',
  form_spike: 'forms',
  form_revival: 'forms',
  form_test: 'forms',
  form_summary_daily: 'forms',
  form_summary_weekly: 'forms',
  form_scheduled: 'forms',
  response_limit_reached: 'forms',
  webhook_failed: 'forms',
  collaborator_added: 'forms',
  // Product
  product_update: 'product',
  maintenance_notification: 'product',
  maintenance_complete: 'product',
  // Offers and promotions — the "we miss you" mail is a campaign, not a
  // product announcement, and the settings screen says so with its own row.
  // Classifying it as 'product' meant the Offers switch on that page governed
  // nothing while a switch nobody pressed governed this mail.
  reactivation: 'offers',
  // The account recap is its own category, not a product announcement: the
  // person opted into it by name, so no platform-wide switch governs it.
  weekly_summary: 'digest',
  // The digest template, used AS a digest (per-notification sends override the
  // category to forms/support/tips — see TEMPLATE_CATEGORY users in
  // createNotification). Left unmapped it answered to the product switch only,
  // so a digest went out even to an account whose digestEnabled said no: the
  // one flag the settings ever shipped for digests governed nothing. As with
  // the recap, a digest is only due when the account says so explicitly.
  notification_digest: 'digest',

  // Tips — the tipsEmail toggle alone is the opt-in
  security_tip: 'tips',
  
  // Support — all ticket lifecycle emails respect supportEmail + email prefs
  ticket_assigned: 'support',
  admin_reply: 'support',
};

// ─── Unsubscribe tokens ──────────────────────────────────────────
// Signed with HMAC so users can't forge tokens.
// Token format: base64url(userId:category:expiry:hmac)

// SEC: never fall back to a known literal — that would make unsubscribe
// tokens forgeable. In production, fail fast if no secret is configured.
// In dev, use a random per-boot secret (unknown to attackers, dev-only).
function resolveUnsubscribeSecret(): string {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[emailPrefs] UNSUBSCRIBE_SECRET (or SESSION_SECRET/JWT_SECRET) must be set in production');
  }
  console.warn('[emailPrefs] No unsubscribe secret configured — using random per-boot secret (dev only).');
  return Buffer.from(crypto.randomBytes(32)).toString('base64url');
}

const UNSUBSCRIBE_SECRET = resolveUnsubscribeSecret();

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

/**
 * Build a signed, single-use unsubscribe URL for an email address.
 * Returns null when the address isn't a known account (no prefs to mutate).
 * The HMAC token means knowing someone's email is NOT enough to unsubscribe
 * them — the token must come from their own inbox.
 */
export async function buildUnsubscribeUrl(to: string): Promise<string | null> {
  try {
    // Emails live in UserEmail rows in the consolidated schema.
    const emailRow = await prisma.userEmail.findFirst({
      where: { address: to.toLowerCase() },
      select: { userId: true },
    });
    if (!emailRow) return null;
    const token = generateUnsubscribeToken(emailRow.userId, 'all');
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.com';
    return `${apiBase}/api/emails/unsubscribe?token=${encodeURIComponent(token)}&email=${encodeURIComponent(to.toLowerCase())}`;
  } catch {
    return null;
  }
}

// ─── Suppression check ────────────────────────────────────────────

// Suppression is decided from the same merged answer every other sender uses.
// Reading only `user_preferences.notif` was half the split-brain: the settings
// screens write the choice on the user row, so a person who turned mail off
// there was still mailed from here.
// `userId` (when the caller knows it) is trusted directly: reverse-looking the
// address up in UserEmail fails open for identity addresses (name@tirbeo.com)
// that have no row, and an unresolvable address used to mean "let it through"
// even though the account had switched the category off.
async function getPrefsByAddress(address: string, userId?: string): Promise<{ userId: string; prefs: any } | null> {
  let uid = userId || null;
  if (!uid) {
    const emailRow = await prisma.userEmail.findFirst({
      where: { address: address.toLowerCase() },
      select: { userId: true },
    });
    uid = emailRow?.userId || null;
  }
  if (!uid) return null;
  const { loadNotificationPrefs } = await import('@/features/notifications/notifications');
  const prefs = await loadNotificationPrefs(uid);
  return { userId: uid, prefs };
}

function getUnsubMap(prefs: any): Record<string, unknown> {
  const u = prefs?.unsubscribed;
  return u && typeof u === 'object' && !Array.isArray(u) ? u as Record<string, unknown> : {};
}

/**
 * Whether this account's "pause everything" is currently in effect.
 *
 * A pause lapses on its own: `emailPausedUntil` is the epoch ms it lapses at, or
 * null when the person chose "until I turn it back on". A stored pause with a
 * date already behind us is over, and saying so here means nobody has to run a
 * job to un-pause anyone — the flag stays set, and the next send reads it as off.
 */
export function isEmailPaused(prefs: any): boolean {
  if (prefs?.emailPaused !== true) return false;
  const until = prefs.emailPausedUntil;
  if (typeof until !== 'number') return true;
  return until > Date.now();
}

/**
 * Check if an email should be suppressed for the given user.
 * Returns true if the email should be BLOCKED (not sent).
 *
 * This is THE enforcement point: every templated send flows through here (via
 * sendTemplateEmail/sendEmail), so a template can never be the one that
 * forgot to ask. Callers that know the recipient's userId pass it — the gate
 * then reads the merged prefs without depending on an address lookup.
 *
 * Rules:
 * 1. Essential emails (OTP, password reset, security alerts, etc.) → NEVER suppressed
 * 2. If user's global email toggle is off → suppressed (except essential)
 * 3. If category-specific email toggle is off → suppressed
 * 4. If user has unsubscribed from category via token → suppressed
 * 5. Recurring digest-family mail (category 'digest') needs its own explicit
 *    opt-in: summaryEnabled for the account recap, digestEnabled for digests.
 */
export async function shouldSuppressEmail(to: string, templateName: string, categoryOverride?: string, userId?: string): Promise<boolean> {
  // Essential emails always go through (includes all security emails)
  if (ESSENTIAL_TEMPLATES.has(templateName)) return false;

  // Email Brain templates: 'brain:<eventKey>' — mandatory security events never suppressed.
  const isBrain = templateName.startsWith('brain:');
  const brainEventKey = isBrain ? templateName.slice(6) : null;
  if (isBrain && brainEventKey && isBrainMandatory(brainEventKey)) return false;

  // Look up user by email (UserEmail → merged prefs) — or straight by id when
  // the caller knows it.
  const found = await getPrefsByAddress(to, userId);
  if (!found) return false; // unknown user — let it through
  const prefs: any = found.prefs;
  const globalUnsub = getUnsubMap(prefs);

  // Check global unsubscribe (e.g., from /email/unsubscribe with category='all')
  if (globalUnsub.all === true) return true;

  // Global email toggle — if false, suppress ALL non-essential
  if (prefs.email === false) return true;

  // A paused account gets nothing but the essential set that already returned
  // above — codes, security alerts, and the rest of ESSENTIAL_TEMPLATES.
  if (isEmailPaused(prefs)) return true;

  // Per-category check — skip for Email Brain templates (the decision engine
  // already evaluated preferences before enqueuing the job). Only global toggle
  // + global unsubscribe + quiet hours still apply.
  const category = categoryOverride || TEMPLATE_CATEGORY[templateName];
  if (!isBrain) {
    // The platform's own switches, stored in the DB for the admin panel to set.
    // A category Tirbeo has off is off for everyone, whatever a person chose —
    // the reverse (us overriding somebody's "no") is not on the table.
    const switchKey = category ? SWITCH_BY_CATEGORY[category] : undefined;
    if (switchKey) {
      const global = await getGlobalEmailSwitches();
      if (global[switchKey] !== true) return true;
    }
    // Category-specific check. Callers can override the category when the
    // template name doesn't reflect the notification's real category (e.g.
    // per-notification emails reuse the notification_digest template but must
    // respect the forms/support/tips toggles, not product). 'digest' marks the
    // recurring digest family (account recap, notification digest): the sweep's
    // own gate is only the first line — the send itself still demands the
    // person's explicit yes on the flag that switch is about
    // (summaryEnabled for the recap, digestEnabled for digests), so a future
    // digest caller that forgets to pre-check cannot mail past a 'false'.
    // A missing flag is never consent: these toggles default off everywhere
    // else in this file's rules.
    if (category === 'digest') {
      const isRecap = /summary|recap/.test(templateName);
      const optedIn = isRecap ? prefs.summaryEnabled === true : prefs.digestEnabled === true;
      if (!optedIn) return true;
      if (globalUnsub?.[category] === true) return true;
    } else if (category) {
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
  const { loadNotificationPrefs, saveNotificationPrefs } = await import('@/features/notifications/notifications');

  // Security is compulsory — ignore attempts to unsubscribe
  if (category === 'security') return loadNotificationPrefs(userId);

  const prefs = await loadNotificationPrefs(userId);
  const emailUnsub: any = getUnsubMap(prefs);

  if (category === 'all') {
    prefs.email = false;
    emailUnsub.all = true;
  } else {
    const categoryEmailKey = `${category}Email`;
    prefs[categoryEmailKey] = false;
    emailUnsub[category] = true;
  }
  prefs.unsubscribed = emailUnsub;

  // One write, both places — an unsubscribe that only the mailer could see
  // would be re-decided by the settings screen on the next visit.
  return saveNotificationPrefs(userId, prefs);
}
