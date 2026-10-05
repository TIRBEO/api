import crypto from 'crypto';
import { prisma } from '@/infrastructure/db/prisma';
import { getBranding } from '@/features/branding/branding';
import { getApiBaseUrl } from '@/config/app-urls';
import { createTtlCache } from '@/infrastructure/cache';

interface EmailResult { success: boolean; error?: string; messageId?: string; }

/**
 * Who an address belongs to, for the variables every greeting wants.
 *
 * `{{name}}` is the caller's job, and most callers don't supply it — so the
 * mail goes out with the literal `{{name}}` printed in somebody's inbox
 * (renderTemplate only substitutes what it is handed; the leftover is logged
 * and sent anyway). Resolving it once here, from the recipient rather than
 * from each call site, means no template can render a placeholder at a
 * person's expense. Cached because this is on the path of every mail.
 */
const recipients = createTtlCache<{ name: string; email: string }>(
  10 * 60_000,
  5_000,
  'emailRecipientIdentity',
);

async function recipientIdentity(address: string): Promise<{ name: string; email: string }> {
  const key = address.toLowerCase();
  const hit = recipients.get(key);
  if (hit) return hit;

  const link = await prisma.userEmail
    .findFirst({ where: { address: key }, select: { userId: true, address: true } })
    .catch(() => null);
  const user = link?.userId
    ? await prisma.user
        .findUnique({ where: { id: link.userId }, select: { name: true, email: true } })
        .catch(() => null)
    : await prisma.user
        .findUnique({ where: { email: key }, select: { name: true, email: true } })
        .catch(() => null);

  const resolved = {
    name: (user?.name || '').trim() || key.split('@')[0] || 'there',
    email: user?.email || link?.address || address,
  };
  recipients.set(key, resolved);
  return resolved;
}

/**
 * Record a send attempt as an EmailJob row (+ an EmailDelivery row once the
 * provider responds) — the ONE delivery history in the consolidated schema.
 * Legacy sends have no Email Brain job, so they create their own job row with
 * a `legacy.` event key kept in the payload for auditability.
 */

// EmailJobKind values: otp | verify | reset | digest | notice | test
function jobKindFor(template?: string): 'otp' | 'verify' | 'reset' | 'digest' | 'notice' | 'test' {
  const t = (template || '').toLowerCase();
  if (t.includes('test')) return 'test';
  if (t.includes('reset')) return 'reset';
  if (t.includes('verify')) return 'verify';
  if (t.includes('otp')) return 'otp';
  if (t.includes('digest') || t.includes('summary') || t.includes('weekly')) return 'digest';
  return 'notice';
}

