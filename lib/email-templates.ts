export type EmailTemplate = { subject: string; html: string };

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

// ─── TIRBEO dark/black theme palette ───
const PAPER = '#0a0a0a';     // page background (deep black)
const CARD = '#141414';      // card / surface (dark charcoal)
const INK = '#f2f2f2';       // text + borders (bright white)
const ACCENT = '#8b5cf6';    // accent (violet/purple for buttons, highlights)
const MUTED = '#9ca3af';     // secondary text (gray)
const SHADOW = '4px 4px 0 0 #8b5cf6';
const BORDER = '#2a2a2a';    // border color (dark gray)

function head(title: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>@media only screen and (max-width:600px){body{padding:24px 16px !important;}.container{padding:24px !important;}h1{font-size:24px !important;}}</style></head><body style="margin:0;padding:0;background:${PAPER};font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};-webkit-font-smoothing:antialiased;">`;
}

function headerHtml(logo: string, title: string, subtitle: string): string {
  const logoHtml = logo
    ? `<img src="${logo}" width="44" alt="Tirbeo" style="display:block;margin:0 auto 18px;border-radius:12px;">`
    : `<span style="display:inline-block;width:44px;height:44px;border-radius:12px;background:${ACCENT};font-weight:800;color:#fff;font-size:20px;line-height:44px;text-align:center;">T</span>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:${CARD};border:1px solid ${BORDER};border-radius:16px;overflow:hidden;"><tr><td style="padding:48px 48px 40px;text-align:center;background:linear-gradient(180deg,${CARD} 0%,#1a1a1a 100%);"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><p style="margin:0 0 14px;font-size:11px;font-weight:800;letter-spacing:.22em;color:${ACCENT};text-transform:uppercase;">Tirbeo</p>${logoHtml}</td></tr><tr><td align="center"><h1 style="margin:0;font-size:30px;font-weight:800;color:${INK};letter-spacing:-.02em;">${title}</h1><p style="margin:14px 0 0;font-size:15px;line-height:26px;color:${MUTED};">${subtitle}</p></td></tr></table></td></tr>`;
}

function footerHtml(signature: string = ''): string {
  const sigHtml = signature
    ? `<p style="margin:14px 0 0;font-size:12px;color:${MUTED};line-height:20px;">${signature}</p>`
    : '';
  return `<tr><td style="padding:32px 48px;background:${CARD};text-align:center;border-top:1px solid ${BORDER};"><p style="margin:0;font-size:11px;font-weight:800;letter-spacing:.22em;color:${ACCENT};text-transform:uppercase;">Tirbeo</p><p style="margin:12px 0 0;font-size:12px;color:${MUTED};line-height:20px;">&copy; 2026 Tirbeo Inc.<br><a href="https://tirbeo.app/privacy" style="color:${ACCENT};text-decoration:none;font-weight:600;">Privacy Policy</a> &middot; <a href="https://tirbeo.app/terms" style="color:${ACCENT};text-decoration:none;font-weight:600;">Terms</a> &middot; <a href="https://tirbeo.app/settings/emails" style="color:${ACCENT};text-decoration:none;font-weight:600;">Manage Email Preferences</a></p>${sigHtml}</td></tr></table></td></tr></table></body></html>`;
}

function bodyStart(): string {
  return `<tr><td style="padding:32px 48px;background:${CARD};">`;
}

function bodyEnd(): string {
  return `</td></tr>`;
}

function divider(): string {
  return `<div style="margin:32px 0;height:1px;background:${BORDER};"></div>`;
}

const DEFAULT_IMAGE_BASE = 'https://api.tirbeo.app/image';

function heroImg(imageBase: string, name: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};"><tr><td align="center" style="padding:36px 48px 0;background:${CARD};"><img src="${imageBase}/${name}.png" width="100%" alt="" style="max-width:480px;width:100%;height:auto;display:block;margin:0 auto;border-radius:12px;"></td></tr></table>`;
}

