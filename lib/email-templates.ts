export type EmailTemplate = { subject: string; html: string };

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

// ─── TIRBEO paper/ink neobrutalist palette (matches the landing + accounts theme) ───
const PAPER = '#f6f3ea';     // page background
const CARD = '#ffffff';      // card / surface
const INK = '#17150f';       // text + borders
const YELLOW = '#ffd93d';    // accent (buttons, highlights)
const MUTED = '#4b4639';     // secondary text
const SHADOW = '4px 4px 0 0 #17150f';

function head(title: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>@media only screen and (max-width:600px){body{padding:24px 16px !important;}.container{padding:24px !important;}h1{font-size:24px !important;}}</style></head><body style="margin:0;padding:0;background:${PAPER};font-family:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${INK};-webkit-font-smoothing:antialiased;">`;
}

function headerHtml(logo: string, title: string, subtitle: string): string {
  const logoHtml = logo
    ? `<img src="${logo}" width="44" alt="Tirbeo" style="display:block;margin:0 auto 18px;border:2px solid ${INK};border-radius:0;">`
    : `<span style="display:inline-block;width:44px;height:44px;border:2px solid ${INK};border-radius:0;background:${INK};font-weight:800;color:${PAPER};font-size:20px;line-height:40px;text-align:center;">T</span>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:50px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:${CARD};border:2px solid ${INK};border-radius:0;box-shadow:${SHADOW};"><tr><td style="padding:48px 48px 40px;text-align:center;border-bottom:2px solid ${INK};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><p style="margin:0 0 14px;font-size:11px;font-weight:800;letter-spacing:.22em;color:${INK};text-transform:uppercase;">Tirbeo</p>${logoHtml}</td></tr><tr><td align="center"><h1 style="margin:0;font-size:30px;font-weight:800;color:${INK};letter-spacing:-.02em;">${title}</h1><p style="margin:14px 0 0;font-size:15px;line-height:26px;color:${MUTED};">${subtitle}</p></td></tr></table></td></tr>`;
}

function footerHtml(signature: string = ''): string {
  const sigHtml = signature
    ? `<p style="margin:14px 0 0;font-size:12px;color:${MUTED};line-height:20px;">${signature}</p>`
    : '';
  return `<tr><td style="padding:32px 48px;background:${CARD};text-align:center;border-top:2px solid ${INK};"><p style="margin:0;font-size:11px;font-weight:800;letter-spacing:.22em;color:${INK};text-transform:uppercase;">Tirbeo</p><p style="margin:12px 0 0;font-size:12px;color:${MUTED};line-height:20px;">&copy; 2026 Tirbeo Inc.<br><a href="https://tirbeo.app/privacy" style="color:${INK};text-decoration:underline;font-weight:600;">Privacy Policy</a> &middot; <a href="https://tirbeo.app/terms" style="color:${INK};text-decoration:underline;font-weight:600;">Terms</a> &middot; <a href="https://tirbeo.app/settings/emails" style="color:${INK};text-decoration:underline;font-weight:600;">Manage Email Preferences</a></p>${sigHtml}</td></tr></table></td></tr></table></body></html>`;
}

function bodyStart(): string {
  return `<tr><td style="padding:32px 48px;background:${CARD};">`;
}

function bodyEnd(): string {
  return `</td></tr>`;
}

function divider(): string {
  return `<div style="margin:32px 0;height:2px;background:${INK};"></div>`;
}

const DEFAULT_IMAGE_BASE = 'https://api.tirbeo.app/image';

function heroImg(imageBase: string, name: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CARD};"><tr><td align="center" style="padding:36px 48px 0;background:${CARD};"><img src="${imageBase}/${name}.png" width="100%" alt="" style="max-width:480px;width:100%;height:auto;display:block;margin:0 auto;border-radius:0;border:2px solid ${INK};box-shadow:${SHADOW};"></td></tr></table>`;
}