export async function logEmail(input: {
  toEmail: string;
  fromEmail: string;
  subject: string;
  template?: string;
  threadId?: string;
  replyTo?: string;
  status?: string;
  messageId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const eventKey = input.template ? `legacy.${input.template}` : 'legacy.ad_hoc';
    const row = await prisma.email_jobs.create({
      data: {
        toAddress: input.toEmail,
        kind: jobKindFor(input.template),
        templateSlug: input.template || null,
        subject: input.subject,
        status: input.status || 'sent',
        payload: {
          ...(input.metadata || {}),
          eventKey,
          fromEmail: input.fromEmail,
          threadId: input.threadId || null,
          replyTo: input.replyTo || null,
        } as any,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e: any) {
    console.error('[EMAIL_DELIVERY]', e?.message || e);
    return null;
  }
}

/** Finalize a previously created EmailJob after the provider responds. */
async function finalizeEmailLog(logId: string | null, result: EmailResult) {
  if (!logId) return;
  try {
    if (result.success) {
      // select: the live email_jobs/email_deliveries tables are narrower than
      // the legacy schema models; a full-row return would SELECT dead columns.
      await prisma.email_jobs.update({
        where: { id: logId },
        data: { status: 'sent', sentAt: new Date() },
        select: { id: true },
      });
      await prisma.email_deliveries.create({
        data: { jobId: logId, event: 'sent', provider: 'resend', providerId: result.messageId || null },
        select: { id: true },
      });
    } else {
      await prisma.email_jobs.update({
        where: { id: logId },
        data: { status: 'failed', lastError: result.error || null },
        select: { id: true },
      });
    }
  } catch (e: any) {
    console.error('[EMAIL_DELIVERY] finalize failed:', e?.message);
  }
}

/** Stable thread id so replies and follow-ups group in mail clients. */
function deriveThreadId(to: string, subject: string, explicit?: string): string {
  if (explicit) return explicit.slice(0, 255);
  return crypto.createHash('sha1').update(`${to.toLowerCase()}|${subject}`).digest('hex').slice(0, 24);
}

// The emailConfig table is gone in the consolidated schema — config now lives
// in the AppConfig row `email.config` (JSON), with env vars as the fallback.
export async function getEmailConfig() {
  const config: Record<string, any> = {
    provider: process.env.EMAIL_PROVIDER || 'resend',
    enabled: true,
    resendDomain: process.env.EMAIL_RESEND_DOMAIN || 'tirbeo.com',
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.EMAIL_FROM || 'noreply@tirbeo.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Tirbeo',
    defaultFromEmail: process.env.EMAIL_FROM || 'noreply@tirbeo.com',
    defaultFromName: process.env.EMAIL_FROM_NAME || 'Tirbeo',
    alertFromEmail: process.env.EMAIL_ALERT_FROM || 'noreply@tirbeo.com',
    alertFromName: process.env.EMAIL_FROM_NAME || 'Tirbeo',
    welcomeFromEmail: null,
    welcomeFromName: null,
    otpFromEmail: null,
    otpFromName: null,
    resetFromEmail: null,
    resetFromName: null,
    notifyFromEmail: null,
    notifyFromName: null,
    formsFromEmail: null,
    formsFromName: null,
  };
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: 'email.config' } });
    const value = row?.value as Record<string, any> | null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(config, value);
    }
  } catch (e: any) {
    console.warn('[EMAIL] Failed to load config from AppConfig:', e?.message);
  }
  if (!config.apiKey) config.apiKey = process.env.RESEND_API_KEY || '';
  return config;
}

export async function getEmailTemplate(slug: string) {
  return prisma.emailTemplate.findUnique({ where: { slug } });
}

// Vendored locally (packages/ui/src/emails/index.ts) so new templates (e.g. form_flagged)
// ship without an @tirbeo/ui npm publish. Keep in sync with packages/ui/src/emails/index.ts.
import {
  buildTemplates,
  getTemplate,
  renderTemplate,
} from '@/features/email/email-templates';

const fallbackLoggedTemplates = new Set<string>();

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

// `renderTemplate` is imported from email-templates.tsx and re-exported so the
// preview endpoint's existing import path keeps working. It used to be defined
// here as a second copy carrying its own raw-var list, and the two drifted:
// jobs.ts sent `statRows` without listing it, so the weekly summary shipped to
// users with its stat table escaped into visible &lt;div&gt; markup. One
// implementation, one list, so the two cannot drift apart again.
export { renderTemplate };

/**
 * Variables that survived substitution.
 *
 * A template refers to its values as `{{name}}`, and nothing declares which
 * ones a given template needs. So when a caller forgets an argument, or typos a
 * key, the loop above simply does not match it — and the raw text
 * `{{ticketSubject}}` goes out to the customer's inbox inside a nicely designed
 * email. That failure is invisible in review and embarrassing in production.
 *
 * `unsubscribeSection` is expected to be absent when the template is rendered
 * outside the send path (the preview script, the admin preview endpoint), so it
 * is not reported.
 */
export function findUnresolvedVars(html: string, known: Set<string> = new Set()): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
    const key = m[1];
    if (key === 'unsubscribeSection' || known.has(key)) continue;
    found.add(key);
  }
  return [...found];
}

