import nodemailer from 'nodemailer';
import { prisma } from './db/prisma';
import { getBranding } from './branding';

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
}) {
  try {
    await prisma.email_logs.create({
      data: {
        toEmail: input.toEmail,
        fromEmail: input.fromEmail,
        subject: input.subject,
        template: input.template,
        threadId: input.threadId,
        replyTo: input.replyTo,
        status: input.status || 'sent',
        error: input.error,
      },
    });
  } catch (e: any) {
    console.error('[EMAIL_LOG]', e?.message || e);
  }
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
        alertFromName: 'Tirbeo Alerts',
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

import { buildTemplates } from '@tirbeo/ui/emails';

export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}

export function renderTemplate(html: string, vars: Record<string, string>): string {
  let result = html;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), escapeHtml(val));
  }
  return result;
}

async function getThemeColors(): Promise<Record<string, string>> {
  try {
    const theme = await prisma.themeConfig.findFirst({ where: { isActive: true } });
    if (!theme) return {};
    return {
      ACCENT_PRIMARY: theme.accentPrimary,
      ACCENT_SECONDARY: theme.accentSecondary,
      BG_PRIMARY: theme.bgPrimary,
      BG_CARD: theme.bgCard,
      TEXT_PRIMARY: theme.textPrimary,
      TEXT_SECONDARY: theme.textSecondary,
      EMAIL_HEADER_BG: theme.emailHeaderBg,
      EMAIL_BUTTON_COLOR: theme.emailButtonColor,
      EMAIL_TEXT_COLOR: theme.emailTextColor,
      SUCCESS: theme.success,
      BORDER_COLOR: theme.borderColor,
    };
  } catch {
    return {};
  }
}

export async function sendEmail(
  to: string,
  subject: string,
  htmlBody: string,
  options?: { fromEmail?: string; fromName?: string; replyTo?: string; threadId?: string; templateName?: string }
): Promise<EmailResult> {
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

  let result: EmailResult = { success: false };
  if (provider === 'resend' || (!config && apiKey)) {
    result = await sendViaResend(apiKey, to, fromEmail, fromName, subject, htmlBody, options?.replyTo);
  } else if (provider === 'smtp') {
    result = await sendViaSmtp(config, to, fromEmail, fromName, subject, htmlBody, options?.replyTo);
  } else {
    console.error(`[EMAIL] Unknown provider "${provider}". Cannot send to ${to}`);
    return { success: false, error: `Unknown email provider: ${provider}` };
  }

  // Log email to database (non-blocking)
  if (result.success) {
    logEmail({
      toEmail: to,
      fromEmail,
      subject,
      template: options?.templateName || undefined,
      threadId: options?.threadId,
      replyTo: options?.replyTo,
      status: 'sent',
      messageId: result.messageId,
    }).catch(() => {});
  }

  return result;
}

async function sendViaResend(apiKey: string, to: string, fromEmail: string, fromName: string, subject: string, html: string, replyTo?: string): Promise<EmailResult> {
  try {
    const body: Record<string, any> = {
      from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
      to: [to],
      subject,
      html,
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
    const data = await res.json();
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


function applyThemeColors(html: string, colors: Record<string, string>): string {
  const colorMap: Record<string, string> = {};
  if (colors.BG_PRIMARY) colorMap['#08150F'] = colors.BG_PRIMARY;
  if (colors.BG_CARD) colorMap['#12271D'] = colors.BG_CARD;
  if (colors.BG_PRIMARY) colorMap['#101C13'] = colors.BG_PRIMARY;
  if (colors.ACCENT_SECONDARY) colorMap['#4285F4'] = colors.ACCENT_SECONDARY;
  if (colors.ACCENT_PRIMARY) colorMap['#8AB4F8'] = colors.ACCENT_PRIMARY;
  if (colors.TEXT_SECONDARY) colorMap['#B7C6BE'] = colors.TEXT_SECONDARY;
  if (colors.ACCENT_SECONDARY) colorMap['#214434'] = colors.ACCENT_SECONDARY;
  if (colors.ACCENT_SECONDARY) colorMap['#173124'] = colors.ACCENT_SECONDARY;
  let result = html;
  for (const [from, to] of Object.entries(colorMap)) {
    result = result.split(from).join(to);
  }
  return result;
}

export async function sendTemplateEmail(
  to: string,
  templateName: string,
  variables: Record<string, string>,
  options?: { fromEmail?: string; fromName?: string }
): Promise<EmailResult> {
  const themeColors = await getThemeColors();
  const branding = await getBranding();
  const logoUrl = branding.logoUrl;
  const mergedVars = { ...themeColors, ...variables, logoUrl, brandName: branding.brandName, brandTagline: branding.brandTagline };

  // Set default from addresses based on email type
  const alertTemplates = ['notification_digest', 'admin_alert', 'system_alert'];
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
  };

  const template = await getEmailTemplate(templateName);
  if (template) {
    const subject = renderTemplate(template.subject, mergedVars);
    const htmlBody = renderTemplate(template.htmlBody, mergedVars);
    return sendEmail(to, subject, htmlBody, {
      fromEmail: finalOptions.fromEmail,
      fromName: finalOptions.fromName,
      templateName,
    });
  }

  const fallbacks = await buildFallbackTemplates();
  const fallback = fallbacks[templateName];
  if (fallback) {
    console.log(`[EMAIL] Template '${templateName}' not in DB, using built-in fallback`);
    let subject = renderTemplate(fallback.subject, mergedVars);
    let htmlBody = renderTemplate(fallback.html, mergedVars);
    if (Object.keys(themeColors).length > 0) {
      htmlBody = applyThemeColors(htmlBody, themeColors);
      subject = applyThemeColors(subject, themeColors);
    }
    return sendEmail(to, subject, htmlBody, { ...finalOptions, templateName });
  }

  return { success: false, error: `Template '${templateName}' not found` };
}

export async function getFallbackTemplates(): Promise<Record<string, { subject: string; html: string }>> {
  return buildFallbackTemplates();
}
