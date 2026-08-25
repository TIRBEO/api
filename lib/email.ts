import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { prisma } from './db/prisma';
import { getBranding, getApiOrigin } from './branding';

interface EmailResult { success: boolean; error?: string; messageId?: string; }

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
    const row = await prisma.email_logs.create({
      data: {
        toEmail: input.toEmail,
        fromEmail: input.fromEmail,
        subject: input.subject,
        template: input.template,
        threadId: input.threadId,
        replyTo: input.replyTo,
        status: input.status || 'sent',
        error: input.error,
        metadata: (input.metadata || {}) as any,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e: any) {
    console.error('[EMAIL_LOG]', e?.message || e);
    return null;
  }
}

/** Update a previously created email_logs row after the provider responds. */
async function finalizeEmailLog(logId: string | null, result: EmailResult) {
  if (!logId) return;
  try {
    await prisma.email_logs.update({
      where: { id: logId },
      data: result.success
        ? { status: 'sent' as any, messageId: result.messageId || null, error: null }
        : { status: 'failed' as any, error: (result.error || 'Send failed').slice(0, 1000) },
    });
  } catch (e: any) {
    console.error('[EMAIL_LOG] finalize failed:', e?.message);
  }
}

/** Stable thread id so replies and follow-ups group in mail clients. */
function deriveThreadId(to: string, subject: string, explicit?: string): string {
  if (explicit) return explicit.slice(0, 255);
  return crypto.createHash('sha1').update(`${to.toLowerCase()}|${subject}`).digest('hex').slice(0, 24);
}

const TRACKED_TEMPLATES_WITHOUT_PIXEL = new Set(['signup_otp', 'login_otp', 'password_reset_otp']);

/** Append the open-tracking pixel. Links are kept as direct URLs. */
function injectTracking(htmlBody: string, logId: string, templateName?: string): string {
  const base = getApiOrigin();
  let html = htmlBody;

  // Open tracking pixel (skip OTP-style emails where images are usually blocked)
  if (!templateName || !TRACKED_TEMPLATES_WITHOUT_PIXEL.has(templateName)) {
    const pixel = `<img src="${base}/api/e/o/${logId}" width="1" height="1" alt="" style="display:none;border:0;" />`;
    html = html.includes('</body>') ? html.replace('</body>', `${pixel}</body>`) : html + pixel;
  }
  return html;
}

export async function getEmailConfig() {
  try {
    const config = await prisma.emailConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!config) {
      return {
        provider: 'resend',
        enabled: true,
        resendDomain: 'send.tirbeo.app',
        defaultFromEmail: 'noreply@send.tirbeo.app',
        defaultFromName: 'Tirbeo',
        alertFromEmail: 'alerts@send.tirbeo.app',
        alertFromName: 'Tirbeo',
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
    }
    return config;
  } catch (e: any) {
    console.warn('[EMAIL] Failed to load config from DB:', e?.message);
    return null;
  }
}

export async function getEmailTemplate(name: string) {
  return prisma.emailTemplate.findUnique({ where: { name } });
}

// Vendored locally (packages/ui/src/emails/index.ts) so new templates (e.g. form_flagged)
// ship without an @tirbeo/ui npm publish. Keep in sync with packages/ui/src/emails/index.ts.
import { buildTemplates } from './email-templates';

const fallbackLoggedTemplates = new Set<string>();

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

export function renderTemplate(html: string, vars: Record<string, string>, rawKeys: Set<string> = new Set()): string {
  let result = html;
  for (const [key, val] of Object.entries(vars)) {
    const replacement = rawKeys.has(key) ? val : escapeHtml(val);
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), replacement);
  }
  return result;
}