export function otpCodeBlock(code: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="font-size:30px;font-weight:800;letter-spacing:10px;color:${INK};font-family:monospace;background:${CARD};border:2px solid ${INK};border-radius:0;box-shadow:${SHADOW};padding:24px 30px;">${code}</td></tr></table></td></tr></table>`;
}

export function buttonBlock(url: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="${url}" style="display:inline-block;padding:16px 30px;background:${YELLOW};color:${INK};font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;border-radius:0;border:2px solid ${INK};box-shadow:${SHADOW};">${label}</a></td></tr></table>`;
}

export function secondaryButtonBlock(url: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><a href="${url}" style="display:inline-block;padding:15px 28px;background:${CARD};color:${INK};font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;text-decoration:none;border-radius:0;border:2px solid ${INK};">${label}</a></td></tr></table>`;
}

export const EMAIL_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {
  signup_otp: (logo, imageBase) => tpl(
    'Your Tirbeo verification code is {{otp}}',
    `${head('Verify Your Email')}${headerHtml(logo, 'Verify your email', 'Complete your account setup securely.')}${bodyStart()}${heroImg(imageBase, 'email-verification')}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Use the verification code below to activate your Tirbeo account. This code expires in <strong style="color:#17150f;">10 minutes</strong>.</p>${otpCodeBlock('{{otp}}')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not request this verification, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  login_otp: (logo) => tpl(
    'Your Tirbeo login code is {{otp}}',
    `${head('Your Login Code')}${headerHtml(logo, 'Your login code', 'Use this code to sign in to your account.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Here is your login verification code. It expires in <strong style="color:#17150f;">10 minutes</strong>.</p>${otpCodeBlock('{{otp}}')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not request this login, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  welcome: (logo, imageBase) => tpl(
    'Welcome to Tirbeo, {{name}}!',
    `${head('Welcome to Tirbeo')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:50px 20px;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:${CARD};border:2px solid ${INK};border-radius:0;overflow:hidden;box-shadow:${SHADOW};"><tr><td align="center" style="padding:56px 40px;border-bottom:2px solid #17150f;">${logo ? `<img src="${logo}" width="60" alt="Tirbeo" style="display:block;margin:0 auto 20px;">` : `<span style="display:inline-block;width:40px;height:40px;border-radius:0;background:#17150f;font-weight:700;color:#f6f3ea;font-size:18px;line-height:40px;text-align:center;">T</span>`}<h1 style="margin:0;color:#17150f;font-size:34px;font-weight:700;">Welcome to Tirbeo</h1><p style="margin:18px 0 0;color:#17150f;font-size:17px;line-height:30px;">Your workspace is ready. Let us build something amazing together.</p></td></tr>${heroImg(imageBase, 'account-created')}<tr><td style="padding:48px 40px;background:#ffffff;"><p style="margin:0;color:#17150f;font-size:20px;font-weight:600;">Hi {{name}},</p><p style="margin:22px 0;color:#17150f;font-size:16px;line-height:30px;">Thanks for joining <strong style="color:#17150f;">Tirbeo</strong>. Your account has been created successfully and you are ready to start exploring everything our platform has to offer.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px;border:2px solid #17150f;border-radius:0;"><p style="margin:0;font-size:15px;color:#17150f;font-weight:600;">Explore Communities</p><p style="margin:10px 0 0;color:#17150f;font-size:14px;line-height:24px;">Discover discussions and connect with people who share your interests.</p></td></tr></table>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Questions? Visit our <a href="https://tirbeo.app/help" style="color:#17150f;text-decoration:underline;">Help Center</a></p></td></tr>${footerHtml('{{founder_signature}}')}`
  ),

  password_reset_otp: (logo) => tpl(
    'Your Tirbeo password reset code is {{otp}}',
    `${head('Reset Your Password')}${headerHtml(logo, 'Reset your password', 'Use the code below to reset your password.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">We received a request to reset the password for your Tirbeo account. Use the code below to reset your password. This code expires in <strong style="color:#17150f;">15 minutes</strong>.</p>${otpCodeBlock('{{otp}}')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not request this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  password_reset_link: (logo) => tpl(
    'Reset your Tirbeo password',
    `${head('Reset Your Password')}${headerHtml(logo, 'Reset your password', 'Click the link below to securely reset your password.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">We received a request to reset the password for your Tirbeo account. Click the button below to reset it. This link expires in <strong style="color:#17150f;">15 minutes</strong>.</p>${buttonBlock('{{resetUrl}}', 'Reset Password')}<p style="margin:32px 0 0;font-size:14px;line-height:24px;color:#17150f;">If the button does not work, copy and paste this link:</p><p style="font-size:13px;line-height:20px;color:#17150f;word-break:break-all;">{{resetUrl}}</p>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not request this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  verify_email: (logo, imageBase) => tpl(
    'Verify your Tirbeo email',
    `${head('Verify Your Email')}${headerHtml(logo, 'Verify your email', 'Confirm your email address securely.')}${bodyStart()}${heroImg(imageBase, 'email-verification')}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Your verification code:</p>${otpCodeBlock('{{otp}}')}<p style="margin:28px 0 0;font-size:15px;line-height:26px;color:#17150f;">This code expires in 10 minutes.</p>${bodyEnd()}${footerHtml()}`
  ),

  magic_link: (logo) => tpl(
    'Sign in to Tirbeo',
    `${head('Sign in to Tirbeo')}${headerHtml(logo, 'Sign in to Tirbeo', 'One click and you are in.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hi {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Click the button below to sign in to your Tirbeo account. This link expires in <strong style="color:#17150f;">15 minutes</strong>.</p>${buttonBlock('{{magicLink}}', 'Sign In to Tirbeo')}<p style="margin:32px 0 0;font-size:14px;line-height:24px;color:#17150f;">If the button does not work, copy and paste this link into your browser:</p><p style="margin:8px 0 0;font-size:13px;line-height:20px;color:#17150f;word-break:break-all;">{{magicLink}}</p>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not request this, you can safely ignore it.</p>${bodyEnd()}${footerHtml()}`
  ),

    account_recovery: (logo) => tpl(
    'Reset your Tirbeo account',
    `${head('Account Recovery')}${headerHtml(logo, 'Account recovery', 'Use the link below to recover your account.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">We received a request to recover your Tirbeo account. Click the button below to set a new password. This link expires in <strong style="color:#17150f;">15 minutes</strong>.</p>${buttonBlock('{{recoveryUrl}}', 'Recover Account')}<p style="margin:32px 0 0;font-size:13px;line-height:20px;color:#17150f;">If the button does not work, copy and paste this link into your browser:</p><p style="margin:8px 0 0;font-size:12px;line-height:18px;color:#17150f;word-break:break-all;">{{recoveryUrl}}</p>${divider()}<p style="margin:0;font-size:13px;line-height:22px;color:#17150f;">If you did not request this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),
  password_changed: (logo) => tpl(
    'Your Tirbeo password was changed',
    `${head('Password Changed')}${headerHtml(logo, 'Password changed', 'Your password was updated successfully.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your Tirbeo password was changed successfully.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Time:</strong> {{changedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">IP:</strong> {{ipAddress}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:#17150f;">If you did not make this change, please reset your password immediately or contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  suspicious_login: (logo, imageBase) => tpl(
    'Suspicious login detected on your Tirbeo account',
    `${head('Security Alert')}${headerHtml(logo, 'Suspicious login detected', 'We noticed a sign-in from an unusual location.')}${bodyStart()}${heroImg(imageBase, 'suspicious-login')}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">We noticed a sign-in to your Tirbeo account from an unusual location or device.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Time:</strong> {{loginTime}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">IP:</strong> {{ipAddress}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:#17150f;">If this was you, you can ignore this alert. If not, please secure your account immediately.</p>${buttonBlock('{{revokeUrl}}', 'Review Sessions')}${bodyEnd()}${footerHtml()}`
  ),

  login_alert: (logo, imageBase) => tpl(
    'New sign-in to your Tirbeo account',
    `${head('New Sign-in')}${headerHtml(logo, 'New sign-in detected', 'A new sign-in was detected on your account.')}${bodyStart()}${heroImg(imageBase, 'new-device')}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">A new sign-in was detected on your Tirbeo account. If this was you, you can ignore this email.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:20px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Location:</strong> {{location}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Device:</strong> {{device}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Time:</strong> {{loginTime}}</p></div><p style="margin:20px 0 0;font-size:14px;line-height:24px;color:#17150f;">If this was not you, please change your password immediately and review your active sessions.</p>${buttonBlock('{{revokeUrl}}', 'Review Sessions')}${bodyEnd()}${footerHtml()}`
  ),

  admin_alert: (logo) => tpl(
    '[Admin] {{subject}}',
    `${head('Admin Alert')}${headerHtml(logo, 'Admin Alert', '{{subject}}')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello Admin,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">{{message}}</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;">{{details}}</div>${buttonBlock('{{dashboardUrl}}', 'View Admin Dashboard')}${divider()}<p style="margin:0;font-size:13px;line-height:22px;color:#17150f;">This is an automated alert from Tirbeo. Do not reply to this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  system_alert: (logo) => tpl(
    '[System] {{subject}}',
    `${head('System Alert')}${headerHtml(logo, 'System Alert', '{{message}}')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">{{message}}</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Service:</strong> {{service}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Time:</strong> {{alertTime}}</p></div>${bodyEnd()}${footerHtml()}`
  ),

  invoice: (logo) => tpl(
    'Your Tirbeo receipt — {{plan}}',
    `${head('Receipt')}${headerHtml(logo, 'Receipt', 'Thank you for your payment.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Thank you for your payment, {{name}}.</p><table style="width:100%;border-collapse:collapse;margin:16px 0;"><tr><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:#17150f;">Plan</td><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:#17150f;font-weight:600;text-align:right;">{{plan}}</td></tr><tr><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:#17150f;">Amount</td><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:#17150f;font-weight:600;text-align:right;">{{amount}}</td></tr><tr><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:#17150f;">Date</td><td style="padding:10px 0;border-bottom:2px solid #17150f;font-size:14px;color:#17150f;font-weight:600;text-align:right;">{{date}}</td></tr></table>${bodyEnd()}${footerHtml()}`
  ),

  form_submission_confirmation: (logo) => tpl(
    'Your response to {{formTitle}} was recorded',
    `${head('Response Recorded')}${headerHtml(logo, 'Your response was recorded', 'Thank you for submitting the form.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{respondentName}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Thank you for submitting <strong style="color:#17150f;">{{formTitle}}</strong>. Your response has been recorded successfully.</p>${buttonBlock('{{formUrl}}', 'View Form')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not submit this form, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_response: (logo) => tpl(
    'New response to "{{formTitle}}"',
    `${head('New Form Response')}${headerHtml(logo, 'New Form Response', 'A new response was submitted to your form.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">A new response has been submitted to your form <strong style="color:#17150f;">{{formTitle}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Respondent:</strong> {{respondentName}} ({{respondentEmail}})</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Submitted:</strong> {{submittedAt}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Response ID:</strong> {{responseId}}</p></div><h2 style="font-size:16px;color:#17150f;margin:16px 0 8px;">Responses</h2><div style="margin:16px 0;">{{answers}}</div>${buttonBlock('{{adminUrl}}', 'View in Admin')}${bodyEnd()}${footerHtml()}`
  ),

  form_notification: (logo) => tpl(
    'New form submission: {{formTitle}}',
    `${head('New Form Submission')}${headerHtml(logo, 'New submission', 'A new submission was received.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">A new submission was received for <strong style="color:#17150f;">{{formTitle}}</strong>.</p>{{submissionData}}${buttonBlock('{{formUrl}}', 'View Submission')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">This is an automated notification from Tirbeo Forms.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_flagged: (logo) => tpl(
    'Your form "{{formTitle}}" was flagged',
    `${head('Form Flagged')}${headerHtml(logo, 'Your form was flagged', 'A security review flagged activity on your form.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Our automated security review flagged suspicious activity on your form <strong style="color:#17150f;">{{formTitle}}</strong>. While the flag is active, visitors may be asked to verify they are human or access may be temporarily restricted.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Ray ID:</strong> {{rayId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Reason:</strong> {{reason}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Flagged at:</strong> {{flaggedAt}}</p></div><p style="margin:0 0 28px;font-size:14px;line-height:24px;color:#17150f;">If you believe this was a mistake, you can appeal by replying to this email or contacting support.</p>${buttonBlock('{{adminUrl}}', 'View Flag Details')}${divider()}<p style="margin:0;font-size:13px;line-height:22px;color:#17150f;">This is an automated notification from Tirbeo Security. Do not reply to this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_published: (logo) => tpl(
    'Your form "{{formTitle}}" is now live',
    `${head('Form Published')}${headerHtml(logo, 'Form is now live', 'Your form is accepting responses.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your form <strong style="color:#17150f;">{{formTitle}}</strong> has been published and is now accepting responses.</p>${buttonBlock('{{formUrl}}', 'View Form')}${bodyEnd()}${footerHtml()}`
  ),

  form_closed: (logo) => tpl(
    'Your form "{{formTitle}}" has been closed',
    `${head('Form Closed')}${headerHtml(logo, 'Form closed', 'Your form is no longer accepting responses.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your form <strong style="color:#17150f;">{{formTitle}}</strong> has been closed and is no longer accepting responses.</p><p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">You can reopen it anytime from your dashboard.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_deleted: (logo) => tpl(
    'Your form "{{formTitle}}" has been deleted',
    `${head('Form Deleted')}${headerHtml(logo, 'Form deleted', 'Your form has been permanently deleted.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your form <strong style="color:#17150f;">{{formTitle}}</strong> has been permanently deleted.</p><p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">This action cannot be undone. If this was a mistake, please contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  form_archived: (logo) => tpl(
    'Your form "{{formTitle}}" has been archived',
    `${head('Form Archived')}${headerHtml(logo, 'Form archived', 'Your form has been archived.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your form <strong style="color:#17150f;">{{formTitle}}</strong> has been archived.</p><p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Archived forms are hidden from your dashboard but can be restored anytime.</p>${bodyEnd()}${footerHtml()}`
  ),

  response_updated: (logo) => tpl(
    'A response to "{{formTitle}}" was updated',
    `${head('Response Updated')}${headerHtml(logo, 'Response updated', 'A form response was modified.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">A response to your form <strong style="color:#17150f;">{{formTitle}}</strong> was updated.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Updated at:</strong> {{updatedAt}}</p></div>${bodyEnd()}${footerHtml()}`
  ),

  response_deleted: (logo) => tpl(
    'A response to "{{formTitle}}" was deleted',
    `${head('Response Deleted')}${headerHtml(logo, 'Response deleted', 'A form response was removed.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">A response to your form <strong style="color:#17150f;">{{formTitle}}</strong> was deleted.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Response ID:</strong> {{responseId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Deleted at:</strong> {{deletedAt}}</p></div>${bodyEnd()}${footerHtml()}`
  ),

  ticket_created: (logo) => tpl(
    'Support ticket opened: {{ticketSubject}}',
    `${head('Support Ticket Opened')}${headerHtml(logo, 'Support ticket opened', 'Your support ticket has been created.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your support ticket has been created.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Ticket:</strong> {{ticketId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Subject:</strong> {{ticketSubject}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Status:</strong> {{ticketStatus}}</p></div>${buttonBlock('{{ticketUrl}}', 'View Ticket')}${bodyEnd()}${footerHtml()}`
  ),

  ticket_updated: (logo) => tpl(
    'Update on your support ticket {{ticketId}}',
    `${head('Ticket Updated')}${headerHtml(logo, 'Ticket updated', 'Your support ticket has a new update.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your support ticket <strong style="color:#17150f;">{{ticketId}}</strong> has been updated.</p><p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">{{updateMessage}}</p>${buttonBlock('{{ticketUrl}}', 'View Ticket')}${bodyEnd()}${footerHtml()}`
  ),

  ticket_closed: (logo) => tpl(
    'Your support ticket {{ticketId}} has been closed',
    `${head('Ticket Closed')}${headerHtml(logo, 'Ticket closed', 'Your support ticket has been resolved.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your support ticket <strong style="color:#17150f;">{{ticketId}}</strong> has been closed.</p><p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you still need help, feel free to open a new ticket.</p>${bodyEnd()}${footerHtml()}`
  ),

  notification_digest: (logo) => tpl(
    'Your Tirbeo digest — {{count}} new updates',
    `${head('Your Tirbeo Digest')}${headerHtml(logo, 'Your Digest', 'You have <strong style="color:#17150f;">{{count}}</strong> new updates.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Here is what is new since your last visit:</p>{{digestItems}}${buttonBlock('{{dashboardUrl}}', 'View All Updates')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">You received this email because you have notifications enabled. <a href="{{dashboardUrl}}/settings/notifications" style="color:#17150f;text-decoration:underline;">Manage preferences</a></p>${bodyEnd()}${footerHtml()}`
  ),

  admin_request_received: (logo) => tpl(
    'Your admin request has been received',
    `${head('Admin Request Received')}${headerHtml(logo, 'Admin Request', 'Your request has been received and is under review.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">We have received your admin access request for <strong style="color:#17150f;">{{companyName}}</strong>. Our team is reviewing your request and will respond within 1 business day.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Request ID:</strong> {{requestId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{requestedRole}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Submitted:</strong> {{submittedAt}}</p></div>${buttonBlock('{{dashboardUrl}}', 'View Request')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">You will receive an email when your request has been reviewed.</p>${bodyEnd()}${footerHtml()}`
  ),

  admin_request_approved: (logo) => tpl(
    'Your admin request has been approved',
    `${head('Admin Request Approved')}${headerHtml(logo, 'Admin Request', 'Your admin access has been approved.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your admin access request for <strong style="color:#17150f;">{{companyName}}</strong> has been approved. You now have <strong style="color:#17150f;">{{requestedRole}}</strong> access.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Request ID:</strong> {{requestId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{requestedRole}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Approved by:</strong> {{approvedBy}}</p></div>${buttonBlock('{{dashboardUrl}}', 'Go to Dashboard')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Welcome to the admin team. If you have any questions, contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  admin_request_rejected: (logo) => tpl(
    'Your admin request has been declined',
    `${head('Admin Request Declined')}${headerHtml(logo, 'Admin Request', 'Your admin access request has been reviewed.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your admin access request for <strong style="color:#17150f;">{{companyName}}</strong> has been declined. You can submit a new request at any time.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Request ID:</strong> {{requestId}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{requestedRole}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Reason:</strong> {{rejectionReason}}</p></div>${buttonBlock('{{dashboardUrl}}', 'Submit New Request')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you believe this was a mistake, please contact support.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_invite: (logo) => tpl(
    'You have been invited to {{companyName}}',
    `${head('Company Invite')}${headerHtml(logo, 'Company Invite', 'You have been invited to join a team.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">You have been invited to join <strong style="color:#17150f;">{{companyName}}</strong> as <strong style="color:#17150f;">{{role}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Invited by:</strong> {{invitedBy}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{role}}</p></div>${buttonBlock('{{inviteUrl}}', 'Accept Invite')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">This invitation expires in 7 days. If you did not expect this, you can safely ignore this email.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_membership_approved: (logo) => tpl(
    'Your membership to {{companyName}} has been approved',
    `${head('Membership Approved')}${headerHtml(logo, 'Membership Approved', 'You are now a member of the team.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your membership to <strong style="color:#17150f;">{{companyName}}</strong> has been approved. You now have <strong style="color:#17150f;">{{role}}</strong> access.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{role}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Approved by:</strong> {{approvedBy}}</p></div>${buttonBlock('{{companyUrl}}', 'Go to Company')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Welcome to the team. We are glad to have you.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_membership_rejected: (logo) => tpl(
    'Your membership to {{companyName}} has been declined',
    `${head('Membership Declined')}${headerHtml(logo, 'Membership Declined', 'Your membership request has been declined.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your membership request to <strong style="color:#17150f;">{{companyName}}</strong> has been declined.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{role}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Reason:</strong> {{reason}}</p></div>${buttonBlock('{{dashboardUrl}}', 'Find New Companies')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">You can request to join other companies from your dashboard.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_invite_accepted: (logo) => tpl(
    '{{name}} accepted your company invite',
    `${head('Invite Accepted')}${headerHtml(logo, 'Invite Accepted', 'Someone accepted your company invitation.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;"><strong style="color:#17150f;">{{name}}</strong> has accepted your invitation to join <strong style="color:#17150f;">{{companyName}}</strong> as <strong style="color:#17150f;">{{role}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{role}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Accepted at:</strong> {{acceptedAt}}</p></div>${buttonBlock('{{companyUrl}}', 'View Company')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">The new member will receive a welcome email shortly.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_invite_declined: (logo) => tpl(
    '{{name}} declined your company invite',
    `${head('Invite Declined')}${headerHtml(logo, 'Invite Declined', 'Someone declined your company invitation.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;"><strong style="color:#17150f;">{{name}}</strong> has declined your invitation to join <strong style="color:#17150f;">{{companyName}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Role:</strong> {{role}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Declined at:</strong> {{declinedAt}}</p></div>${buttonBlock('{{companyUrl}}', 'View Company')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">You can invite them again or find other team members.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_member_removed: (logo) => tpl(
    'You have been removed from {{companyName}}',
    `${head('Member Removed')}${headerHtml(logo, 'Member Removed', 'You have been removed from the team.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">You have been removed from <strong style="color:#17150f;">{{companyName}}</strong> by <strong style="color:#17150f;">{{removedBy}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Removed by:</strong> {{removedBy}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Reason:</strong> {{reason}}</p></div>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you believe this was a mistake, please contact the company admin or support.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_member_role_changed: (logo) => tpl(
    'Your role in {{companyName}} has been changed',
    `${head('Role Changed')}${headerHtml(logo, 'Role Changed', 'Your role in the team has been updated.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello {{name}},</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">Your role in <strong style="color:#17150f;">{{companyName}}</strong> has been changed from <strong style="color:#17150f;">{{oldRole}}</strong> to <strong style="color:#17150f;">{{newRole}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Old Role:</strong> {{oldRole}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">New Role:</strong> {{newRole}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Changed by:</strong> {{changedBy}}</p></div>${buttonBlock('{{companyUrl}}', 'View Company')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Your access has been updated accordingly.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_billing_updated: (logo) => tpl(
    'Your company billing information has been updated',
    `${head('Billing Updated')}${headerHtml(logo, 'Billing Updated', 'Your company billing information has been changed.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The billing information for <strong style="color:#17150f;">{{companyName}}</strong> has been updated.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Updated by:</strong> {{updatedBy}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Updated at:</strong> {{updatedAt}}</p></div>${buttonBlock('{{billingUrl}}', 'View Billing')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">If you did not make this change, please contact the company admin immediately.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_plan_changed: (logo) => tpl(
    'Your company plan has been changed to {{newPlan}}',
    `${head('Plan Changed')}${headerHtml(logo, 'Plan Changed', 'Your company plan has been updated.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The plan for <strong style="color:#17150f;">{{companyName}}</strong> has been changed from <strong style="color:#17150f;">{{oldPlan}}</strong> to <strong style="color:#17150f;">{{newPlan}}</strong>.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Old Plan:</strong> {{oldPlan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">New Plan:</strong> {{newPlan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Effective Date:</strong> {{effectiveDate}}</p></div>${buttonBlock('{{billingUrl}}', 'View Plan Details')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Your team now has access to the features of the new plan.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_trial_ending: (logo) => tpl(
    'Your company trial ends in {{daysRemaining}} days',
    `${head('Trial Ending')}${headerHtml(logo, 'Trial Ending', 'Your free trial is about to end.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The free trial for <strong style="color:#17150f;">{{companyName}}</strong> ends in <strong style="color:#17150f;">{{daysRemaining}} days</strong>. Choose a plan to continue using Tirbeo.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Days Remaining:</strong> {{daysRemaining}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Current Plan:</strong> {{currentPlan}}</p></div>${buttonBlock('{{billingUrl}}', 'Choose a Plan')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Do not lose access to your data. Select a plan before your trial ends.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_trial_ended: (logo) => tpl(
    'Your company trial has ended',
    `${head('Trial Ended')}${headerHtml(logo, 'Trial Ended', 'Your free trial has ended.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The free trial for <strong style="color:#17150f;">{{companyName}}</strong> has ended. Your account has been limited until a plan is selected.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Trial Ended:</strong> {{endedAt}}</p></div>${buttonBlock('{{billingUrl}}', 'Choose a Plan')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Select a plan to restore full access to all features.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_subscription_active: (logo) => tpl(
    'Your company subscription is now active',
    `${head('Subscription Active')}${headerHtml(logo, 'Subscription Active', 'Your company plan is now active.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The subscription for <strong style="color:#17150f;">{{companyName}}</strong> is now active on the <strong style="color:#17150f;">{{plan}}</strong> plan.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Plan:</strong> {{plan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Billing Cycle:</strong> {{billingCycle}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Next Billing Date:</strong> {{nextBillingDate}}</p></div>${buttonBlock('{{billingUrl}}', 'Manage Subscription')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Thank you for your payment. Your team now has full access.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_subscription_cancelled: (logo) => tpl(
    'Your company subscription has been cancelled',
    `${head('Subscription Cancelled')}${headerHtml(logo, 'Subscription Cancelled', 'Your company subscription has been cancelled.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The subscription for <strong style="color:#17150f;">{{companyName}}</strong> has been cancelled. Access will continue until the current billing period ends.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Plan:</strong> {{plan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Cancelled At:</strong> {{cancelledAt}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Access Until:</strong> {{accessUntil}}</p></div>${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">You can reactivate your subscription anytime from the billing settings.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_subscription_expired: (logo) => tpl(
    'Your company subscription has expired',
    `${head('Subscription Expired')}${headerHtml(logo, 'Subscription Expired', 'Your company subscription has expired.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">The subscription for <strong style="color:#17150f;">{{companyName}}</strong> has expired. Your account has been limited.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Plan:</strong> {{plan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Expired On:</strong> {{expiredOn}}</p></div>${buttonBlock('{{billingUrl}}', 'Renew Subscription')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Renew your subscription to restore full access to all features.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_payment_failed: (logo) => tpl(
    'Payment failed for {{companyName}}',
    `${head('Payment Failed')}${headerHtml(logo, 'Payment Failed', 'A payment attempt was unsuccessful.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">A payment for <strong style="color:#17150f;">{{companyName}}</strong> on the <strong style="color:#17150f;">{{plan}}</strong> plan has failed.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Plan:</strong> {{plan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Amount:</strong> {{amount}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Failure Reason:</strong> {{failureReason}}</p></div>${buttonBlock('{{billingUrl}}', 'Update Payment Method')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Update your payment method to avoid service interruption.</p>${bodyEnd()}${footerHtml()}`
  ),

  company_payment_succeeded: (logo) => tpl(
    'Payment received for {{companyName}}',
    `${head('Payment Received')}${headerHtml(logo, 'Payment Received', 'Your payment has been processed successfully.')}${bodyStart()}<p style="margin:0;font-size:16px;line-height:28px;color:#17150f;">Hello,</p><p style="margin:20px 0 35px;font-size:16px;line-height:28px;color:#17150f;">A payment of <strong style="color:#17150f;">{{amount}}</strong> for <strong style="color:#17150f;">{{companyName}}</strong> on the <strong style="color:#17150f;">{{plan}}</strong> plan has been received.</p><div style="border:2px solid #17150f;border-radius:0;box-shadow:3px 3px 0 0 #17150f;padding:16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Company:</strong> {{companyName}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Plan:</strong> {{plan}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Amount:</strong> {{amount}}</p><p style="margin:8px 0 0;font-size:14px;color:#17150f;"><strong style="color:#17150f;">Payment Date:</strong> {{paymentDate}}</p></div>${buttonBlock('{{billingUrl}}', 'View Receipt')}${divider()}<p style="margin:0;font-size:14px;line-height:24px;color:#17150f;">Thank you for your payment. Your subscription is active.</p>${bodyEnd()}${footerHtml()}`
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
