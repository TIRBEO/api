export type EmailTemplate = { subject: string; html: string };

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

// ═══ PURE DARK BLACK PALETTE ═══
const BG = '#000000';
const TEXT = '#ffffff';
const TEXT2 = '#999999';
const MUTED = '#444444';
const BORDER = '#111111';
const BLUE = '#3b82f6';
const GREEN = '#16a34a';
const RED = '#dc2626';

const DEFAULT_IMAGE_BASE = 'https://api.tirbeo.app';

// ═══ SVG ICON HELPERS ═══
const ICONS = {
  mail: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  key: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  lock: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  shield: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>`,
  check: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  alertTriangle: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  trash: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
  fileText: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
  download: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
  clock: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  bell: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  settings: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  zap: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
  users: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/></svg>`,
  xCircle: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`,
  globe: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
  barChart: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/></svg>`,
  star: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  externalLink: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
  calendar: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>`,
  edit: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>`,
  eye: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
};

// ═══ SHARED HELPERS — CLEAN, NO CONTAINER, NO BRAND LABEL ═══

function head(title: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title></head><body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};-webkit-font-smoothing:antialiased;">`;
}

function wrapStart(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 20px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">`;
}

function wrapEnd(): string {
  return `</table></td></tr></table></body></html>`;
}

function logoBlock(logo: string): string {
  const logoSvg = `<svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="36" height="36" rx="10" fill="#ffffff"/><text x="18" y="25" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="20" font-weight="700" fill="#000000">T</text></svg>`;
  if (logo) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 0 32px;"><img src="${logo}" width="120" height="36" alt="" style="display:block;border:0;outline:none;text-decoration:none;" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-block';"><span style="display:none;">${logoSvg}</span></td></tr></table>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 0 32px;">${logoSvg}</td></tr></table>`;
}

function heroIcon(iconSvg: string, title: string, subtitle: string): string {
  return `<div style="text-align:center;margin-bottom:28px;"><div style="width:52px;height:52px;border-radius:14px;background:${BORDER};display:inline-flex;align-items:center;justify-content:center;margin-bottom:16px;">${iconSvg}</div><h1 style="margin:0;font-size:22px;font-weight:700;color:${TEXT};letter-spacing:-0.02em;">${title}</h1><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};line-height:22px;">${subtitle}</p></div>`;
}

function otpBlock(code: string): string {
  return `<div style="text-align:center;margin:24px 0;"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="font-size:32px;font-weight:700;letter-spacing:8px;color:${TEXT};font-family:monospace;background:${BORDER};border-radius:10px;padding:20px 28px;">${code}</td></tr></table></div>`;
}

function btn(url: string, label: string): string {
  return `<div style="text-align:center;margin:24px 0;"><a href="${url}" style="display:inline-block;padding:12px 28px;background:${TEXT};color:${BG};font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">${label}</a></div>`;
}

function infoBox(content: string): string {
  return `<div style="background:${BORDER};border-radius:8px;padding:16px;margin:20px 0;">${content}</div>`;
}

function divider(): string {
  return `<div style="height:1px;background:${BORDER};margin:24px 0;"></div>`;
}

function footer(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 0;text-align:center;"><p style="margin:0;font-size:12px;color:${MUTED};">&copy; 2026 Tirbeo. All rights reserved.</p><p style="margin:8px 0 0;font-size:12px;color:${MUTED};"><a href="https://tirbeo.app/privacy" style="color:${TEXT2};text-decoration:none;">Privacy</a> &middot; <a href="https://tirbeo.app/terms" style="color:${TEXT2};text-decoration:none;">Terms</a></p>{{unsubscribeSection}}</td></tr></table>`;
}

// ═══ TEMPLATES — CLEAN, NO CARD CONTAINER ═══