export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  options?: { fromEmail?: string; fromName?: string; replyTo?: string; threadId?: string; templateName?: string; metadata?: Record<string, unknown> }
): Promise<EmailResult> {
  // ─── Email suppression check (lowest level) ───
  // If the user disabled email or unsubscribed from this category, block non-essential sends.
  if (options?.templateName) {
    try {
      const { shouldSuppressEmail } = await import('./emailPrefs');
      if (await shouldSuppressEmail(to, options.templateName)) {
        console.log(`[EMAIL] Suppressed '${options.templateName}' to ${to} (user prefs)`);
        return { success: true };
      }
    } catch { /* best-effort */ }
  } else {
    // Safety net: even without templateName, check if user globally disabled email
    try {
      const { prisma: p } = await import('./db/prisma');
      const u = await p.user.findUnique({ where: { email: to }, select: { notificationPreferences: true } });
      const prefs: any = (u as any)?.notificationPreferences;
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

  const fromEmail = options?.fromEmail || config?.fromEmail || 'noreply@send.tirbeo.app';
  const fromName = options?.fromName || config?.fromName || 'Tirbeo';
  const threadId = deriveThreadId(to, subject, options?.threadId);

  // Create the log row up front so tracking URLs can reference it.
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

  if (logId) {
    htmlBody = injectTracking(htmlBody, logId, options?.templateName);
  }

  let result: EmailResult = { success: false };
  if (provider === 'resend' || (!config && apiKey)) {
    result = await sendViaResend(apiKey, to, fromEmail, fromName, subject, htmlBody, options?.replyTo);
  } else if (provider === 'smtp') {
    result = await sendViaSmtp(config, to, fromEmail, fromName, subject, htmlBody, options?.replyTo);
  } else {
    result = { success: false, error: `Unknown email provider: ${provider}` };
    console.error(`[EMAIL] Unknown provider "${provider}". Cannot send to ${to}`);
  }

  await finalizeEmailLog(logId, result);

  return result;
}

async function sendViaResend(apiKey: string, to: string, fromEmail: string, fromName: string, subject: string, html: string, replyTo?: string): Promise<EmailResult> {
  try {
    const body: Record<string, any> = {
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: [to],
      subject,
      html,
      tracking: { click: { enable: false }, open: { enable: true } },
    };
    if (replyTo) body.replyTo = replyTo;
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
      return { success: false, error: `Resend error ${res.status}: ${err}` };
    }
    const data: any = await res.json();
    return { success: true, messageId: data.id };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

async function sendViaSmtp(
  config: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string },
  to: string, fromEmail: string, fromName: string, subject: string, html: string, replyTo?: string
): Promise<EmailResult> {
  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
    const info = await transporter.sendMail({
      from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
      to,
      subject,
      html,
      replyTo: replyTo || fromEmail,
    });
    return { success: true, messageId: info.messageId };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

// ─── Fallback templates using @tirbeo/ui ───

export async function getLogoUrl(): Promise<string> {
  return (await getBranding()).logoUrl;
}

async function buildFallbackTemplates(): Promise<Record<string, { subject: string; html: string }>> {
  return buildTemplates(await getLogoUrl());
}


export async function sendTemplateEmail(
  to: string,
  templateName: string,
  variables: Record<string, string>,
  options?: { fromEmail?: string; fromName?: string; rawVars?: string[]; replyTo?: string; threadId?: string }
): Promise<EmailResult> {
  // ─── Email suppression check ───
  // Non-essential emails respect the user's notification preferences.
  // Essential emails (OTPs, password resets, etc.) always go through.
  try {
    const { shouldSuppressEmail } = await import('./emailPrefs');
    if (await shouldSuppressEmail(to, templateName)) {
      console.log(`[EMAIL] Suppressed '${templateName}' to ${to} (user prefs)`);
      return { success: true }; // pretend success — don't throw
    }
  } catch { /* suppression check is best-effort */ }

  const rawKeys = new Set([...(options?.rawVars || []), 'unsubscribeSection']);
  const branding = await getBranding();
  const logoUrl = branding.logoUrl;
  const mergedVars = { ...variables, logoUrl, brandName: branding.brandName, brandTagline: branding.brandTagline };

  // ─── Unsubscribe URLs ───
  // Essential/security emails NEVER get unsubscribe links — they are compulsory.
  // Other emails get a single unsubscribe page link.
  try {
    const { TEMPLATE_CATEGORY, ESSENTIAL_TEMPLATES } = await import('./emailPrefs');
    const isEssential = (ESSENTIAL_TEMPLATES as Set<string>).has(templateName);
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app';
    if (!isEssential) {
      mergedVars['unsubscribeUrl'] = `${apiBase}/api/emails/unsubscribe`;
      mergedVars['managePreferencesUrl'] = `${apiBase}/api/emails/unsubscribe`;
      mergedVars['unsubscribeSection'] = `<p style="margin:8px 0 0;font-size:11px;color:#6b7280"><a href="${apiBase}/api/emails/unsubscribe" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></p>`;
    } else {
      mergedVars['unsubscribeUrl'] = '';
      mergedVars['unsubscribeSection'] = '';
      mergedVars['managePreferencesUrl'] = '';
    }
  } catch {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'https://api.tirbeo.app';
    mergedVars['unsubscribeUrl'] = `${apiBase}/api/emails/unsubscribe`;
    mergedVars['unsubscribeSection'] = `<p style="margin:8px 0 0;font-size:11px;color:#6b7280"><a href="${apiBase}/api/emails/unsubscribe" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a></p>`;
    mergedVars['managePreferencesUrl'] = '';
  }

  // Set default from addresses based on email type
  const alertTemplates = ['notification_digest', 'admin_alert', 'system_alert', 'product_update', 'weekly_summary', 'account_tip', 'account_suspended', 'account_deleted'];
  const config = await getEmailConfig();
  
  let defaultFromEmail = branding.emailFromAddress || 'noreply@send.tirbeo.app';
  let defaultFromName = branding.emailFromName || branding.brandName || 'Tirbeo';
  
  if (config) {
    if (alertTemplates.includes(templateName)) {
      defaultFromEmail = config.alertFromEmail || config.defaultFromEmail || 'alerts@send.tirbeo.app';
      defaultFromName = config.alertFromName || config.defaultFromName || 'Tirbeo Alerts';
    } else {
      // Check for per-type overrides
      switch (templateName) {
        case 'welcome':
          defaultFromEmail = config.welcomeFromEmail || config.defaultFromEmail || branding.emailFromAddress;
          defaultFromName = config.welcomeFromName || config.defaultFromName || branding.emailFromName;
          break;
        case 'signup_otp':
        case 'login_otp':
        case 'verify_email':
          defaultFromEmail = config.otpFromEmail || config.defaultFromEmail || branding.emailFromAddress;
          defaultFromName = config.otpFromName || config.defaultFromName || branding.emailFromName;
          break;
        case 'password_reset':
        case 'password_reset_otp':
        case 'password_reset_link':
          defaultFromEmail = config.resetFromEmail || config.defaultFromEmail || branding.emailFromAddress;
          defaultFromName = config.resetFromName || config.defaultFromName || branding.emailFromName;
          break;
        case 'form_submission_confirmation':
        case 'form_notification':
        case 'form_response':
          defaultFromEmail = config.formsFromEmail || 'forms@send.tirbeo.app';
          defaultFromName = config.formsFromName || 'Tirbeo Forms';
          break;
        case 'notification_digest':
        case 'product_update':
        case 'weekly_summary':
        case 'account_tip':
        case 'account_suspended':
        case 'account_deleted':
          defaultFromEmail = config.notifyFromEmail || config.alertFromEmail || config.defaultFromEmail;
          defaultFromName = config.notifyFromName || config.alertFromName || config.defaultFromName;
          break;
        default:
          defaultFromEmail = config.defaultFromEmail || branding.emailFromAddress;
          defaultFromName = config.defaultFromName || branding.emailFromName;
      }
    }
  }

  const finalOptions = {
    fromEmail: options?.fromEmail || defaultFromEmail,
    fromName: options?.fromName || defaultFromName,
    replyTo: options?.replyTo,
    threadId: options?.threadId,
  };

  // Always prefer built-in templates (clean light design) over DB templates
  const fallbacks = await buildFallbackTemplates();
  const fallback = fallbacks[templateName];
  if (fallback) {
    if (!fallbackLoggedTemplates.has(templateName)) {
      fallbackLoggedTemplates.add(templateName);
      console.warn(`[EMAIL] Using built-in template: '${templateName}'`);
    }
    const subject = renderTemplate(fallback.subject, mergedVars, rawKeys);
    const htmlBody = renderTemplate(fallback.html, mergedVars, rawKeys);
    return sendEmail(to, subject, htmlBody, { ...finalOptions, templateName });
  }

  // Fall back to DB-stored templates only if no built-in exists
  const template = await getEmailTemplate(templateName);
  if (template) {
    const subject = renderTemplate(template.subject, mergedVars, rawKeys);
    const htmlBody = renderTemplate(template.htmlBody, mergedVars, rawKeys);
    return sendEmail(to, subject, htmlBody, {
      fromEmail: finalOptions.fromEmail,
      fromName: finalOptions.fromName,
      replyTo: finalOptions.replyTo,
      threadId: finalOptions.threadId,
      templateName,
    });
  }

  return { success: false, error: `Template '${templateName}' not found` };
}

export async function getFallbackTemplates(): Promise<Record<string, { subject: string; html: string }>> {
  return buildFallbackTemplates();
}