export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  options?: { fromEmail?: string; fromName?: string; replyTo?: string; threadId?: string; templateName?: string; metadata?: Record<string, unknown>; categoryOverride?: string; userId?: string }
): Promise<EmailResult> {
  // ─── Email suppression check (lowest level) ───
  // If the user disabled email or unsubscribed from this category, block non-essential sends.
  // categoryOverride must flow through from sendTemplateEmail — per-notification emails reuse
  // the notification_digest template but belong to forms/support/tips, and evaluating the
  // raw template name would wrongly apply the PRODUCT toggle.
  // userId flows through too: the merged-preferences gate must not depend on
  // reverse-looking the address up (identity addresses have no UserEmail row,
  // and an unresolvable address used to fail OPEN — prefs off, mail still out).
  if (options?.templateName) {
    try {
      const { shouldSuppressEmail } = await import('@/features/email/emailPrefs');
      if (await shouldSuppressEmail(to, options.templateName, options.categoryOverride, options.userId)) {
        if (process.env.NODE_ENV === 'production') {
          console.log(`[EMAIL] Suppressed '${options.templateName}' to ${to} (user prefs)`);
        }
        return { success: true };
      }
    } catch { /* best-effort */ }
  } else {
    // Safety net: even without templateName, check if user globally disabled email
    try {
      const { prisma: p } = await import('@/infrastructure/db/prisma');
      const { loadNotificationPrefs } = await import('@/features/notifications/notifications');
      // Emails live in UserEmail rows; the account's choice is the merged view,
      // not one column of it — a person who turned email off in settings must
      // be off for every sender, however it stores. When the caller hands us
      // the userId, prefer it over the address lookup.
      let uid: string | null = options?.userId || null;
      if (!uid) {
        const emailRow = await p.userEmail.findFirst({
          where: { address: to.toLowerCase() },
          select: { userId: true },
        });
        uid = emailRow?.userId || null;
      }
      const prefs: any = uid ? await loadNotificationPrefs(uid) : null;
      if (prefs && typeof prefs === 'object' && prefs.email === false) {
        console.log(`[EMAIL] Suppressed (no template) to ${to} — user disabled email`);
        return { success: true };
      }
    } catch { /* best-effort */ }
  }

  let config: any = null;
  try {
    config = await getEmailConfig();
  } catch (e: any) {
    console.warn('[EMAIL] Failed to load config from DB:', e?.message);
  }

  const dbApiKey = config?.apiKey || '';
  const apiKey = dbApiKey || process.env.RESEND_API_KEY || '';
  const provider = config?.provider || 'resend';
  const enabled = config?.enabled !== false;

  if (!apiKey) {
    console.error(`[EMAIL] No API key configured (DB: ${dbApiKey ? 'set' : 'empty'}, ENV: ${process.env.RESEND_API_KEY ? 'set' : 'missing'}). Cannot send to ${to}: ${subject}`);
    return { success: false, error: 'No email API key configured' };
  }

  if (!enabled && dbApiKey) {
    console.warn(`[EMAIL] DB config disabled but API key present. Falling through to env var. Sending to ${to}: ${subject}`);
  }

  const fromEmail = options?.fromEmail || config?.fromEmail || 'noreply@tirbeo.com';
  const fromName = options?.fromName || config?.fromName || 'Tirbeo';
  const threadId = deriveThreadId(to, subject, options?.threadId);

  // Create the log row up front so the provider response can finalize it.
  let logId: string | null = null;
  try {
    logId = await logEmail({
      toEmail: to,
      fromEmail,
      subject,
      template: options?.templateName || undefined,
      threadId,
      replyTo: options?.replyTo,
      status: 'pending',
      metadata: options?.metadata,
    });
  } catch { /* logging is best-effort */ }

  let result: EmailResult = { success: false };
  // Resend is the only provider (SMTP was removed by design).
  if (provider !== 'resend' && provider !== 'smtp') {
    console.error(`[EMAIL] Unknown provider "${provider}" — defaulting to resend.`);
  }
  if (provider === 'smtp') {
    // Legacy DB rows may still say 'smtp'; route through Resend so sends keep working.
    console.warn(`[EMAIL] DB config provider is 'smtp' — SMTP is discontinued, using Resend for ${to}.`);
  }
  result = await sendViaResend(apiKey, to, fromEmail, fromName, subject, htmlBody, options?.replyTo);

  await finalizeEmailLog(logId, result);

  return result;
}

