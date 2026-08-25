export type EmailTemplate = { subject: string; html: string };

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

// ═══ LIGHT THEME PALETTE (matches Dashboard CSS vars) ═══
const BG = '#f8fafc';           // page background
const CARD = '#ffffff';          // card / surface
const BORDER = '#e2e8f0';       // borders
const TEXT = '#0f172a';          // primary text
const TEXT2 = '#475569';         // secondary text
const MUTED = '#94a3b8';        // muted text
const BLUE = '#2563eb';         // primary accent
const BLUE_SOFT = '#eff6ff';    // blue background
const GREEN = '#16a34a';        // success
const GREEN_SOFT = '#f0fdf4';   // success bg
const RED = '#dc2626';          // error
const RED_SOFT = '#fef2f2';     // error bg
const YELLOW = '#ca8a04';       // warning
const YELLOW_SOFT = '#fefce8';  // warning bg

const DEFAULT_IMAGE_BASE = 'https://api.tirbeo.app/image';

// ═══ SHARED HELPERS ═══

function head(title: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title><style>@media only screen and (max-width:600px){body{padding:16px!important}.container{width:100%!important}h1{font-size:24px!important}td{padding:20px 24px!important}}</style></head><body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};-webkit-font-smoothing:antialiased;">`;
}

function wrapperStart(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 20px;"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" class="container" style="max-width:600px;width:100%;">`;
}

function wrapperEnd(): string {
  return `</table></td></tr></table></body></html>`;
}

function logoBlock(logo: string, appName?: string): string {
  const name = appName || 'Tirbeo';
  const logoHtml = logo
    ? `<img src="${logo}" height="32" alt="${name}" style="display:block;margin:0 auto;">`
    : `<div style="width:32px;height:32px;border-radius:8px;background:${BLUE};display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;">T</div>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 0 24px;">${logoHtml}</td></tr></table>`;
}

function cardStart(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;overflow:hidden;"><tr><td style="padding:40px;">`;
}

function cardEnd(): string {
  return `</td></tr></table>`;
}

function heroBlock(icon: string, title: string, subtitle: string): string {
  return `<div style="text-align:center;margin-bottom:32px;"><div style="width:56px;height:56px;border-radius:14px;background:${BLUE_SOFT};display:inline-flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:16px;">${icon}</div><h1 style="margin:0;font-size:24px;font-weight:700;color:${TEXT};letter-spacing:-0.02em;">${title}</h1><p style="margin:8px 0 0;font-size:15px;color:${TEXT2};line-height:24px;">${subtitle}</p></div>`;
}

function otpBlock(code: string): string {
  return `<div style="text-align:center;margin:24px 0;"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="font-size:32px;font-weight:700;letter-spacing:8px;color:${TEXT};font-family:monospace;background:${BG};border:1px solid ${BORDER};border-radius:10px;padding:20px 28px;">${code}</td></tr></table></div>`;
}

function buttonBlock(url: string, label: string): string {
  return `<div style="text-align:center;margin:28px 0;"><a href="${url}" style="display:inline-block;padding:12px 28px;background:${BLUE};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">${label}</a></div>`;
}

function secondaryButton(url: string, label: string): string {
  return `<div style="text-align:center;margin:12px 0;"><a href="${url}" style="display:inline-block;padding:10px 24px;background:transparent;color:${BLUE};font-size:13px;font-weight:500;text-decoration:none;border-radius:8px;border:1px solid ${BORDER};">${label}</a></div>`;
}

function infoBox(content: string): string {
  return `<div style="background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:16px;margin:20px 0;">${content}</div>`;
}

function divider(): string {
  return `<div style="height:1px;background:${BORDER};margin:24px 0;"></div>`;
}

function footer(appName: string = 'Tirbeo'): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px 0;text-align:center;"><p style="margin:0;font-size:12px;color:${MUTED};">&copy; 2026 ${appName}. All rights reserved.</p><p style="margin:8px 0 0;font-size:12px;color:${MUTED};"><a href="https://tirbeo.app/privacy" style="color:${BLUE};text-decoration:none;">Privacy</a> &middot; <a href="https://tirbeo.app/terms" style="color:${BLUE};text-decoration:none;">Terms</a></p>{{unsubscribeSection}}</td></tr></table>`;
}

