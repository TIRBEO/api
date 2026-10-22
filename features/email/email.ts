import crypto from 'crypto';
import { after } from 'next/server';
import type { Transporter } from 'nodemailer';
import { prisma } from '@/infrastructure/db/prisma';
import { getBranding } from '@/features/branding/branding';
import { getApiBaseUrl, getDashboardBaseUrl } from '@/config/app-urls';
import { createTtlCache } from '@/infrastructure/cache';
import { unsubscribeSection } from '@/features/email/email-fragments';
import {
  EMAIL_CACHE_KEYS,
  EMAIL_CACHE_TTL,
  cachedConfigRead,
  cachedEmailRead,
} from '@/features/email/emailCache';

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
  // A User row has no name column — the display name lives on user_profile, so
  // it comes through the relation. Asking for `name` here threw on every mail
  // and the .catch turned that into a silent fallback to the address prefix.
  const select = { email: true, profile: { select: { name: true } } } as const;
  const user = link?.userId
    ? await prisma.user
        .findUnique({ where: { id: link.userId }, select })
        .catch(() => null)
    : await prisma.user
        .findUnique({ where: { email: key }, select })
        .catch(() => null);

  const resolved = {
    name: (user?.profile?.name || '').trim() || key.split('@')[0] || 'there',
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
        // Both recipient columns exist and the recipient-time index is on
        // `to_email`, so writing only `to_address` left every job row with an
        // empty recipient and an index nothing could be looked up through.
        toEmail: input.toEmail,
        toAddress: input.toEmail,
        eventKey,
        category: jobKindFor(input.template),
        kind: jobKindFor(input.template),
        templateSlug: input.template || null,
        subject: input.subject,
        status: input.status || 'sent',
        payload: {
          ...(input.metadata || {}),
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
async function finalizeEmailLog(
  logId: string | null,
  result: EmailResult,
  ctx: { provider: string; toEmail: string; subject: string; category: string; eventKey: string },
) {
  if (!logId) return;
  const { provider, toEmail, subject, category, eventKey } = ctx;
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
        data: {
          jobId: logId,
          toEmail,
          subject,
          category,
          eventKey,
          event: 'sent',
          status: 'sent',
          provider,
          providerId: result.messageId || null,
          messageId: result.messageId || null,
        },
        select: { id: true },
      });
    } else {
      await prisma.email_jobs.update({
        where: { id: logId },
        data: { status: 'failed', lastError: result.error || null },
        select: { id: true },
      });
      // A send the provider rejected used to leave no trace at all in the
      // delivery history — the table only ever held rows with the column
      // default `sent`, so the one question ops asks ("did it go out?") read
      // back as yes. Failures are rows now.
      await prisma.email_deliveries.create({
        data: {
          jobId: logId,
          toEmail,
          subject,
          category,
          eventKey,
          event: 'failed',
          status: 'failed',
          provider,
        },
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

// Mailcow's postfix pins MAIL FROM to the authenticated mailbox (rejects
// mismatched senders with 553), so in SMTP mode every fallback sender must
// be an address we actually own on tirbeo.app.
function emailIsSmtp(): boolean {
  return (process.env.EMAIL_PROVIDER || '').toLowerCase() === 'smtp';
}
function fallbackSender(): string {
  return emailIsSmtp() ? (process.env.SMTP_USER || 'support@tirbeo.app') : 'noreply@tirbeo.com';
}

// Resend refuses to send from any domain that has not completed DNS
// verification (403). Callers and the admin config both carry addresses from
// other hosts — `support@tirbeo.app` from the self-hosted Mailcow setup is one
// of them — so the sender is checked at the one place every send passes
// through rather than at each call site.
//
// The verified set is an env list, not a single domain: an identity space can
// move to a subdomain (`users.tirbeo.com`) without stranding the apex's brand
// mailboxes, by listing both once the subdomain clears verification.
function verifiedSenderDomains(): string[] {
  return (process.env.EMAIL_RESEND_DOMAIN || 'tirbeo.com')
    .split(/[,\s]+/)
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function verifiedSender(address: string): string {
  const domain = (address.split('@')[1] || '').toLowerCase();
  const verified = verifiedSenderDomains();
  if (domain && !verified.some((v) => domain === v || domain.endsWith(`.${v}`))) {
    console.warn(`[EMAIL] Sender domain "${domain}" is not verified on Resend — sending as "${verified[0]}"`);
    return fallbackSender();
  }
  return address;
}

/**
 * The address a support conversation reaches its readers from.
 *
 * A desk that signs every message `support@` hides the one fact the reader
 * wants before opening it — who wrote. So when the account's own identity lives
 * on the domain the provider accepts mail from, the request goes out as that
 * address under the person's display name, with Reply-To still pointing at the
 * mailbox they actually read.
 *
 * The domain has to match a verified entry exactly, not merely sit underneath
 * one: Resend verifies one domain at a time and answers 403 for
 * `handle@users.tirbeo.com` until that subdomain is verified on its own, and a
 * support mail that never arrives is worse than one that shows the shared
 * mailbox. Listing the subdomain in EMAIL_RESEND_DOMAIN once Resend verifies it
 * — and pointing TIRBEO_MAIL_DOMAIN at it — switches this on by itself.
 */
export function supportSender(identity?: string | null, displayName?: string | null): { fromEmail?: string; fromName?: string } {
  const address = (identity || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return {};
  const domain = address.slice(at + 1);
  // Mailcow's postfix pins MAIL FROM to the authenticated mailbox and answers
  // 553 for anything else, so a per-account sender only exists in provider mode.
  if (emailIsSmtp() || !verifiedSenderDomains().includes(domain)) return {};
  // A display name travels into a header, and a header is where an injected
  // newline stops being a typo and starts being a second message.
  const name = (displayName || '').replace(/[\r\n"<>]/g, '').trim().slice(0, 80);
  return { fromEmail: address, fromName: name || address };
}

// The emailConfig table is gone in the consolidated schema — config now lives
// in the AppConfig row `email.config` (JSON), with env vars as the fallback.
export async function getEmailConfig() {
  const config: Record<string, any> = {
    provider: process.env.EMAIL_PROVIDER || 'resend',
    enabled: true,
    resendDomain: process.env.EMAIL_RESEND_DOMAIN || 'tirbeo.com',
    apiKey: process.env.RESEND_API_KEY || '',
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: parseInt(process.env.SMTP_PORT || '', 10) || 587,
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    fromEmail: process.env.EMAIL_FROM || fallbackSender(),
    fromName: process.env.EMAIL_FROM_NAME || 'Tirbeo',
    defaultFromEmail: process.env.EMAIL_FROM || fallbackSender(),
    defaultFromName: process.env.EMAIL_FROM_NAME || 'Tirbeo',
    alertFromEmail: process.env.EMAIL_ALERT_FROM || fallbackSender(),
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
  const stored = await cachedConfigRead(EMAIL_CACHE_KEYS.config, async () => {
    try {
      const row = await prisma.appConfig.findUnique({ where: { key: 'email.config' } });
      const value = row?.value as Record<string, any> | null;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (e: any) {
      console.warn('[EMAIL] Failed to load config from AppConfig:', e?.message);
      return null;
    }
  });
  if (stored) Object.assign(config, stored);
  if (!config.apiKey) config.apiKey = process.env.RESEND_API_KEY || '';
  return config;
}

/** An admin override for one template. Cached per slug: a broadcast re-reads
    the same row once per mail without this, and a missing row is a real answer
    rather than a miss (see emailCache). */
export async function getEmailTemplate(slug: string) {
  return cachedEmailRead(
    EMAIL_CACHE_KEYS.template(slug),
    EMAIL_CACHE_TTL.template,
    () => prisma.emailTemplate.findUnique({ where: { slug } }),
  );
}

// The built-in catalogue is plain string templates beside this file — no
// component library, so a new template ships without a dependency or a publish.
import {
  getTemplate,
  renderTemplate,
} from '@/features/email/email-templates';

const fallbackLoggedTemplates = new Set<string>();

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

// `renderTemplate` is imported from email-templates.ts and re-exported so the
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

/**
 * Last-resort cover for a variable a caller forgot to pass.
 *
 * Logging the miss is the right developer answer and the wrong reader answer:
 * `Time {{loginTime}}` in a nicely designed mail reads as a broken product, or
 * as a phish. So after the miss is logged, the token is replaced with plain
 * words, and a missing *link* is pointed at the dashboard rather than left as
 * a dead relative href. Only the names actually reported missing are touched,
 * so a template that is rendering correctly is never rewritten.
 */
export function fillUnresolvedVars(markup: string, missing: string[]): string {
  if (!missing.length) return markup;
  const names = new Set(missing);
  const fill = (key: string): string | null =>
    names.has(key) && key !== 'managePreferencesUrl' ? 'Not available' : null;

  return markup
    .replace(/href="[^"]*\{\{\s*([a-zA-Z0-9_]+)\s*\}\}[^"]*"/g, (whole, key: string) =>
      fill(key) ? `href="${getDashboardBaseUrl()}"` : whole)
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) => fill(key) ?? whole);
}

/**
 * The subject line, in the text a person reads rather than the markup a body
 * needs.
 *
 * `renderTemplate` escapes every value because it is filling HTML, and that
 * left `Can't sign in` arriving as `Can&#39;t sign in` — an entity is meaningless
 * in a header, where there is no parser to undo it. Undoing exactly the five
 * entities `esc` can produce is safe by construction; collapsing newlines is not
 * cosmetic, since a subject that reaches a header raw is a header-injection
 * hole.
 */
function subjectLine(value: string): string {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  options?: { fromEmail?: string; fromName?: string; replyTo?: string; threadId?: string; templateName?: string; metadata?: Record<string, unknown>; categoryOverride?: string; userId?: string; headers?: Record<string, string> }
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
        // Logged in every environment: this branch reports success to its
        // caller, so a suppression that prints nothing is indistinguishable
        // from a delivered mail — in exactly the environment people debug in.
        console.log(`[EMAIL] Suppressed '${options.templateName}' to ${to} (user prefs)`);
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
  const provider = String(config?.provider || 'resend').toLowerCase();
  const enabled = config?.enabled !== false;

  if (!enabled && dbApiKey) {
    console.warn(`[EMAIL] DB config disabled — not sending to ${to}: ${subject}`);
    return { success: false, error: 'Email sending disabled in admin config' };
  }

  // SMTP credentials resolve from the DB config with env as fallback — the
  // admin panel's PATCH /api/admin/email/config must actually change where
  // mail goes, not just what the panel displays.
  const smtpHost = config?.smtpHost || process.env.SMTP_HOST || '';
  const smtpPort = parseInt(String(config?.smtpPort || process.env.SMTP_PORT || ''), 10) || 587;
  const smtpUser = config?.smtpUser || process.env.SMTP_USER || '';
  const smtpPass = config?.smtpPass || process.env.SMTP_PASS || '';
  const smtpTlsServername = process.env.SMTP_TLS_SERVERNAME || '';

  if (!apiKey && provider !== 'smtp') {
    console.error(`[EMAIL] No API key configured (DB: ${dbApiKey ? 'set' : 'empty'}, ENV: ${process.env.RESEND_API_KEY ? 'set' : 'missing'}). Cannot send to ${to}: ${subject}`);
    return { success: false, error: 'No email API key configured' };
  }
  if (provider === 'smtp' && !(smtpHost && smtpUser && smtpPass)) {
    console.error(`[EMAIL] provider=smtp but SMTP host/user/pass incomplete. Cannot send to ${to}: ${subject}`);
    return { success: false, error: 'SMTP not configured' };
  }

  let fromEmail = options?.fromEmail || config?.fromEmail || fallbackSender();
  // Mailcow's postfix pins MAIL FROM to the authenticated mailbox (553 on any
  // mismatch), so in SMTP mode every sender identity collapses onto smtpUser.
  // Display names survive; only the address is rewritten.
  if (provider === 'smtp' && smtpUser && fromEmail.toLowerCase() !== smtpUser.toLowerCase()) {
    fromEmail = smtpUser;
  }
  if (provider !== 'smtp') fromEmail = verifiedSender(fromEmail);
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
  if (provider !== 'resend' && provider !== 'smtp') {
    console.error(`[EMAIL] Unknown provider "${provider}" — defaulting to resend.`);
  }
  if (provider === 'smtp') {
    result = await sendViaSmtp(
      { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass, tlsServername: smtpTlsServername },
      to, fromEmail, fromName, subject, htmlBody, options?.replyTo, options?.headers,
    );
  } else {
    result = await sendViaResend(apiKey, to, fromEmail, fromName, subject, htmlBody, options?.replyTo, options?.headers);
  }

  await finalizeEmailLog(logId, result, {
    provider,
    toEmail: to,
    subject,
    category: jobKindFor(options?.templateName),
    eventKey: options?.templateName ? `legacy.${options.templateName}` : 'legacy.ad_hoc',
  });

  return result;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  rarr: '→',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
};

/**
 * HTML to plain text.
 *
 * Both providers take a `text` part, and this is what a client with images or
 * CSS disabled, a screen reader, and anyone reading in a terminal actually get.
 * Without it they get the tag soup or nothing at all, so it is worth the ~30
 * lines.
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

  // The preheader is hidden in the HTML (display:none) precisely because the
  // inbox already shows it beside the subject — repeating it as the first line
  // of the text part would duplicate the heading two lines later. The shell
  // marks that block `data-skip-in-text` for exactly this.
  out = out.replace(/<div[^>]*data-skip-in-text="true"[\s\S]*?<\/div>/i, '');

  // Padding runs of zero-width characters keep the preheader from swallowing the
  // text after it in the inbox. In a text part they are not invisible — they
  // arrive as noise ahead of the actual message.
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

  // Structural breaks. A </span> is treated as a line break because the detail
  // rows stack a label in one span above its value, and without this they run
  // together as "Your code482913".
  out = out.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  out = out.replace(/<\/(p|div|tr|h1|h2|h3|h4|li|table|section)\s*>/gi, '\n\n');
  out = out.replace(/<\/(span)\s*>/gi, '\n');
  out = out.replace(/<\/(td|th)\s*>/gi, '\t');

  // Strip every remaining tag.
  out = out.replace(/<[^>]+>/g, '');

  // Unescape the entities the templates and the runtime fragments can emit.
  // `&middot;` separates a list heading from its count and `&copy;` opens the
  // legal bar, so missing them put literal ampersand-code in the reader's inbox.
  out = out
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));

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

interface SmtpSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  tlsServername?: string;
}

// One pooled transport per SMTP endpoint, kept for the life of the process.
// Building a transport per message means a fresh TCP connect, STARTTLS
// handshake and AUTH login for every email — and the sender awaits all of it,
// which is why a mail that takes 300ms to accept can take 3s to send here.
// The key carries a digest of the password rather than the password itself, so
// rotating the credential in AppConfig retires the old transport instead of
// every send continuing to authenticate with a stale one.
const smtpTransports = new Map<string, Transporter>();

function transportKey(smtp: SmtpSettings): string {
  const passDigest = crypto.createHash('sha256').update(smtp.pass).digest('hex').slice(0, 16);
  return `${smtp.host}|${smtp.port}|${smtp.user}|${smtp.tlsServername ?? ''}|${passDigest}`;
}

async function transportFor(smtp: SmtpSettings): Promise<Transporter> {
  const key = transportKey(smtp);
  const existing = smtpTransports.get(key);
  if (existing) return existing;
  const { createTransport } = await import('nodemailer');
  const transporter = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    ...(smtp.tlsServername ? { tls: { servername: smtp.tlsServername } } : {}),
    auth: { user: smtp.user, pass: smtp.pass },
    pool: true,
    // Two sockets is the whole of the concurrency this needs; an idle one is
    // kept for nodemailer's default and a frozen function drops it anyway.
    maxConnections: 2,
  });
  // A credential rotation leaves the retired transport with nothing to send on;
  // close it once its in-flight messages have had a moment to finish.
  const stale = [...smtpTransports.entries()].filter(([k]) => k.startsWith(`${smtp.host}|${smtp.port}|${smtp.user}|`) && k !== key);
  for (const [k, t] of stale) {
    smtpTransports.delete(k);
    setTimeout(() => { try { t.close(); } catch {} }, 70_000).unref();
  }
  smtpTransports.set(key, transporter);
  return transporter;
}

async function sendViaSmtp(smtp: SmtpSettings, to: string, fromEmail: string, fromName: string, subject: string, html: string, replyTo?: string, headers?: Record<string, string>): Promise<EmailResult> {
  // Self-hosted delivery via Mailcow submission (STARTTLS, verified cert).
  // Mailcow pins MAIL FROM to the authenticated mailbox, so the caller has
  // already collapsed fromEmail onto smtp.user. Single-recipient only,
  // mirroring the Resend privacy rule.
  let transporter: Transporter;
  try {
    transporter = await transportFor(smtp);
  } catch (err: unknown) {
    return { success: false, error: `SMTP error: ${String(err)}` };
  }
  try {
    const info = await transporter.sendMail({
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to,
      subject,
      html,
      text: htmlToText(html),
      ...(replyTo ? { replyTo } : {}),
      ...(headers && Object.keys(headers).length ? { headers } : {}),
    });
    return { success: true, messageId: info.messageId || undefined };
  } catch (err: unknown) {
    return { success: false, error: `SMTP error: ${String(err)}` };
  }
}

async function sendViaResend(apiKey: string, to: string, fromEmail: string, fromName: string, subject: string, html: string, replyTo?: string, headers?: Record<string, string>): Promise<EmailResult> {
  // PRIVACY: single-recipient only — never add cc/bcc. Each email is sent
  // individually to one address (no bulk, no secondary recipients).
  const body: Record<string, any> = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to: [to],
    subject,
    html,
    text: htmlToText(html),
    // No tracking pixel: an open-tracking 1x1 image is blocked by Gmail's
    // default image settings and renders as a broken-image chip inside the
    // mail — the artefact, not the metric, is what the reader sees.
    tracking: { click: { enable: false }, open: { enable: false } },
  };
  // Explicitly ensure no CC/BCC leak — strip if somehow present
  delete (body as any).cc;
  delete (body as any).bcc;
  if (replyTo) body.replyTo = replyTo;
  if (headers && Object.keys(headers).length) body.headers = headers;

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


/**
 * Mail the caller's answer does not depend on — a login alert, a welcome note,
 * an "export is ready" notice — goes out after the response is already sent.
 *
 * Two problems solved at once. The request stops paying the provider's round
 * trip (hundreds of milliseconds to seconds) on the user's side, and the send is
 * *scheduled* instead of merely started: an un-awaited promise here is free to
 * be cut off when a serverless function freezes at the end of the response,
 * which means the mail silently never happens. `after` is the platform's
 * guarantee that it does.
 *
 * Outside a request — the cron jobs, the standalone server — there is no
 * response to be after: `after` throws, and the send runs inline instead and is
 * handed back so a job that wants to can await it.
 */
export function sendTemplateEmailAfter(
  to: string,
  templateName: string,
  variables: Record<string, string>,
  options?: Parameters<typeof sendTemplateEmail>[3]
): Promise<void> | void {
  const run = () => sendTemplateEmail(to, templateName, variables, options)
    .then((r) => { if (!r.success) console.error(`[EMAIL/AFTER] ${templateName} to ${to} failed: ${r.error}`); })
    .catch((e: any) => console.error(`[EMAIL/AFTER] ${templateName} threw: ${e?.message || e}`));
  try {
    after(run);
  } catch {
    return run();
  }
}

export async function sendTemplateEmail(
  to: string,
  templateName: string,
  variables: Record<string, string>,
  options?: { fromEmail?: string; fromName?: string; rawVars?: string[]; replyTo?: string; threadId?: string; skipSuppression?: boolean; categoryOverride?: string; userId?: string; metadata?: Record<string, unknown> }
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
      mergedVars['unsubscribeSection'] = unsubscribeSection(unsubUrl);
    } else {
      mergedVars['unsubscribeUrl'] = '';
      mergedVars['unsubscribeSection'] = '';
      mergedVars['managePreferencesUrl'] = '';
    }
  } catch {
    const apiBase = getApiBaseUrl();
    const unsubUrl = `${apiBase}/api/emails/unsubscribe`;
    mergedVars['unsubscribeUrl'] = unsubUrl;
    mergedVars['unsubscribeSection'] = unsubscribeSection(unsubUrl);
    mergedVars['managePreferencesUrl'] = '';
  }

  // ─── Sending domain ───
  /* Three domains are verified on Resend, and a reader who has seen the mail
     learns what it is from the address before they read the subject. So each
     kind gets its own, and each own is chosen for what that mail has to do:

       tirbeo.com         — the brand's own voice. Security warnings, answers
                            from support, and anything a person might forward or
                            check against a search engine. The apex carries the
                            longest-standing reputation, so the mail that must
                            not be guessed at as phishing sits here.
       mails.tirbeo.com   — the machines. One-time codes, digests, maintenance
                            notices and staff alerts: mail nobody is expected to
                            answer, so nothing that needs the brand's best
                            address is spent on it.
       users.tirbeo.com   — the accounts. A handle's own mailbox, the sender on
                            a support request (a person writing rather than the
                            product announcing), and the address on mail about
                            one account's own status — suspended, exported, back
                            again. Nothing brand-wide is spent from here.

     Every one of them stays env-overridable, and `verifiedSender` drops any
     address whose domain Resend has not confirmed — a wrong default degrades to
     the working sender instead of failing the send. */
  const SECURITY_TEMPLATES = new Set([
    'password_changed', 'suspicious_login', 'two_factor_disabled', 'two_factor_enabled', 'login_alert',
  ]);
  /* Mail about one account rather than one event on it: it was suspended, its
     export finished, it is coming back. The account's own address is the
     subject line, so the identity domain sends it — a reader who lives on
     `handle@users.tirbeo.com` gets the mail about that handle from there. */
  const ACCOUNT_TEMPLATES = new Set([
    'account_suspended', 'account_deleted', 'account_deactivated', 'reactivation', 'export_ready',
  ]);
  // A code and a warning about the account are different problems, and they
  // read differently in an inbox before anyone opens them.
  const CODE_TEMPLATES = new Set([
    'signup_otp', 'login_otp', 'verify_email', 'password_reset_otp', 'password_reset_otp_recovery',
    'password_reset_link', 'magic_link', 'account_recovery', 'delete_account_otp', 'reauth_otp',
  ]);
  const ADMIN_TEMPLATES = new Set(['admin_alert', 'admin_test']);
  // A conversation reads differently from a notice, and so does its sender:
  // "Tirbeo Support" answering beats an automated name answering.
  const SUPPORT_TEMPLATES = new Set(['support_request_received', 'support_reply', 'support_request_admin']);
  // Scheduled, recurring, or "here is something worth knowing" — read when
  // convenient, never answered, and unsubscribable.
  const NOTICE_TEMPLATES = new Set([
    'notification_digest', 'weekly_summary', 'product_update',
    'maintenance_notification', 'maintenance_complete', 'security_tip',
    'tirbeo_account_onboarding',
  ]);
  const humanMailboxTemplates = ['welcome'];

  const adminFrom = process.env.ADMIN_FROM_EMAIL || fallbackSender();

  /* One mailbox per kind of mail, so the reader can tell what a message is
     before opening it and a reply lands somewhere a person actually reads.
     Env-overridable, because which mailboxes exist is a deployment question.

     Only when the provider can claim them: Resend verifies a DOMAIN, so any
     local part on it sends, while Mailcow's postfix pins MAIL FROM to the
     authenticated mailbox and answers 553 for any other address — so in SMTP
     mode every category collapses back to the one address we own. */
  const alias = (envName: string, address: string): string =>
    emailIsSmtp() ? fallbackSender() : verifiedSender(process.env[envName] || address);

  const DOMAIN_FROM = {
    casual: { email: alias('EMAIL_HELLO_FROM', 'hello@tirbeo.com'), name: branding.brandName || 'Tirbeo' },
    code: { email: alias('EMAIL_CODE_FROM', 'code@mails.tirbeo.com'), name: 'Tirbeo' },
    security: { email: alias('EMAIL_SECURITY_FROM', 'security@tirbeo.com'), name: 'Tirbeo Security' },
    support: { email: alias('EMAIL_SUPPORT_FROM', 'support@tirbeo.com'), name: 'Tirbeo Support' },
    // Suspended, deleted, exported, reactivated — the account speaking about
    // itself, on the domain the account's own address lives.
    account: { email: alias('EMAIL_ACCOUNT_FROM', 'account@users.tirbeo.com'), name: 'Tirbeo Accounts' },
    notice: { email: alias('EMAIL_NOTICE_FROM', 'team@mails.tirbeo.com'), name: branding.brandName || 'Tirbeo' },
    // An alert about the admin panel is for the people who run it, never a
    // reader's inbox — so it costs the brand nothing to put it on the machines.
    admin: { email: alias('EMAIL_ALERT_FROM', 'alerts@mails.tirbeo.com'), name: 'Tirbeo Ops' },
    // Mail a named person signs off — a welcome — carries the address the
    // admin configured as their own, not an automated one.
    human: { email: adminFrom, name: branding.emailFromName || branding.brandName || 'Tirbeo' },
  };
  const category = ADMIN_TEMPLATES.has(templateName) ? 'admin'
    : SUPPORT_TEMPLATES.has(templateName) ? 'support'
    : CODE_TEMPLATES.has(templateName) ? 'code'
    : SECURITY_TEMPLATES.has(templateName) ? 'security'
    : ACCOUNT_TEMPLATES.has(templateName) ? 'account'
    : humanMailboxTemplates.includes(templateName) ? 'human'
    : NOTICE_TEMPLATES.has(templateName) ? 'notice'
    : 'casual';

  const config = await getEmailConfig();

  let defaultFromEmail = DOMAIN_FROM[category].email;
  let defaultFromName = DOMAIN_FROM[category].name;

  if (config && (category === 'security' || category === 'code')) {
    // Explicit DB overrides still win when set (per-type sender customization)
    const otpSet = ['signup_otp', 'login_otp', 'verify_email'];
    const resetSet = ['password_reset_otp', 'password_reset_otp_recovery', 'password_reset_link'];
    if (otpSet.includes(templateName) && config.otpFromEmail) {
      defaultFromEmail = config.otpFromEmail;
      defaultFromName = config.otpFromName || defaultFromName;
    } else if (resetSet.includes(templateName) && config.resetFromEmail) {
      defaultFromEmail = config.resetFromEmail;
      defaultFromName = config.resetFromName || defaultFromName;
    }
  }

  // RFC 8058 one-click unsubscribe. Gmail and Yahoo require it of bulk senders,
  // and it is what lets a reader stop mail without hunting for the link: only
  // mail that actually carries an unsubscribe URL gets the header, so the
  // essential/security templates stay header-free by construction.
  const unsubHeader = mergedVars['unsubscribeUrl'];
  const finalOptions = {
    fromEmail: options?.fromEmail || defaultFromEmail,
    fromName: options?.fromName || defaultFromName,
    // A support mail invites a reply, and the reply has to reach the mailbox a
    // person actually reads — not whatever noreply address sent it.
    replyTo: options?.replyTo
      || (category === 'support' ? (process.env.SUPPORT_EMAIL || adminFrom)
        : humanMailboxTemplates.includes(templateName) ? adminFrom
        : undefined),
    threadId: options?.threadId,
    categoryOverride: options?.categoryOverride,
    userId: options?.userId,
    // Stamps the caller's event reference (e.g. { eventId: '…' }) into the
    // email_jobs payload, so the admin send log can be filtered by the id of
    // whatever event caused this mail.
    ...(options?.metadata ? { metadata: options.metadata } : {}),
    ...(unsubHeader
      ? {
          headers: {
            'List-Unsubscribe': `<${unsubHeader}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }
      : {}),
  };

  // An admin-edited DB row wins; the code template is the default. A row only
  // exists once someone has authored that slug in the admin, so nothing is
  // overridden by accident — and deleting the row hands the template back to
  // the code, which keeps shipping fixes.
  //
  // Read failure falls through to the built-in template rather than dropping
  // the mail: a database hiccup must not cost somebody their sign-in code.
  let override: { subject: string; html: string } | null = null;
  try {
    override = await getEmailTemplate(templateName);
  } catch {
    override = null;
  }
  const chosen = override || getTemplate(templateName, branding.logoUrl) || null;
  if (chosen) {
    if (!override && !fallbackLoggedTemplates.has(templateName)) {
      fallbackLoggedTemplates.add(templateName);
      console.log(`[EMAIL] Using built-in template: '${templateName}'`);
    }
    const subject = renderTemplate(chosen.subject, mergedVars, rawKeys);
    const rendered = renderTemplate(chosen.html, mergedVars, rawKeys);
    const missing = findUnresolvedVars(subject + rendered, rawKeys);
    const htmlBody = fillUnresolvedVars(rendered, missing);
    if (missing.length) {
      /* Log loudly and still send: a support email with one blank line beats
         an email that never arrives, and the caller can fix the argument. */
      console.error(
        `[EMAIL] Template '${templateName}' sent with unresolved variables: ${missing.join(', ')}`,
      );
    }
    return sendEmail(to, subjectLine(fillUnresolvedVars(subject, missing)), htmlBody, { ...finalOptions, templateName });
  }

  return { success: false, error: `Template '${templateName}' not found` };
}