export const EMAIL_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {

  signup_otp: (logo) => tpl(
    'Your Tirbeo verification code is {{otp}}',
    `${head('Verify Your Email')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.mail, 'Verify your email', 'Complete your account setup.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Use the code below to verify your email address. This code expires in <strong style="color:${TEXT};">10 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not create an account, you can safely ignore this email.</p>`}${footer()}${wrapEnd()}`
  ),

  login_otp: (logo) => tpl(
    'Your Tirbeo login code is {{otp}}',
    `${head('Your Login Code')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.key, 'Your login code', 'Use this code to sign in.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Here is your login verification code. It expires in <strong style="color:${TEXT};">10 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this login, you can safely ignore this email.</p>`}${footer()}${wrapEnd()}`
  ),

  verify_email: (logo) => tpl(
    'Verify your Tirbeo email',
    `${head('Verify Your Email')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.mail, 'Verify your email', 'Confirm your email address.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Your verification code:</p>`}${otpBlock('{{otp}}')}${`<p style="margin:16px 0 0;font-size:14px;color:${MUTED};">This code expires in 10 minutes.</p>`}${footer()}${wrapEnd()}`
  ),

  magic_link: (logo) => tpl(
    'Sign in to Tirbeo',
    `${head('Sign in to Tirbeo')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.externalLink, 'Sign in to Tirbeo', 'One click and you are in.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hi {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Click the button below to sign in. This link expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${btn('{{magicLink}}', 'Sign In')}${`<p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">Link: {{magicLink}}</p>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore it.</p>`}${footer()}${wrapEnd()}`
  ),

  password_reset_otp: (logo) => tpl(
    'Your Tirbeo password reset code is {{otp}}',
    `${head('Reset Your Password')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.lock, 'Reset your password', 'Use the code below to set a new password.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We received a password reset request. Use the code below. It expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore this email.</p>`}${footer()}${wrapEnd()}`
  ),

  delete_account_otp: (logo) => tpl(
    'Your Tirbeo account deletion code is {{otp}}',
    `${head('Delete Account')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.trash, 'Confirm Account Deletion', 'This will permanently delete your account.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">You requested to delete your Tirbeo account. This action is <strong style="color:${TEXT};">permanent and irreversible</strong>. All your data will be deleted after 30 days.</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Use the code below to confirm. It expires in <strong style="color:${TEXT};">10 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, change your password immediately and contact support.</p>`}${footer()}${wrapEnd()}`
  ),

  password_reset_link: (logo) => tpl(
    'Reset your Tirbeo password',
    `${head('Reset Your Password')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.lock, 'Reset your password', 'Click below to set a new password.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Click the button to reset your password. This link expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${btn('{{resetUrl}}', 'Reset Password')}${`<p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">Link: {{resetUrl}}</p>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore this email.</p>`}${footer()}${wrapEnd()}`
  ),

  password_changed: (logo) => tpl(
    'Your Tirbeo password was changed',
    `${head('Password Changed')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.check, 'Password changed', 'Your password was updated successfully.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your password was changed successfully.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{changedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">IP:</strong> {{ipAddress}}</p>`)}${`<p style="margin:16px 0 0;font-size:14px;line-height:22px;color:${MUTED};">If you did not make this change, please reset your password immediately.</p>`}${footer()}${wrapEnd()}`
  ),

  suspicious_login: (logo) => tpl(
    'Suspicious login detected on your Tirbeo account',
    `${head('Security Alert')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.shield, 'Suspicious login detected', 'We noticed a sign-in from an unusual location.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We noticed a sign-in from an unusual location or device.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{loginTime}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">IP:</strong> {{ipAddress}}</p>`)}${btn('{{revokeUrl}}', 'Review Sessions')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If this was not you, please secure your account immediately.</p>`}${footer()}${wrapEnd()}`
  ),

  login_alert: (logo) => tpl(
    'New sign-in to your Tirbeo account',
    `${head('New Sign-in')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.globe, 'New sign-in detected', 'A new sign-in was detected on your account.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A new sign-in was detected. If this was you, you can ignore this email.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{loginTime}}</p>`)}${btn('{{revokeUrl}}', 'Review Sessions')}${footer()}${wrapEnd()}`
  ),

  account_recovery: (logo) => tpl(
    'Reset your Tirbeo account',
    `${head('Account Recovery')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.key, 'Account recovery', 'Click below to set a new password.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We received a request to recover your account. Click below. This link expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${btn('{{recoveryUrl}}', 'Recover Account')}${`<p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">Link: {{recoveryUrl}}</p>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore this email.</p>`}${footer()}${wrapEnd()}`
  ),

  welcome: (logo) => tpl(
    'Welcome to Tirbeo, {{name}}!',
    `${head('Welcome to Tirbeo')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.star, 'Welcome to Tirbeo!', 'Your account is ready. Let\'s build something great.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hi {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Thanks for joining <strong style="color:${TEXT};">Tirbeo</strong>. Your account has been created and you are ready to start.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};">Here is what you can do next:</p><ul style="margin:12px 0 0;padding-left:20px;font-size:14px;color:${TEXT2};line-height:28px;"><li>Complete your profile</li><li>Explore your dashboard</li><li>Connect your first app</li></ul>`)}${btn('{{dashboardUrl}}', 'Go to Dashboard')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Questions? Visit our <a href="https://tirbeo.app/help" style="color:${TEXT2};text-decoration:none;">Help Center</a>.</p>`}${footer()}${wrapEnd()}`
  ),

  notification_digest: (logo) => tpl(
    'Your Tirbeo digest — {{count}} new updates',
    `${head('Your Tirbeo Digest')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.bell, 'Your Digest', 'You have {{count}} new updates.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Here is what is new since your last visit:</p>`}${`<div style="margin:20px 0;">{{digestItems}}</div>`}${btn('{{dashboardUrl}}', 'View All Updates')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Manage your <a href="{{dashboardUrl}}/account/notifications" style="color:${TEXT2};text-decoration:none;">email preferences</a>.</p>`}${footer()}${wrapEnd()}`
  ),

  product_update: (logo) => tpl(
    '{{title}}',
    `${head('Product Update')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.zap, 'Product Update', '{{title}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{message}}</p>`}${btn('{{ctaUrl}}', '{{ctaLabel}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">You are receiving product emails. Manage your <a href="{{dashboardUrl}}/account/notifications" style="color:${TEXT2};text-decoration:none;">email preferences</a>.</p>`}${footer()}${wrapEnd()}`
  ),

  weekly_summary: (logo) => tpl(
    'Your Tirbeo week — {{periodLabel}}',
    `${head('Weekly Summary')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.barChart, 'Your Week on Tirbeo', '{{periodLabel}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Here is a summary of your account activity for the past week.</p>`}${`<div style="margin:20px 0;padding:18px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid ${BORDER};"><p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};">Activity overview</p>{{statRows}}</div>`}${'{{suspiciousSection}}'}${btn('{{dashboardUrl}}/activity/history', 'View Full Activity History')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Manage your <a href="{{dashboardUrl}}/account/notifications" style="color:${TEXT2};text-decoration:none;">email preferences</a>.</p>`}${footer()}${wrapEnd()}`
  ),

  account_tip: (logo) => tpl(
    'Tip: {{tipTitle}}',
    `${head('Tips & Updates')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.zap, 'Pro Tip', '{{tipTitle}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{tipBody}}</p>`}${btn('{{actionUrl}}', '{{actionLabel}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">These tips are generated automatically based on your account. Turn them off in your <a href="{{dashboardUrl}}/account/notifications" style="color:${TEXT2};text-decoration:none;">email preferences</a>.</p>`}${footer()}${wrapEnd()}`
  ),

  account_suspended: (logo) => tpl(
    'Your Tirbeo account has been {{statusType}}',
    `${head('Account Status')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.alertTriangle, 'Account Status Update', 'Your account has been {{statusType}}.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};"><strong>Reason:</strong> {{reason}}</p><p style="margin:0 0 16px;font-size:15px;line-height:26px;color:${TEXT2};">{{untilLabel}} {{actionLabel}}</p>`}${btn('{{dashboardUrl}}/account', 'Go to Your Account')}${footer()}${wrapEnd()}`
  ),

  account_deleted: (logo) => tpl(
    'Your Tirbeo account is scheduled for deletion',
    `${head('Deletion Scheduled')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.trash, 'Deletion Scheduled', 'Your account will be deleted on {{dateLabel}}.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">You requested deletion of your Tirbeo account. After this date, all your data will be permanently removed.</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Changed your mind? Sign in before <strong>{{dateLabel}}</strong> and cancel the deletion from your dashboard.</p>`}${btn('{{dashboardUrl}}/account/security', 'Cancel Deletion')}${footer()}${wrapEnd()}`
  ),

  admin_alert: (logo) => tpl(
    '[Admin] {{subject}}',
    `${head('Admin Alert')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.shield, 'Admin Alert', '{{subject}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello Admin,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{message}}</p>`}${infoBox('{{details}}')}${btn('{{dashboardUrl}}', 'View Admin Dashboard')}${divider()}${`<p style="margin:0;font-size:13px;line-height:22px;color:${MUTED};">Automated alert from Tirbeo Admin.</p>`}${footer()}${wrapEnd()}`
  ),

  system_alert: (logo) => tpl(
    '[System] {{subject}}',
    `${head('System Alert')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.settings, 'System Alert', '{{message}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{message}}</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Service:</strong> {{service}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{alertTime}}</p>`)}${footer()}${wrapEnd()}`
  ),

  admin_crash_report: (logo) => tpl(
    '[Crash] {{severity}}: {{type}}',
    `${head('Crash Report')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.alertTriangle, '{{severity}} Crash', '{{type}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">A user crash has been reported and requires attention.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Severity:</strong> <span style="color:${RED}">{{severity}}</span></p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Type:</strong> {{type}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Message:</strong> {{message}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">User:</strong> {{userEmail}} ({{username}})</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Page:</strong> {{url}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Source:</strong> {{source}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">User Agent:</strong> {{userAgent}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{timestamp}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Event ID:</strong> {{eventId}}</p>`)}${infoBox(`<p style="margin:0;font-size:13px;color:${MUTED};font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto">{{stack}}</p>`)}${btn('{{dashboardUrl}}', 'View Crash Details')}${footer()}${wrapEnd()}`
  ),

  export_ready: (logo) => tpl(
    'Your data has been exported',
    `${head('Data Exported')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.download, 'Data Exported', 'Your Tirbeo data has been downloaded.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">This is a confirmation that your data export was successfully downloaded. If this wasn't you, please secure your account immediately.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Exported:</strong> {{exportedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Format:</strong> JSON</p>`)}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this export, change your password immediately.</p>`}${footer()}${wrapEnd()}`
  ),

  form_submission_confirmation: (logo) => tpl(
    'Your response to {{formTitle}} was recorded',
    `${head('Response Recorded')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.check, 'Response recorded', 'Thank you for submitting the form.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{respondentName}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Thank you for submitting <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${btn('{{formUrl}}', 'View Form')}${footer()}${wrapEnd()}`
  ),

  form_response: (logo) => tpl(
    'New response to "{{formTitle}}"',
    `${head('New Form Response')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.fileText, 'New Form Response', 'A new response was submitted.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">A new response was submitted to <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Respondent:</strong> {{respondentName}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Submitted:</strong> {{submittedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Response ID:</strong> {{responseId}}</p>`)}${`<div style="margin:20px 0;">{{answers}}</div>`}${btn('{{adminUrl}}', 'View in Dashboard')}${footer()}${wrapEnd()}`
  ),

  form_notification: (logo) => tpl(
    'New form submission: {{formTitle}}',
    `${head('New Form Submission')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.bell, 'New submission', 'A new submission was received.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A new submission was received for <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${`<div style="margin:20px 0;">{{submissionData}}</div>`}${btn('{{formUrl}}', 'View Submission')}${footer()}${wrapEnd()}`
  ),

  form_flagged: (logo) => tpl(
    'Your form "{{formTitle}}" was flagged',
    `${head('Form Flagged')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.alertTriangle, 'Form Flagged', 'Suspicious activity was detected.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> was flagged by our security review.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Reason:</strong> {{reason}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Flagged at:</strong> {{flaggedAt}}</p>`)}${btn('{{adminUrl}}', 'View Flag Details')}${footer()}${wrapEnd()}`
  ),

  form_published: (logo) => tpl(
    'Your form "{{formTitle}}" is now live',
    `${head('Form Published')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.zap, 'Form is live', 'Your form is accepting responses.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> is now live.</p>`}${btn('{{formUrl}}', 'View Form')}${footer()}${wrapEnd()}`
  ),

  form_closed: (logo) => tpl(
    'Your form "{{formTitle}}" has been closed',
    `${head('Form Closed')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.lock, 'Form closed', 'Your form is no longer accepting responses.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been closed.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">You can reopen it from your dashboard.</p>`}${footer()}${wrapEnd()}`
  ),

  form_deleted: (logo) => tpl(
    'Your form "{{formTitle}}" has been deleted',
    `${head('Form Deleted')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.trash, 'Form deleted', 'Your form has been permanently deleted.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been permanently deleted.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">This action cannot be undone.</p>`}${footer()}${wrapEnd()}`
  ),

  form_archived: (logo) => tpl(
    'Your form "{{formTitle}}" has been archived',
    `${head('Form Archived')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.download, 'Form archived', 'Your form has been archived.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been archived.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Archived forms can be restored from your dashboard.</p>`}${footer()}${wrapEnd()}`
  ),

  response_updated: (logo) => tpl(
    'A response to "{{formTitle}}" was updated',
    `${head('Response Updated')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.edit, 'Response updated', 'A form response was modified.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A response to <strong style="color:${TEXT};">{{formTitle}}</strong> was updated.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Updated:</strong> {{updatedAt}}</p>`)}${footer()}${wrapEnd()}`
  ),

  response_deleted: (logo) => tpl(
    'A response to "{{formTitle}}" was deleted',
    `${head('Response Deleted')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.trash, 'Response deleted', 'A form response was removed.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A response to <strong style="color:${TEXT};">{{formTitle}}</strong> was deleted.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Deleted:</strong> {{deletedAt}}</p>`)}${footer()}${wrapEnd()}`
  ),

  ticket_created: (logo) => tpl(
    'Support ticket opened: {{ticketSubject}}',
    `${head('Support Ticket Opened')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.fileText, 'Support Ticket', 'Your ticket has been created.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your support ticket has been created.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Ticket:</strong> {{ticketId}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Subject:</strong> {{ticketSubject}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Status:</strong> {{ticketStatus}}</p>`)}${btn('{{ticketUrl}}', 'View Ticket')}${footer()}${wrapEnd()}`
  ),

  ticket_updated: (logo) => tpl(
    'Update on your support ticket {{ticketId}}',
    `${head('Ticket Updated')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.edit, 'Ticket updated', 'Your ticket has a new update.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your ticket <strong style="color:${TEXT};">{{ticketId}}</strong> has been updated.</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{updateMessage}}</p>`}${btn('{{ticketUrl}}', 'View Ticket')}${footer()}${wrapEnd()}`
  ),

  ticket_closed: (logo) => tpl(
    'Your support ticket {{ticketId}} has been closed',
    `${head('Ticket Closed')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.check, 'Ticket closed', 'Your ticket has been resolved.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your ticket <strong style="color:${TEXT};">{{ticketId}}</strong> has been closed.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you still need help, feel free to open a new ticket.</p>`}${footer()}${wrapEnd()}`
  ),
};