/**
 * HTML to plain text.
 *
 * Resend sends the HTML part alone today, which means every one of these emails
 * has no fallback: a client with images or CSS disabled, a screen reader
 * reading the markup, and anyone reading in a terminal all get the tag soup or
 * nothing at all. The multipart/alternative text part is what those clients
 * actually use, so it is worth the ~30 lines.
 *
 * Deliberately dependency-free and lossy — this is a fallback, not a second
 * rendering pass. Block-level elements become blank lines, links become
 * "text ( url)", and anything with no text at all (the logo image, spacers) is
 * dropped rather than guessed at.
 */
export function htmlToText(html: string): string {
  let out = html;

  // Drop everything that carries no prose.
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  out = out.replace(/<head[\s\S]*?<\/head>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<img\b[^>]*>/gi, '');

  // react-email pads <Preview> with a run of zero-width characters so the
  // preheader is invisible in the HTML body but still shows in the inbox.
  // In a text part those characters are not invisible — they arrive as a wall
  // of noise several thousand characters long, ahead of the actual message.
  out = out.replace(/[\u200B-\u200F\u2060\uFEFF]/g, '');

  // Links: keep the URL, because in an email the link IS the content.
  out = out.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const cleanHref = href.trim();
      if (!cleanHref) return label;
      // Parenthesised, not `<bracketed>`: the tag stripper below runs over the
      // whole string and would eat `<https://...>` as if it were markup, which
      // is how the URL silently vanished from the text part.
      return label && label !== cleanHref ? `${label} (${cleanHref})` : cleanHref;
    },
  );

  // Structural breaks. A </span> is treated as a line break because react-email
  // uses display:block spans for every stacked pair — "Your code" above the
  // digits, a label above a value — and without this those run together as
  // "Your code482913".
  out = out.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  out = out.replace(/<\/(p|div|tr|h1|h2|h3|h4|li|table|section)\s*>/gi, '\n\n');
  out = out.replace(/<\/(span)\s*>/gi, '\n');
  out = out.replace(/<\/(td|th)\s*>/gi, '\t');

  // Strip every remaining tag.
  out = out.replace(/<[^>]+>/g, '');

  // Unescape the handful of entities react-email can emit.
  out = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));

  // Collapse the runs of blank space the table layout leaves behind, and trim
  // each line: the <Preview> block is padded with a long unbroken run of
  // &nbsp; that survives zero-width stripping as a 150-character blank line.
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

async function sendViaResend(apiKey: string, to: string, fromEmail: string, fromName: string, subject: string, html: string, replyTo?: string): Promise<EmailResult> {
  // PRIVACY: single-recipient only — never add cc/bcc. Each email is sent
  // individually to one address (no bulk, no secondary recipients).
  const body: Record<string, any> = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to: [to],
    subject,
    html,
    text: htmlToText(html),
    tracking: { click: { enable: false }, open: { enable: true } },
  };
  // Explicitly ensure no CC/BCC leak — strip if somehow present
  delete (body as any).cc;
  delete (body as any).bcc;
  if (replyTo) body.replyTo = replyTo;

  // Retry up to 2 times on transient network errors
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text();
        // Don't retry client errors (4xx) — only server errors (5xx)
        if (res.status < 500) return { success: false, error: `Resend error ${res.status}: ${err}` };
        if (attempt < 2) { await new Promise(r => setTimeout(r, 500 * attempt)); continue; }
        return { success: false, error: `Resend error ${res.status}: ${err}` };
      }
      const data: any = await res.json();
      return { success: true, messageId: data.id };
    } catch (err: unknown) {
      const msg = String(err);
      // Retry on network errors (fetch failed, ECONNRESET, etc.)
      if (attempt < 2 && (msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT'))) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      return { success: false, error: msg };
    }
  }
  return { success: false, error: 'Email delivery failed after retries' };
}

// ─── Fallback templates using @tirbeo/ui ───

async function buildFallbackTemplates(): Promise<Record<string, { subject: string; html: string }>> {
  return buildTemplates((await getBranding()).logoUrl);
}


