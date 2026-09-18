/**
 * Email Brain — Tirbeo Email Renderer.
 *
 * AI produces structured blocks; ONLY this renderer produces the actual email.
 * Everything is escaped except button URLs, which must come from the trusted
 * variable set (resolved server-side, never AI-invented).
 */
import { escapeHtml } from '@/features/email/email';
import type { EmailBlock, EmailContent } from '@/features/email-brain/ai';

const BRAND = {
  bg: '#E8E5FA',
  surface: '#FFFBFF',
  ink: '#25232A',
  secondary: '#49454F',
  muted: '#79747E',
  brand: '#6750A4',
  brandInk: '#4F378B',
  brandSoft: '#F3EDF7',
};

/** Substitute {{var}} placeholders from a trusted, resolved variable set. */
function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const val = vars[key];
    return val === undefined ? whole : val;
  });
}

/** Interpolate, then escape — user-sourced values can never inject markup. */
function esc(text: string, vars: Record<string, string>): string {
  return escapeHtml(substitute(text, vars));
}

/** Button/alert URLs: interpolated from trusted vars and scheme-validated. */
function safeUrl(url: string, vars: Record<string, string>): string | null {
  const resolved = substitute(url, vars);
  try {
    const u = new URL(resolved);
    return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? resolved : null;
  } catch {
    return null;
  }
}

export function renderBlocksHtml(content: EmailContent, vars: Record<string, string>): string {
  const parts: string[] = [];
  for (const block of content.blocks) {
    switch (block.type) {
      case 'heading':
        parts.push(`<h2 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${BRAND.ink}">${esc(block.text, vars)}</h2>`);
        break;
      case 'paragraph':
        parts.push(`<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BRAND.secondary}">${esc(block.text, vars)}</p>`);
        break;
      case 'button': {
        const url = safeUrl(block.url, vars);
        if (!url) continue; // never render an invalid/untrusted link
        parts.push(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td style="border-radius:999px;background:${BRAND.brand}">` +
          `<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 28px;font-family:inherit;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px">${esc(block.label, vars)}</a>` +
          `</td></tr></table>`
        );
        break;
      }
      case 'alert': {
        const tones: Record<string, { bg: string; fg: string }> = {
          info: { bg: '#E3EDFB', fg: '#2C4A80' },
          warning: { bg: '#FBF0DC', fg: '#6B4A05' },
          error: { bg: '#FBDFE3', fg: '#7A1D33' },
          success: { bg: '#DFF2E7', fg: '#1E4F36' },
        };
        const t = tones[block.tone] || tones.info;
        parts.push(`<div style="margin:0 0 16px;padding:12px 16px;border-radius:14px;background:${t.bg};color:${t.fg};font-size:14px;line-height:1.5;font-weight:500">${esc(block.text, vars)}</div>`);
        break;
      }
      case 'divider':
        parts.push(`<div style="margin:20px 0;border-top:1px solid ${BRAND.brandSoft}"></div>`);
        break;
      case 'list':
        parts.push(
          `<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:${BRAND.secondary}">` +
          block.items.map((i) => `<li style="margin-bottom:6px">${esc(i, vars)}</li>`).join('') +
          `</ul>`
        );
        break;
    }
  }
  return parts.join('');
}

export function renderBlocksText(content: EmailContent, vars: Record<string, string>): string {
  const lines: string[] = [];
  for (const block of content.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(substitute(block.text, vars).toUpperCase(), '');
        break;
      case 'paragraph':
        lines.push(substitute(block.text, vars), '');
        break;
      case 'button': {
        const url = safeUrl(block.url, vars);
        if (url) lines.push(`${substitute(block.label, vars)}: ${url}`, '');
        break;
      }
      case 'alert':
        lines.push(`[${block.tone.toUpperCase()}] ${substitute(block.text, vars)}`, '');
        break;
      case 'divider':
        lines.push('---', '');
        break;
      case 'list':
        for (const item of block.items) lines.push(`  • ${substitute(item, vars)}`);
        lines.push('');
        break;
    }
  }
  return lines.join('\n').trim();
}

/** Full email document (header + blocks + footer). Returns { html, text }. */
export function renderEmail(
  content: EmailContent,
  vars: Record<string, string>,
  opts?: { footerNote?: string; managePreferencesUrl?: string },
): { html: string; text: string } {
  const preheader = content.blocks.find((b) => b.type === 'paragraph');
  const preheaderText = preheader && preheader.type === 'paragraph'
    ? substitute(preheader.text, vars).slice(0, 100)
    : '';

  const bodyHtml = renderBlocksHtml(content, vars);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(substitute(content.subject, vars))}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheaderText)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${BRAND.surface};border-radius:24px;overflow:hidden">
<tr><td style="padding:36px 40px 8px;font-family:Arial,Helvetica,sans-serif">
  <span style="font-size:18px;font-weight:700;color:${BRAND.brandInk};letter-spacing:-0.01em">Tirbeo</span>
</td></tr>
<tr><td style="padding:12px 40px 40px;font-family:Arial,Helvetica,sans-serif">
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 40px 32px;font-family:Arial,Helvetica,sans-serif;border-top:1px solid ${BRAND.brandSoft}">
  <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted}">
    Sent by Tirbeo${opts?.footerNote ? ` · ${escapeHtml(opts.footerNote)}` : ''}.
    <a href="{{managePreferencesUrl}}" style="color:${BRAND.muted}">Email preferences</a>
  </p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  // Footer link is interpolated last from a server-provided URL only.
  const prefsUrl = opts?.managePreferencesUrl;
  const finalHtml = prefsUrl
    ? html.replace(/\{\{\s*managePreferencesUrl\s*\}\}/g, escapeHtml(prefsUrl))
    : html.replace(/\s*<a href="\{\{managePreferencesUrl\}\}"[^>]*>Email preferences<\/a>/, '');

  const textLines = [
    substitute(content.subject, vars).toUpperCase(),
    '',
    renderBlocksText(content, vars),
    '—',
    `Sent by Tirbeo${opts?.footerNote ? ` · ${opts.footerNote}` : ''}`,
  ];
  return { html: finalHtml, text: textLines.join('\n').trim() };
}