export function otpCodeBlock(code: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="font-size:30px;font-weight:800;letter-spacing:10px;color:${INK};font-family:monospace;background:#1a1a1a;border:1px solid ${BORDER};border-radius:12px;padding:24px 30px;">${code}</td></tr></table></td></tr></table>`;
}

export function buttonBlock(url: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="${url}" style="display:inline-block;padding:16px 30px;background:${ACCENT};color:#ffffff;font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;border-radius:10px;">${label}</a></td></tr></table>`;
}

export function secondaryButtonBlock(url: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="${url}" style="display:inline-block;padding:15px 28px;background:transparent;color:${ACCENT};font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;border-radius:10px;border:1px solid ${ACCENT};">${label}</a></td></tr></table>`;
}

export const EMAIL_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {
  signup_otp: (logo, imageBase) => tpl(
    'Your Tirbeo verification code is {{otp}}',
    `${head('Verify Your Email')}${headerHtml(logo, 'Verify your email', 'Complete your account setup securely.')}${bodyStart()}${heroImg(imageBase, 'email-verification')}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Use the verification code below to activate your Tirbeo account. This code expires in <strong style="color:${INK};">10 minutes</strong>.</p>${otpCodeBlock('{{otp}}')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not request this verification, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  login_otp: (logo) => tpl(
    'Your Tirbeo login code is {{otp}}',
    `${head('Your Login Code')}${headerHtml(logo, 'Your login code', 'Use this code to sign in to your account.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Here is your login verification code. It expires in <strong style="color:${INK};">10 minutes</strong>.</p>${otpCodeBlock('{{otp}}')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not request this login, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  welcome: (logo, imageBase) => tpl(
    'Welcome to Tirbeo, {{name}}!',
    `${head('Welcome to Tirbeo')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:50px 20px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${CARD};border:2px solid ${INK};border-radius:0;overflow:hidden;box-shadow:${SHADOW};"><tr><td align="center" style="padding:56px 40px;border-bottom:2px solid #17150f;">${logo ? `<img src="${logo}" width="60" alt="Tirbeo" style="display:block;margin:0 auto 20px;">` : `<span style="display:inline-block;width:40px;height:40px;border-radius:0;background:${ACCENT};font-weight:700;color:#ffffff;font-size:18px;line-height:40px;text-align:center;">T</span>`}<h1 style="margin:0;color:${INK};font-size:34px;font-weight:700;">Welcome to Tirbeo</h1><p style="margin:18px 0 0;color:${INK};font-size:17px;line-height:30px;">Your workspace is ready. Let us build something amazing together.</p></td></tr>${heroImg(imageBase, 'account-created')}<tr><td style="padding:48px 40px;background:${CARD};"><p style="margin:0;color:${INK};font-size:20px;font-weight:600;">Hi {{name}},</p><p style="margin:22px 0;color:${INK};font-size:16px;line-height:30px;">Thanks for joining <strong style="color:${INK};">Tirbeo</strong>. Your account has been created successfully and you are ready to start exploring everything our platform has to offer.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px;border:1px solid ${BORDER};border-radius:0;"><p style="margin:0;font-size:15px;color:${INK};font-weight:600;">Explore Communities</p><p style="margin:10px 0 0;color:${INK};font-size:14px;line-height:24px;">Discover discussions and connect with people who share your interests.</p></td></tr></table>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">Questions? Visit our <a href="https://tirbeo.app/help" style="color:${INK};text-decoration:underline;">Help Center</a></p></td></tr>${footerHtml('{{founder_signature}}')}`
  ),

  password_reset_otp: (logo) => tpl(
    'Your Tirbeo password reset code is {{otp}}',
    `${head('Reset Your Password')}${headerHtml(logo, 'Reset your password', 'Use the code below to reset your password.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">We received a request to reset the password for your Tirbeo account. Use the code below to reset your password. This code expires in <strong style="color:${INK};">15 minutes</strong>.</p>${otpCodeBlock('{{otp}}')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not request this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  password_reset_link: (logo) => tpl(
    'Reset your Tirbeo password',
    `${head('Reset Your Password')}${headerHtml(logo, 'Reset your password', 'Click the link below to securely reset your password.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">We received a request to reset the password for your Tirbeo account. Click the button below to reset it. This link expires in <strong style="color:${INK};">15 minutes</strong>.</p>${buttonBlock('{{resetUrl}}', 'Reset Password')}<p style="margin:32px 0 0;font-size:14px;line-height:24px;color:${INK};">If the button does not work, copy and paste this link:</p><p style="font-size:13px;line-height:20px;color:${INK};word-break:break-all;">{{resetUrl}}</p>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not request this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  verify_email: (logo, imageBase) => tpl(
    'Verify your Tirbeo email',
    `${head('Verify Your Email')}${headerHtml(logo, 'Verify your email', 'Confirm your email address securely.')}${bodyStart()}${heroImg(imageBase, 'email-verification')}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Your verification code:</p>${otpCodeBlock('{{otp}}')}<p style="margin:28px 0 0;font-size:15px;line-height:26px;color:${INK};">This code expires in 10 minutes.</p>${bodyEnd()}${footerHtml()}`
  ),

  magic_link: (logo) => tpl(
    'Sign in to Tirbeo',
    `${head('Sign in to Tirbeo')}${headerHtml(logo, 'Sign in to Tirbeo', 'One click and you are in.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hi {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Click the button below to sign in to your Tirbeo account. This link expires in <strong style="color:${INK};">15 minutes</strong>.</p>${buttonBlock('{{magicLink}}', 'Sign In to Tirbeo')}<p style="margin:32px 0 0;font-size:14px;line-height:24px;color:${INK};">If the button does not work, copy and paste this link into your browser:</p><p style="margin:8px 0 0;font-size:13px;line-height:20px;color:${INK};word-break:break-all;">{{magicLink}}</p>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not request this, you can safely ignore it.</p>${bodyEnd()}${footerHtml()}`
  ),

    account_recovery: (logo) => tpl(
    'Reset your Tirbeo account',
    `${head('Account Recovery')}${headerHtml(logo, 'Account recovery', 'Use the link below to recover your account.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">We received a request to recover your Tirbeo account. Click the button below to set a new password. This link expires in <strong style="color:${INK};">15 minutes</strong>.</p>${buttonBlock('{{recoveryUrl}}', 'Recover Account')}<p style="margin:32px 0 0;font-size:13px;line-height:20px;color:${INK};">If the button does not work, copy and paste this link into your browser:</p><p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${INK};word-break:break-all;">{{recoveryUrl}}</p>${divider()}<p style="margin:0;font-size:13px;line-height:22px;color:${INK};">If you did not request this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),
  password_changed: (logo) => tpl(
    'Your Tirbeo password was changed',
    `${head('Password Changed')}${headerHtml(logo, 'Password changed', 'Your password was updated successfully.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your Tirbeo password was changed successfully.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Time:</strong> {{changedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">IP:</strong> {{ipAddress}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:${INK};">If you did not make this change, please reset your password immediately or contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  suspicious_login: (logo, imageBase) => tpl(
    'Suspicious login detected on your Tirbeo account',
    `${head('Security Alert')}${headerHtml(logo, 'Suspicious login detected', 'We noticed a sign-in from an unusual location.')}${bodyStart()}${heroImg(imageBase, 'suspicious-login')}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">We noticed a sign-in to your Tirbeo account from an unusual location or device.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Time:</strong> {{loginTime}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">IP:</strong> {{ipAddress}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:${INK};">If this was you, you can ignore this alert. If not, please secure your account immediately.</p>${buttonBlock('{{revokeUrl}}', 'Review Sessions')}${bodyEnd()}${footerHtml()}`
  ),

  login_alert: (logo, imageBase) => tpl(
    'New sign-in to your Tirbeo account',
    `${head('New Sign-in')}${headerHtml(logo, 'New sign-in detected', 'A new sign-in was detected on your account.')}${bodyStart()}${heroImg(imageBase, 'new-device')}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">A new sign-in was detected on your Tirbeo account. If this was you, you can ignore this email.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:20px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Time:</strong> {{loginTime}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:${INK};">If this was not you, please change your password immediately and review your active sessions.</p>${buttonBlock('{{revokeUrl}}', 'Review Sessions')}${bodyEnd()}${footerHtml()}`
  ),

  admin_alert: (logo) => tpl(
    '[Admin] {{subject}}',
    `${head('Admin Alert')}${headerHtml(logo, 'Admin Alert', '{{subject}}')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello Admin,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">{{message}}</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;">{{details}}</div>${buttonBlock('{{dashboardUrl}}', 'View Admin Dashboard')}${divider()}<p style="margin:0;font-size:13px;line-height:22px;color:${INK};">This is an automated alert from Tirbeo. Do not reply to this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  system_alert: (logo) => tpl(
    '[System] {{subject}}',
    `${head('System Alert')}${headerHtml(logo, 'System Alert', '{{message}}')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">{{message}}</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Service:</strong> {{service}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Time:</strong> {{alertTime}}</p></div>${bodyEnd()}${footerHtml()}`
  ),

  invoice: (logo) => tpl(
    'Your Tirbeo receipt — {{plan}}',
    `${head('Receipt')}${headerHtml(logo, 'Receipt', 'Thank you for your payment.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Thank you for your payment, {{name}}.</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:${INK};">Plan</td><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:${INK};font-weight:600;text-align:right;">{{plan}}</td></tr><tr><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:${INK};">Amount</td><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:${INK};font-weight:600;text-align:right;">{{amount}}</td></tr><tr><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:${INK};">Date</td><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:${INK};font-weight:600;text-align:right;">{{date}}</td></tr></table>${bodyEnd()}${footerHtml()}`
  ),

  form_submission_confirmation: (logo) => tpl(
    'Your response to {{formTitle}} was recorded',
    `${head('Response Recorded')}${headerHtml(logo, 'Your response was recorded', 'Thank you for submitting the form.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{respondentName}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Thank you for submitting <strong style="color:${INK};">{{formTitle}}</strong>. Your response has been recorded successfully.</p>${buttonBlock('{{formUrl}}', 'View Form')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not submit this form, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_response: (logo) => tpl(
    'New response to "{{formTitle}}"',
    `${head('New Form Response')}${headerHtml(logo, 'New Form Response', 'A new response was submitted to your form.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">A new response has been submitted to your form <strong style="color:${INK};">{{formTitle}}</strong>.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Respondent:</strong> {{respondentName}} ({{respondentEmail}})</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Submitted:</strong> {{submittedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Response ID:</strong> {{responseId}}</p></div><h2 style="font-size:16px;color:${INK};margin:16px 0 8px;">Responses</h2><div style="margin:16px 0;">{{answers}}</div>${buttonBlock('{{adminUrl}}', 'View in Admin')}${bodyEnd()}${footerHtml()}`
  ),

  form_notification: (logo) => tpl(
    'New form submission: {{formTitle}}',
    `${head('New Form Submission')}${headerHtml(logo, 'New submission', 'A new submission was received.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">A new submission was received for <strong style="color:${INK};">{{formTitle}}</strong>.</p>{{submissionData}}${buttonBlock('{{formUrl}}', 'View Submission')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">This is an automated notification from Tirbeo Forms.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_flagged: (logo) => tpl(
    'Your form "{{formTitle}}" was flagged',
    `${head('Form Flagged')}${headerHtml(logo, 'Your form was flagged', 'A security review flagged activity on your form.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Our automated security review flagged suspicious activity on your form <strong style="color:${INK};">{{formTitle}}</strong>. While the flag is active, visitors may be asked to verify they are human or access may be temporarily restricted.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Ray ID:</strong> {{rayId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Reason:</strong> {{reason}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Flagged at:</strong> {{flaggedAt}}</p></div><p style="margin:0 0 28px;font-size:14px;line-height:24px;color:${INK};">If you believe this was a mistake, you can appeal by replying to this email or contacting support.</p>${buttonBlock('{{adminUrl}}', 'View Flag Details')}${divider()}<p style="margin:0;font-size:13px;line-height:22px;color:${INK};">This is an automated notification from Tirbeo Security. Do not reply to this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_published: (logo) => tpl(
    'Your form "{{formTitle}}" is now live',
    `${head('Form Published')}${headerHtml(logo, 'Form is now live', 'Your form is accepting responses.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your form <strong style="color:${INK};">{{formTitle}}</strong> has been published and is now accepting responses.</p>${buttonBlock('{{formUrl}}', 'View Form')}${bodyEnd()}${footerHtml()}`
  ),

  form_closed: (logo) => tpl(
    'Your form "{{formTitle}}" has been closed',
    `${head('Form Closed')}${headerHtml(logo, 'Form closed', 'Your form is no longer accepting responses.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your form <strong style="color:${INK};">{{formTitle}}</strong> has been closed and is no longer accepting responses.</p><p style="margin:0;font-size:14px;line-height:24px;color:${INK};">You can reopen it anytime from your dashboard.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_deleted: (logo) => tpl(
    'Your form "{{formTitle}}" has been deleted',
    `${head('Form Deleted')}${headerHtml(logo, 'Form deleted', 'Your form has been permanently deleted.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your form <strong style="color:${INK};">{{formTitle}}</strong> has been permanently deleted.</p><p style="margin:0;font-size:14px;line-height:24px;color:${INK};">This action cannot be undone. If this was a mistake, please contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_archived: (logo) => tpl(
    'Your form "{{formTitle}}" has been archived',
    `${head('Form Archived')}${headerHtml(logo, 'Form archived', 'Your form has been archived.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your form <strong style="color:${INK};">{{formTitle}}</strong> has been archived.</p><p style="margin:0;font-size:14px;line-height:24px;color:${INK};">Archived forms are hidden from your dashboard but can be restored anytime.</p>${bodyEnd()}${footerHtml()}`
  ),

  response_updated: (logo) => tpl(
    'A response to "{{formTitle}}" was updated',
    `${head('Response Updated')}${headerHtml(logo, 'Response updated', 'A form response was modified.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">A response to your form <strong style="color:${INK};">{{formTitle}}</strong> was updated.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Updated at:</strong> {{updatedAt}}</p></div>${bodyEnd()}${footerHtml()}`
  ),

  response_deleted: (logo) => tpl(
    'A response to "{{formTitle}}" was deleted',
    `${head('Response Deleted')}${headerHtml(logo, 'Response deleted', 'A form response was removed.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">A response to your form <strong style="color:${INK};">{{formTitle}}</strong> was deleted.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Deleted at:</strong> {{deletedAt}}</p></div>${bodyEnd()}${footerHtml()}`
  ),

  ticket_created: (logo) => tpl(
    'Support ticket opened: {{ticketSubject}}',
    `${head('Support Ticket Opened')}${headerHtml(logo, 'Support ticket opened', 'Your support ticket has been created.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your support ticket has been created.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Ticket:</strong> {{ticketId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Subject:</strong> {{ticketSubject}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Status:</strong> {{ticketStatus}}</p></div>${buttonBlock('{{ticketUrl}}', 'View Ticket')}${bodyEnd()}${footerHtml()}`
  ),

  ticket_updated: (logo) => tpl(
    'Update on your support ticket {{ticketId}}',
    `${head('Ticket Updated')}${headerHtml(logo, 'Ticket updated', 'Your support ticket has a new update.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your support ticket <strong style="color:${INK};">{{ticketId}}</strong> has been updated.</p><p style="margin:0;font-size:16px;line-height:28px;color:${INK};">{{updateMessage}}</p>${buttonBlock('{{ticketUrl}}', 'View Ticket')}${bodyEnd()}${footerHtml()}`
  ),

  ticket_closed: (logo) => tpl(
    'Your support ticket {{ticketId}} has been closed',
    `${head('Ticket Closed')}${headerHtml(logo, 'Ticket closed', 'Your support ticket has been resolved.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your support ticket <strong style="color:${INK};">{{ticketId}}</strong> has been closed.</p><p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you still need help, feel free to open a new ticket.</p>${bodyEnd()}${footerHtml()}`
  ),

  notification_digest: (logo) => tpl(
    'Your Tirbeo digest — {{count}} new updates',
    `${head('Your Tirbeo Digest')}${headerHtml(logo, 'Your Digest', 'You have <strong style="color:${INK};">{{count}}</strong> new updates.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Here is what is new since your last visit:</p>{{digestItems}}${buttonBlock('{{dashboardUrl}}', 'View All Updates')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">You received this email because you have notifications enabled. <a href="{{dashboardUrl}}/settings/notifications" style="color:${INK};text-decoration:underline;">Manage preferences</a></p>${bodyEnd()}${footerHtml()}`
  ),

  admin_account_created: (logo) => tpl(
    'Your admin account has been created',
    `${head('Admin Account Created')}${headerHtml(logo, 'Admin Account', 'Your admin account is ready.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">An admin account has been created for you with <strong style="color:${INK};">{{adminRole}}</strong> access. Use the temporary password below to sign in. For security, you will be asked to set a new password the first time you sign in.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Temporary password:</strong></p><p style="margin:8px 0 0;font-size:18px;letter-spacing:1px;color:${INK};">{{temporaryPassword}}</p></div>${buttonBlock('{{loginUrl}}', 'Sign In')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you did not expect this email, contact your administrator immediately.</p>${bodyEnd()}${footerHtml()}`
  ),

  admin_request_received: (logo) => tpl(
    'Your admin request has been received',
    `${head('Admin Request Received')}${headerHtml(logo, 'Admin Request', 'Your request has been received and is under review.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">We have received your admin access request for <strong style="color:${INK};">{{companyName}}</strong>. Our team is reviewing your request and will respond within 1 business day.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Request ID:</strong> {{requestId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Role:</strong> {{requestedRole}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Submitted:</strong> {{submittedAt}}</p></div>${buttonBlock('{{dashboardUrl}}', 'View Request')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">You will receive an email when your request has been reviewed.</p>${bodyEnd()}${footerHtml()}`
  ),

  admin_request_approved: (logo) => tpl(
    'Your admin request has been approved',
    `${head('Admin Request Approved')}${headerHtml(logo, 'Admin Request', 'Your admin access has been approved.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your admin access request for <strong style="color:${INK};">{{companyName}}</strong> has been approved. You now have <strong style="color:${INK};">{{requestedRole}}</strong> access.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Request ID:</strong> {{requestId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Role:</strong> {{requestedRole}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Approved by:</strong> {{approvedBy}}</p></div>${buttonBlock('{{dashboardUrl}}', 'Go to Dashboard')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">Welcome to the admin team. If you have any questions, contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  admin_request_rejected: (logo) => tpl(
    'Your admin request has been declined',
    `${head('Admin Request Declined')}${headerHtml(logo, 'Admin Request', 'Your admin access request has been reviewed.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:${INK};">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:${INK};">Your admin access request for <strong style="color:${INK};">{{companyName}}</strong> has been declined. You can submit a new request at any time.</p><div style="border:1px solid ${BORDER};border-radius:0;box-shadow:none;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:${INK};"><strong style="color:${INK};">Request ID:</strong> {{requestId}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Role:</strong> {{requestedRole}}</p><p style="margin:8px 0 0;font-size:14px;color:${INK};"><strong style="color:${INK};">Reason:</strong> {{rejectionReason}}</p></div>${buttonBlock('{{dashboardUrl}}', 'Submit New Request')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:${INK};">If you believe this was a mistake, please contact support.</p>${bodyEnd()}${footerHtml()}`
  ),
};

export function buildTemplates(logoUrl: string = '', imageBase: string = DEFAULT_IMAGE_BASE): Record<string, EmailTemplate> {
  const logo = logoUrl || '';
  const result: Record<string, EmailTemplate> = {};
  for (const [key, fn] of Object.entries(EMAIL_TEMPLATES)) {
    result[key] = fn(logo, imageBase);
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