export async function sendTemplateEmail(
  to: string,
  templateName: string,
  variables: Record<string, string>,
  options?: { fromEmail?: string; fromName?: string; rawVars?: string[]; replyTo?: string; threadId?: string; skipSuppression?: boolean; categoryOverride?: string; userId?: string }
): Promise<EmailResult> {
  // ─── Email suppression check ───
  // THE single enforcement point for user preferences: every templated send is
  // gated here from the merged prefs (emailPrefs.shouldSuppressEmail), so a new
  // template can never be the one that forgot to ask. Essential emails (OTPs,
  // password resets, security alerts) always go through — that exemption lives
  // in the gate, not in the callers.
  // categoryOverride lets callers evaluate the RIGHT preference category when
  // the template name doesn't match (per-notification emails reuse the
  // notification_digest template but belong to forms/support/tips).
  // userId is preferred over the address reverse-lookup when the caller knows
  // who it is mailing.
  if (!options?.skipSuppression) {
    try {
      const { shouldSuppressEmail } = await import('@/features/email/emailPrefs');
      if (await shouldSuppressEmail(to, templateName, options?.categoryOverride, options?.userId)) {
        console.log(`[EMAIL] Suppressed '${templateName}' to ${to} (user prefs)`);
        return { success: true }; // pretend success — don't throw
      }
    } catch { /* suppression check is best-effort */ }
  }

  // renderTemplate unions this with RAW_HTML_VARS itself, so the canonical
  // section slots stay raw whether or not a caller remembers to list them.
  const rawKeys = new Set(options?.rawVars || []);
  const branding = await getBranding();
  const logoUrl = branding.logoUrl;
  const mergedVars: Record<string, string> = { ...variables, logoUrl, brandName: branding.brandName, brandTagline: branding.brandTagline };

  // The two variables the whole catalogue greets with, filled from the
  // recipient when the caller didn't. Best-effort: a database hiccup must not
  // cost somebody their sign-in code, and an empty greeting is the fallback.
  if (!mergedVars.name || !mergedVars.primaryEmail) {
    try {
      const who = await recipientIdentity(to);
      if (!mergedVars.name) mergedVars.name = who.name;
      if (!mergedVars.primaryEmail) mergedVars.primaryEmail = who.email;
    } catch {
      /* left unresolved — the send still goes, and the log says which */
    }
  }

  // ─── Unsubscribe URLs ───
  // Essential/security emails NEVER get unsubscribe links — they are compulsory.
  // Other emails get a single unsubscribe page link.
  try {
    const { ESSENTIAL_TEMPLATES, isBrainMandatory, buildUnsubscribeUrl } = await import('@/features/email/emailPrefs');
    const isEssential = (ESSENTIAL_TEMPLATES as Set<string>).has(templateName);
    const isBrainSec = templateName.startsWith('brain:') && isBrainMandatory(templateName.slice(6));
    const apiBase = getApiBaseUrl();
    if (!isEssential && !isBrainSec) {
      // Signed per-recipient link: the POST that mutes email requires this
      // token (ownership proof), so merely knowing an address can't mute it.
      const unsubUrl = (await buildUnsubscribeUrl(to)) || `${apiBase}/api/emails/unsubscribe`;
      mergedVars['unsubscribeUrl'] = unsubUrl;
      mergedVars['managePreferencesUrl'] = unsubUrl;
      /* #6e6e73 on the #000 canvas stays legible — an unsubscribe link is
         legally required to be readable, and a control nobody can read is not
         one they can act on. Matches the template's faint footer tone. */
      mergedVars['unsubscribeSection'] = `<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6e6e73"><a href="${unsubUrl}" style="color:#6e6e73;text-decoration:underline;">Unsubscribe from these emails</a></p>`;
    } else {
      mergedVars['unsubscribeUrl'] = '';
      mergedVars['unsubscribeSection'] = '';
      mergedVars['managePreferencesUrl'] = '';
    }
  } catch {
    const apiBase = getApiBaseUrl();
    mergedVars['unsubscribeUrl'] = `${apiBase}/api/emails/unsubscribe`;
    mergedVars['unsubscribeSection'] = `<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#6e6e73"><a href="${apiBase}/api/emails/unsubscribe" style="color:#6e6e73;text-decoration:underline;">Unsubscribe from these emails</a></p>`;
    mergedVars['managePreferencesUrl'] = '';
  }

  // ─── Sending domain ───
  // tirbeo.com is the only domain verified on Resend; mails./send. subdomains
  // were never verified and every send from them fails with a 403. Keep the
  // per-category sender NAMES (a code email should not read like a digest),
  // but every address must live on the verified domain until the subdomains
  // are actually verified there.
  const SECURITY_TEMPLATES = new Set([
    'signup_otp', 'login_otp', 'verify_email', 'password_reset_otp', 'password_reset_link',
    'magic_link', 'account_recovery', 'delete_account_otp', 'password_changed', 'reauth_otp',
    'suspicious_login', 'two_factor_disabled', 'login_alert', 'account_suspended', 'account_deleted', 'export_ready',
  ]);
  const ADMIN_TEMPLATES = new Set(['admin_alert', 'system_alert', 'admin_crash_report', 'admin_test']);
  const humanMailboxTemplates = ['welcome'];

  const adminFrom = process.env.ADMIN_FROM_EMAIL || 'admin@tirbeo.com';

  const DOMAIN_FROM = {
    casual: { email: 'noreply@tirbeo.com', name: branding.brandName || 'Tirbeo' },
    security: { email: 'noreply@tirbeo.com', name: 'Tirbeo Security' },
    admin: { email: adminFrom, name: 'Tirbeo Admin' },
  };
  const category = ADMIN_TEMPLATES.has(templateName) ? 'admin'
    : SECURITY_TEMPLATES.has(templateName) ? 'security'
    : humanMailboxTemplates.includes(templateName) ? 'admin'
    : 'casual';

  const config = await getEmailConfig();

  let defaultFromEmail = DOMAIN_FROM[category].email;
  let defaultFromName = DOMAIN_FROM[category].name;

  if (config && category === 'security') {
    // Explicit DB overrides still win when set (per-type sender customization)
    const otpSet = ['signup_otp', 'login_otp', 'verify_email'];
    const resetSet = ['password_reset_otp', 'password_reset_link'];
    if (otpSet.includes(templateName) && config.otpFromEmail) {
      defaultFromEmail = config.otpFromEmail;
      defaultFromName = config.otpFromName || defaultFromName;
    } else if (resetSet.includes(templateName) && config.resetFromEmail) {
      defaultFromEmail = config.resetFromEmail;
      defaultFromName = config.resetFromName || defaultFromName;
    }
  }

  const finalOptions = {
    fromEmail: options?.fromEmail || defaultFromEmail,
    fromName: options?.fromName || defaultFromName,
    replyTo: options?.replyTo || (humanMailboxTemplates.includes(templateName) ? adminFrom : undefined),
    threadId: options?.threadId,
    categoryOverride: options?.categoryOverride,
    userId: options?.userId,
  };

  // Built-in templates win over DB rows. Asked for by name rather than by
  // building the whole catalogue: this is the one template this send needs.
  const fallback = await getTemplate(templateName, branding.logoUrl);
  if (fallback) {
    if (!fallbackLoggedTemplates.has(templateName)) {
      fallbackLoggedTemplates.add(templateName);
      console.log(`[EMAIL] Using built-in template: '${templateName}'`);
    }
    const subject = renderTemplate(fallback.subject, mergedVars, rawKeys);
    const htmlBody = renderTemplate(fallback.html, mergedVars, rawKeys);
    const missing = findUnresolvedVars(subject + htmlBody, rawKeys);
    if (missing.length) {
      /* Log loudly and still send: a support email with one blank line beats
         an email that never arrives, and the caller can fix the argument. */
      console.error(
        `[EMAIL] Template '${templateName}' sent with unresolved variables: ${missing.join(', ')}`,
      );
    }
    return sendEmail(to, subject, htmlBody, { ...finalOptions, templateName });
  }

  // Fall back to DB-stored templates only if no built-in exists
  const template = await getEmailTemplate(templateName);
  if (template) {
    const subject = renderTemplate(template.subject, mergedVars, rawKeys);
    const htmlBody = renderTemplate(template.html, mergedVars, rawKeys);
    return sendEmail(to, subject, htmlBody, {
      ...finalOptions,
      templateName,
    });
  }

  return { success: false, error: `Template '${templateName}' not found` };
}

export async function getFallbackTemplates(): Promise<Record<string, { subject: string; html: string }>> {
  return buildFallbackTemplates();
}