// ─── FORM NOTIFICATION TEMPLATES ───
export const FORM_NOTIFICATION_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {
  form_milestone: (logo) => tpl(
    'Milestone: {{formTitle}} reached {{milestone}} responses!',
    `${head('Milestone Reached!')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.star, 'Milestone Reached!', 'Your form hit an important milestone.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has reached <strong style="color:${TEXT};">{{milestone}}</strong> responses!</p>`}${`<div style="text-align:center;margin:24px 0;"><p style="margin:0;font-size:48px;font-weight:700;color:${TEXT};">{{milestone}}</p><p style="margin:4px 0 0;font-size:14px;color:${MUTED};">Total Responses</p></div>`}${btn('{{adminUrl}}', 'View Overview')}${footer()}${wrapEnd()}`
  ),

  form_spike: (logo) => tpl(
    'Response spike detected on "{{formTitle}}"',
    `${head('Response Spike')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.zap, 'Response Spike', 'Your form is receiving responses at an increased rate.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We detected a spike in responses for <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Responses (last 10 min):</strong> {{responseCount}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Total:</strong> {{totalResponses}}</p>`)}${btn('{{adminUrl}}', 'View Responses')}${footer()}${wrapEnd()}`
  ),

  form_revival: (logo) => tpl(
    'Your form "{{formTitle}}" is active again',
    `${head('Form Revival')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.bell, 'Form Active Again', 'Your dormant form received a new response.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been dormant, but it just received a new response!</p>`}${btn('{{adminUrl}}', 'View Responses')}${footer()}${wrapEnd()}`
  ),

  form_test: (logo) => tpl(
    'Test notification: {{formTitle}}',
    `${head('Test Notification')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.check, 'Test Notification', 'Verifying your email settings.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">This is a test email to verify your notification settings for <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${`<div style="text-align:center;margin:24px 0;padding:24px;border-radius:10px;"><p style="margin:0;font-size:14px;font-weight:600;color:${GREEN};">Email Notifications Working</p></div>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">You will receive similar emails when someone submits a response.</p>`}${footer()}${wrapEnd()}`
  ),

  form_summary_daily: (logo) => tpl(
    'Daily Summary: {{formTitle}} — {{newResponses}} new responses',
    `${head('Daily Summary')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.barChart, 'Daily Summary', 'Here is how your form performed today.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p>`}${`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="width:50%;padding:16px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid ${BORDER};text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${TEXT};">{{newResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">New Responses</p></td><td style="width:16px;"></td><td style="width:50%;padding:16px;border-radius:8px;border:1px solid ${BORDER};text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${TEXT};">{{totalResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">Total Responses</p></td></tr></table>`}${btn('{{adminUrl}}', 'View Analytics')}${footer()}${wrapEnd()}`
  ),

  form_summary_weekly: (logo) => tpl(
    'Weekly Summary: {{formTitle}} — {{newResponses}} new responses',
    `${head('Weekly Summary')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.barChart, 'Weekly Summary', 'Here is your weekly performance report.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p>`}${`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="width:50%;padding:16px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid ${BORDER};text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${TEXT};">{{newResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">New Responses</p></td><td style="width:16px;"></td><td style="width:50%;padding:16px;border-radius:8px;border:1px solid ${BORDER};text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${TEXT};">{{totalResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">Total Responses</p></td></tr></table>`}${btn('{{adminUrl}}', 'View Analytics')}${footer()}${wrapEnd()}`
  ),

  webhook_failed: (logo) => tpl(
    'Webhook delivery failed for "{{formTitle}}"',
    `${head('Webhook Failed')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.alertTriangle, 'Webhook Failed', 'A webhook delivery failed.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A webhook delivery for <strong style="color:${TEXT};">{{formTitle}}</strong> failed.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">URL:</strong> {{webhookUrl}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">HTTP Status:</strong> {{httpStatus}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Error:</strong> {{errorMessage}}</p>`)}${btn('{{settingsUrl}}', 'Check Settings')}${footer()}${wrapEnd()}`
  ),

  collaborator_added: (logo) => tpl(
    'You have been added as a collaborator to "{{formTitle}}"',
    `${head('Collaborator Added')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.users, 'Collaborator Added', 'You have been invited to collaborate.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">You have been added as a <strong style="color:${TEXT};">{{role}}</strong> collaborator to <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Form:</strong> {{formTitle}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Your Role:</strong> {{role}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Added by:</strong> {{addedByName}}</p>`)}${btn('{{formUrl}}', 'Open Form')}${footer()}${wrapEnd()}`
  ),

  response_limit_reached: (logo) => tpl(
    'Response limit reached for "{{formTitle}}"',
    `${head('Response Limit Reached')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.xCircle, 'Limit Reached', 'Your form has reached its response limit.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has reached its limit of <strong style="color:${TEXT};">{{limit}}</strong> responses.</p>`}${btn('{{settingsUrl}}', 'Update Settings')}${footer()}${wrapEnd()}`
  ),

  form_scheduled: (logo) => tpl(
    'Your form "{{formTitle}}" will open on {{scheduledAt}}',
    `${head('Form Scheduled')}${wrapStart()}${logoBlock(logo)}${heroIcon(ICONS.calendar, 'Form Scheduled', 'Your form will open automatically.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> is scheduled to open on <strong style="color:${TEXT};">{{scheduledAt}}</strong>.</p>`}${btn('{{adminUrl}}', 'View Form')}${footer()}${wrapEnd()}`
  ),
};

export function buildTemplates(logoUrl: string = '', imageBase: string = DEFAULT_IMAGE_BASE): Record<string, EmailTemplate> {
  const logo = logoUrl || '';
  const result: Record<string, EmailTemplate> = {};
  for (const [key, fn] of Object.entries(EMAIL_TEMPLATES)) {
    result[key] = fn(logo, imageBase);
  }
  for (const [key, fn] of Object.entries(FORM_NOTIFICATION_TEMPLATES)) {
    if (!result[key]) result[key] = fn(logo, imageBase);
  }
  return result;
}

export function renderTemplate(html: string, vars: Record<string, string>): string {
  let result = html;
  for (const [key, val] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), val.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));
  }
  return result;
}