// ═══ APP-SPECIFIC BRANDING ═══
const APP_BRAND: Record<string, { name: string; icon: string; color: string }> = {
  dashboard: { name: 'Tirbeo', icon: '🏠', color: BLUE },
  flows: { name: 'Tirbeo Flows', icon: '⚡', color: '#7c3aed' },
  admin: { name: 'Tirbeo Admin', icon: '🛡️', color: '#dc2626' },
  accounts: { name: 'Tirbeo Accounts', icon: '👤', color: BLUE },
};

function appHeader(app: string, logo: string): string {
  const brand = APP_BRAND[app] || APP_BRAND.dashboard;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};border:1px solid ${BORDER};border-radius:12px;border-bottom:none;border-bottom-left-radius:0;border-bottom-right-radius:0;"><tr><td style="padding:24px 40px;border-bottom:1px solid ${BORDER};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>${logoBlock(logo, brand.name)}</td><td style="text-align:right;"><span style="display:inline-block;padding:4px 10px;background:${brand.color}15;color:${brand.color};border-radius:6px;font-size:11px;font-weight:600;">${brand.name}</span></td></tr></table></td></tr><tr><td style="padding:40px;">`;
}

function appFooter(app: string): string {
  return `</td></tr></table>${footer(APP_BRAND[app]?.name || 'Tirbeo')}`;
}

// ═══ TEMPLATES ═══

export const EMAIL_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {

  // ─── AUTH TEMPLATES (Accounts app) ───

  signup_otp: (logo) => tpl(
    'Your Tirbeo verification code is {{otp}}',
    `${head('Verify Your Email')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('✉️', 'Verify your email', 'Complete your account setup.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Use the code below to verify your email address. This code expires in <strong style="color:${TEXT};">10 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not create an account, you can safely ignore this email.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  login_otp: (logo) => tpl(
    'Your Tirbeo login code is {{otp}}',
    `${head('Your Login Code')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🔑', 'Your login code', 'Use this code to sign in.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Here is your login verification code. It expires in <strong style="color:${TEXT};">10 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this login, you can safely ignore this email.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  verify_email: (logo) => tpl(
    'Verify your Tirbeo email',
    `${head('Verify Your Email')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('✉️', 'Verify your email', 'Confirm your email address.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Your verification code:</p>`}${otpBlock('{{otp}}')}${`<p style="margin:16px 0 0;font-size:14px;color:${MUTED};">This code expires in 10 minutes.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  magic_link: (logo) => tpl(
    'Sign in to Tirbeo',
    `${head('Sign in to Tirbeo')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🚀', 'Sign in to Tirbeo', 'One click and you are in.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hi {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Click the button below to sign in. This link expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${buttonBlock('{{magicLink}}', 'Sign In')}${`<p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">Link: {{magicLink}}</p>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore it.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  // ─── PASSWORD / SECURITY ───

  password_reset_otp: (logo) => tpl(
    'Your Tirbeo password reset code is {{otp}}',
    `${head('Reset Your Password')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🔒', 'Reset your password', 'Use the code below to set a new password.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We received a password reset request. Use the code below. It expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${otpBlock('{{otp}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore this email.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  password_reset_link: (logo) => tpl(
    'Reset your Tirbeo password',
    `${head('Reset Your Password')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🔒', 'Reset your password', 'Click below to set a new password.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Click the button to reset your password. This link expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${buttonBlock('{{resetUrl}}', 'Reset Password')}${`<p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">Link: {{resetUrl}}</p>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore this email.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  password_changed: (logo) => tpl(
    'Your Tirbeo password was changed',
    `${head('Password Changed')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('✅', 'Password changed', 'Your password was updated successfully.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your password was changed successfully.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{changedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">IP:</strong> {{ipAddress}}</p>`)}${`<p style="margin:16px 0 0;font-size:14px;line-height:22px;color:${MUTED};">If you did not make this change, please reset your password immediately.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  suspicious_login: (logo) => tpl(
    'Suspicious login detected on your Tirbeo account',
    `${head('Security Alert')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('⚠️', 'Suspicious login detected', 'We noticed a sign-in from an unusual location.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We noticed a sign-in from an unusual location or device.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{loginTime}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">IP:</strong> {{ipAddress}}</p>`)}${buttonBlock('{{revokeUrl}}', 'Review Sessions')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If this was not you, please secure your account immediately.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  login_alert: (logo) => tpl(
    'New sign-in to your Tirbeo account',
    `${head('New Sign-in')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🆕', 'New sign-in detected', 'A new sign-in was detected on your account.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A new sign-in was detected. If this was you, you can ignore this email.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{loginTime}}</p>`)}${buttonBlock('{{revokeUrl}}', 'Review Sessions')}${appFooter('accounts')}${wrapperEnd()}`
  ),

  account_recovery: (logo) => tpl(
    'Reset your Tirbeo account',
    `${head('Account Recovery')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🔑', 'Account recovery', 'Click below to set a new password.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We received a request to recover your account. Click below. This link expires in <strong style="color:${TEXT};">15 minutes</strong>.</p>`}${buttonBlock('{{recoveryUrl}}', 'Recover Account')}${`<p style="margin:16px 0 0;font-size:13px;color:${MUTED};word-break:break-all;">Link: {{recoveryUrl}}</p>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you did not request this, you can safely ignore this email.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  // ─── WELCOME / ONBOARDING (Accounts) ───

  welcome: (logo) => tpl(
    'Welcome to Tirbeo, {{name}}!',
    `${head('Welcome to Tirbeo')}${wrapperStart()}${appHeader('accounts', logo)}${heroBlock('🎉', 'Welcome to Tirbeo!', 'Your account is ready. Let\'s build something great.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hi {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Thanks for joining <strong style="color:${TEXT};">Tirbeo</strong>. Your account has been created and you are ready to start.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};">Here is what you can do next:</p><ul style="margin:12px 0 0;padding-left:20px;font-size:14px;color:${TEXT2};line-height:28px;"><li>Complete your profile</li><li>Explore your dashboard</li><li>Connect your first app</li></ul>`)}${buttonBlock('{{dashboardUrl}}', 'Go to Dashboard')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Questions? Visit our <a href="https://tirbeo.app/help" style="color:${BLUE};text-decoration:none;">Help Center</a>.</p>`}${appFooter('accounts')}${wrapperEnd()}`
  ),

  // ─── DASHBOARD TEMPLATES ───

  notification_digest: (logo) => tpl(
    'Your Tirbeo digest — {{count}} new updates',
    `${head('Your Tirbeo Digest')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📬', 'Your Digest', 'You have {{count}} new updates.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Here is what is new since your last visit:</p>`}${`<div style="margin:20px 0;">{{digestItems}}</div>`}${buttonBlock('{{dashboardUrl}}', 'View All Updates')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Manage your <a href="{{dashboardUrl}}/account/notifications" style="color:${BLUE};text-decoration:none;">email preferences</a>.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── PRODUCT UPDATE BROADCAST (admin → opted-in users) ───

  product_update: (logo) => tpl(
    '{{title}}',
    `${head('Product Update')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🚀', 'Product Update', '{{title}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{message}}</p>`}${buttonBlock('{{ctaUrl}}', '{{ctaLabel}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">You are receiving product emails. Manage your <a href="{{dashboardUrl}}/account/notifications" style="color:${BLUE};text-decoration:none;">email preferences</a>.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── WEEKLY ACTIVITY SUMMARY ───

  weekly_summary: (logo) => tpl(
    'Your Tirbeo week — {{periodLabel}}',
    `${head('Weekly Summary')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📊', 'Your Week on Tirbeo', '{{periodLabel}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Here is a summary of your account activity for the past week.</p>`}${`<div style="margin:20px 0;padding:18px;background:#f8f9fa;border-radius:10px;border:1px solid #e5e7eb;"><p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:${MUTED};">Activity overview</p>{{statRows}}</div>`}${'{{suspiciousSection}}'}${buttonBlock('{{dashboardUrl}}/activity/history', 'View Full Activity History')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Manage your <a href="{{dashboardUrl}}/account/notifications" style="color:${BLUE};text-decoration:none;">email preferences</a>.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── AUTO-GENERATED ACCOUNT TIP ───

  account_tip: (logo) => tpl(
    '💡 Tip: {{tipTitle}}',
    `${head('Tips & Updates')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('💡', 'Pro Tip', '{{tipTitle}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{tipBody}}</p>`}${buttonBlock('{{actionUrl}}', '{{actionLabel}}')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">These tips are generated automatically based on your account. Turn them off in your <a href="{{dashboardUrl}}/account/notifications" style="color:${BLUE};text-decoration:none;">email preferences</a>.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── ACCOUNT STATUS (SUSPENDED / BANNED) ───

  account_suspended: (logo) => tpl(
    'Your Tirbeo account has been {{statusType}}',
    `${head('Account Status')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('⚠', 'Account Status Update', 'Your account has been {{statusType}}.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};"><strong>Reason:</strong> {{reason}}</p><p style="margin:0 0 16px;font-size:15px;line-height:26px;color:${TEXT2};">{{untilLabel}} {{actionLabel}}</p>`}${buttonBlock('{{dashboardUrl}}/account', 'Go to Your Account')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  account_deleted: (logo) => tpl(
    'Your Tirbeo account is scheduled for deletion',
    `${head('Deletion Scheduled')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🗑', 'Deletion Scheduled', 'Your account will be deleted on {{dateLabel}}.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">You requested deletion of your Tirbeo account. After this date, all your data will be permanently removed.</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Changed your mind? Sign in before <strong>{{dateLabel}}</strong> and cancel the deletion from your dashboard.</p>`}${buttonBlock('{{dashboardUrl}}/account/security', 'Cancel Deletion')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── ADMIN TEMPLATES ───

  admin_alert: (logo) => tpl(
    '[Admin] {{subject}}',
    `${head('Admin Alert')}${wrapperStart()}${appHeader('admin', logo)}${heroBlock('🛡️', 'Admin Alert', '{{subject}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello Admin,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{message}}</p>`}${infoBox('{{details}}')}${buttonBlock('{{dashboardUrl}}', 'View Admin Dashboard')}${divider()}${`<p style="margin:0;font-size:13px;line-height:22px;color:${MUTED};">Automated alert from Tirbeo Admin.</p>`}${appFooter('admin')}${wrapperEnd()}`
  ),

  system_alert: (logo) => tpl(
    '[System] {{subject}}',
    `${head('System Alert')}${wrapperStart()}${appHeader('admin', logo)}${heroBlock('⚙️', 'System Alert', '{{message}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{message}}</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Service:</strong> {{service}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{alertTime}}</p>`)}${appFooter('admin')}${wrapperEnd()}`
  ),

  admin_crash_report: (logo) => tpl(
    '[Crash] {{severity}}: {{type}}',
    `${head('Crash Report')}${wrapperStart()}${appHeader('admin', logo)}${heroBlock('🔴', '{{severity}} Crash', '{{type}}')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">A user crash has been reported and requires attention.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Severity:</strong> <span style="color:{{severityColor}}">{{severity}}</span></p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Type:</strong> {{type}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Message:</strong> {{message}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">User:</strong> {{userEmail}} ({{username}})</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Page:</strong> {{url}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Source:</strong> {{source}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">User Agent:</strong> {{userAgent}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Time:</strong> {{timestamp}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Event ID:</strong> {{eventId}}</p>`)}${infoBox(`<p style="margin:0;font-size:13px;color:${MUTED};font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto">{{stack}}</p>`)}${buttonBlock('{{dashboardUrl}}', 'View Crash Details')}${appFooter('admin')}${wrapperEnd()}`
  ),


  export_ready: (logo) => tpl(
    'Your data export is ready',
    `${head('Data Export Ready')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📦', 'Export Ready', 'Your data archive is ready to download.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your data export is ready. It includes your profile, sessions, and activity.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Exported:</strong> {{exportedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Format:</strong> JSON</p>`)}${buttonBlock('{{downloadUrl}}', 'Download Archive')}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">The download link is valid for <strong style="color:${TEXT};">7 days</strong>.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── FORM TEMPLATES ───

  form_submission_confirmation: (logo) => tpl(
    'Your response to {{formTitle}} was recorded',
    `${head('Response Recorded')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📝', 'Response recorded', 'Thank you for submitting the form.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{respondentName}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Thank you for submitting <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${buttonBlock('{{formUrl}}', 'View Form')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_response: (logo) => tpl(
    'New response to "{{formTitle}}"',
    `${head('New Form Response')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📝', 'New Form Response', 'A new response was submitted.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">A new response was submitted to <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Respondent:</strong> {{respondentName}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Submitted:</strong> {{submittedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Response ID:</strong> {{responseId}}</p>`)}${`<div style="margin:20px 0;">{{answers}}</div>`}${buttonBlock('{{adminUrl}}', 'View in Dashboard')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_notification: (logo) => tpl(
    'New form submission: {{formTitle}}',
    `${head('New Form Submission')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📬', 'New submission', 'A new submission was received.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A new submission was received for <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${`<div style="margin:20px 0;">{{submissionData}}</div>`}${buttonBlock('{{formUrl}}', 'View Submission')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_flagged: (logo) => tpl(
    'Your form "{{formTitle}}" was flagged',
    `${head('Form Flagged')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🚨', 'Form Flagged', 'Suspicious activity was detected.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> was flagged by our security review.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Reason:</strong> {{reason}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Flagged at:</strong> {{flaggedAt}}</p>`)}${buttonBlock('{{adminUrl}}', 'View Flag Details')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_published: (logo) => tpl(
    'Your form "{{formTitle}}" is now live',
    `${head('Form Published')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🚀', 'Form is live', 'Your form is accepting responses.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> is now live.</p>`}${buttonBlock('{{formUrl}}', 'View Form')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_closed: (logo) => tpl(
    'Your form "{{formTitle}}" has been closed',
    `${head('Form Closed')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🔒', 'Form closed', 'Your form is no longer accepting responses.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been closed.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">You can reopen it from your dashboard.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_deleted: (logo) => tpl(
    'Your form "{{formTitle}}" has been deleted',
    `${head('Form Deleted')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🗑️', 'Form deleted', 'Your form has been permanently deleted.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been permanently deleted.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">This action cannot be undone.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_archived: (logo) => tpl(
    'Your form "{{formTitle}}" has been archived',
    `${head('Form Archived')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📁', 'Form archived', 'Your form has been archived.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been archived.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">Archived forms can be restored from your dashboard.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  response_updated: (logo) => tpl(
    'A response to "{{formTitle}}" was updated',
    `${head('Response Updated')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('✏️', 'Response updated', 'A form response was modified.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A response to <strong style="color:${TEXT};">{{formTitle}}</strong> was updated.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Updated:</strong> {{updatedAt}}</p>`)}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  response_deleted: (logo) => tpl(
    'A response to "{{formTitle}}" was deleted',
    `${head('Response Deleted')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🗑️', 'Response deleted', 'A form response was removed.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A response to <strong style="color:${TEXT};">{{formTitle}}</strong> was deleted.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Deleted:</strong> {{deletedAt}}</p>`)}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  // ─── SUPPORT TEMPLATES ───

  ticket_created: (logo) => tpl(
    'Support ticket opened: {{ticketSubject}}',
    `${head('Support Ticket Opened')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🎫', 'Support Ticket', 'Your ticket has been created.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your support ticket has been created.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Ticket:</strong> {{ticketId}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Subject:</strong> {{ticketSubject}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Status:</strong> {{ticketStatus}}</p>`)}${buttonBlock('{{ticketUrl}}', 'View Ticket')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  ticket_updated: (logo) => tpl(
    'Update on your support ticket {{ticketId}}',
    `${head('Ticket Updated')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('💬', 'Ticket updated', 'Your ticket has a new update.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your ticket <strong style="color:${TEXT};">{{ticketId}}</strong> has been updated.</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">{{updateMessage}}</p>`}${buttonBlock('{{ticketUrl}}', 'View Ticket')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  ticket_closed: (logo) => tpl(
    'Your support ticket {{ticketId}} has been closed',
    `${head('Ticket Closed')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('✅', 'Ticket closed', 'Your ticket has been resolved.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your ticket <strong style="color:${TEXT};">{{ticketId}}</strong> has been closed.</p>`}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">If you still need help, feel free to open a new ticket.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),
};

// ─── FORM NOTIFICATION TEMPLATES ───
export const FORM_NOTIFICATION_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {
  form_milestone: (logo) => tpl(
    'Milestone: {{formTitle}} reached {{milestone}} responses!',
    `${head('Milestone Reached!')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🎉', 'Milestone Reached!', 'Your form hit an important milestone.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has reached <strong style="color:${TEXT};">{{milestone}}</strong> responses!</p>`}${`<div style="text-align:center;margin:24px 0;"><p style="margin:0;font-size:48px;font-weight:700;color:${BLUE};">{{milestone}}</p><p style="margin:4px 0 0;font-size:14px;color:${MUTED};">Total Responses</p></div>`}${buttonBlock('{{adminUrl}}', 'View Overview')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_spike: (logo) => tpl(
    'Response spike detected on "{{formTitle}}"',
    `${head('Response Spike')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📈', 'Response Spike', 'Your form is receiving responses at an increased rate.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">We detected a spike in responses for <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Responses (last 10 min):</strong> {{responseCount}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Total:</strong> {{totalResponses}}</p>`)}${buttonBlock('{{adminUrl}}', 'View Responses')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_revival: (logo) => tpl(
    'Your form "{{formTitle}}" is active again',
    `${head('Form Revival')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🔔', 'Form Active Again', 'Your dormant form received a new response.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has been dormant, but it just received a new response!</p>`}${buttonBlock('{{adminUrl}}', 'View Responses')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_test: (logo) => tpl(
    'Test notification: {{formTitle}}',
    `${head('Test Notification')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('✅', 'Test Notification', 'Verifying your email settings.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">This is a test email to verify your notification settings for <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${`<div style="text-align:center;margin:24px 0;padding:24px;background:${GREEN_SOFT};border-radius:10px;"><p style="margin:0;font-size:28px;">✅</p><p style="margin:8px 0 0;font-size:16px;font-weight:600;color:${GREEN};">Email Notifications Working!</p></div>`}${divider()}${`<p style="margin:0;font-size:14px;line-height:22px;color:${MUTED};">You will receive similar emails when someone submits a response.</p>`}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_summary_daily: (logo) => tpl(
    'Daily Summary: {{formTitle}} — {{newResponses}} new responses',
    `${head('Daily Summary')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📊', 'Daily Summary', 'Here is how your form performed today.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p>`}${`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="width:50%;padding:16px;background:${BLUE_SOFT};border-radius:8px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${BLUE};">{{newResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">New Responses</p></td><td style="width:16px;"></td><td style="width:50%;padding:16px;background:${BG};border:1px solid ${BORDER};border-radius:8px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${TEXT};">{{totalResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">Total Responses</p></td></tr></table>`}${buttonBlock('{{adminUrl}}', 'View Analytics')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_summary_weekly: (logo) => tpl(
    'Weekly Summary: {{formTitle}} — {{newResponses}} new responses',
    `${head('Weekly Summary')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('📊', 'Weekly Summary', 'Here is your weekly performance report.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p>`}${`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="width:50%;padding:16px;background:${BLUE_SOFT};border-radius:8px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${BLUE};">{{newResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">New Responses</p></td><td style="width:16px;"></td><td style="width:50%;padding:16px;background:${BG};border:1px solid ${BORDER};border-radius:8px;text-align:center;"><p style="margin:0;font-size:28px;font-weight:700;color:${TEXT};">{{totalResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">Total Responses</p></td></tr></table>`}${buttonBlock('{{adminUrl}}', 'View Analytics')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  webhook_failed: (logo) => tpl(
    'Webhook delivery failed for "{{formTitle}}"',
    `${head('Webhook Failed')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('⚠️', 'Webhook Failed', 'A webhook delivery failed.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">A webhook delivery for <strong style="color:${TEXT};">{{formTitle}}</strong> failed.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">URL:</strong> {{webhookUrl}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">HTTP Status:</strong> {{httpStatus}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Error:</strong> {{errorMessage}}</p>`)}${buttonBlock('{{settingsUrl}}', 'Check Settings')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  collaborator_added: (logo) => tpl(
    'You have been added as a collaborator to "{{formTitle}}"',
    `${head('Collaborator Added')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('👥', 'Collaborator Added', 'You have been invited to collaborate.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello {{name}},</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">You have been added as a <strong style="color:${TEXT};">{{role}}</strong> collaborator to <strong style="color:${TEXT};">{{formTitle}}</strong>.</p>`}${infoBox(`<p style="margin:0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Form:</strong> {{formTitle}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Your Role:</strong> {{role}}</p><p style="margin:8px 0 0;font-size:14px;color:${TEXT2};"><strong style="color:${TEXT};">Added by:</strong> {{addedByName}}</p>`)}${buttonBlock('{{formUrl}}', 'Open Form')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  response_limit_reached: (logo) => tpl(
    'Response limit reached for "{{formTitle}}"',
    `${head('Response Limit Reached')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('🚫', 'Limit Reached', 'Your form has reached its response limit.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> has reached its limit of <strong style="color:${TEXT};">{{limit}}</strong> responses.</p>`}${buttonBlock('{{settingsUrl}}', 'Update Settings')}${appFooter('dashboard')}${wrapperEnd()}`
  ),

  form_scheduled: (logo) => tpl(
    'Your form "{{formTitle}}" will open on {{scheduledAt}}',
    `${head('Form Scheduled')}${wrapperStart()}${appHeader('dashboard', logo)}${heroBlock('⏰', 'Form Scheduled', 'Your form will open automatically.')}${`<p style="margin:0;font-size:15px;line-height:26px;color:${TEXT2};">Hello,</p><p style="margin:16px 0;font-size:15px;line-height:26px;color:${TEXT2};">Your form <strong style="color:${TEXT};">{{formTitle}}</strong> is scheduled to open on <strong style="color:${TEXT};">{{scheduledAt}}</strong>.</p>`}${buttonBlock('{{adminUrl}}', 'View Form')}${appFooter('dashboard')}${wrapperEnd()}`
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
