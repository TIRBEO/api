export type EmailTemplate = { subject: string; html: string };

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

// ═══ PURE DARK BLACK PALETTE — white is the only real accent.
// Color (red/amber/green) is reserved strictly for danger/warning/success states. ═══
const BG = '#000000';
const SURFACE2 = '#111111';
const TEXT = '#ffffff';
const TEXT2 = '#9a9a9a';
const MUTED = '#4d4d4d';
const BORDER = '#1f1f1f';
const ACCENT = '#ffffff';
const GREEN = '#22c55e';
const RED = '#f0555a';
const AMBER = '#f5a623';

// Logo — served from the public API so Gmail's image proxy fetches it
// reliably. File lives at apps/api/public/logo.png (as you requested).
const LOGO_SRC = 'https://api.tirbeo.app/logo.png';
const LOGO_URL = LOGO_SRC;

function resolveLogo(logo: string): string {
  const raw = String(logo || '').trim();
  if (/^https?:\/\//i.test(raw) && !/\/\/(localhost|127\.0\.0\.1)/i.test(raw)) return raw;
  return LOGO_SRC;
}

// Canonical product links, resolved server-side at build time. Several
// templates need a stable CTA even when the caller doesn't pass one.
const APP_DOMAIN = (process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app').replace(/^https?:\/\//, '').replace(/\/$/, '');
const DASHBOARD_URL = process.env.NEXT_PUBLIC_DASHBOARD_URL || `https://dashboard.${APP_DOMAIN}`;
const SESSIONS_URL = `${DASHBOARD_URL}/account/sessions`;

// ═══ ICONS — plain text glyphs, not pictorial emoji. A small safe set
// reused across categories; the accent color underneath carries the rest
// of the meaning. Renders identically everywhere, no external assets. ═══
const ICONS = {
  mail: '\u2192', key: '\u2192', lock: '\u0021', shield: '\u0021', check: '\u2713',
  alertTriangle: '\u00D7', trash: '\u00D7', fileText: '\u2192', download: '\u2192',
  clock: '\u2192', bell: '\u2192', settings: '\u2192', zap: '\u2713', users: '\u2192',
  xCircle: '\u00D7', globe: '\u2192', barChart: '\u2192', star: '\u2713',
  externalLink: '\u2192', calendar: '\u2192', edit: '\u2192', eye: '\u2192',
};

// ═══ SHARED HELPERS — flat, non-containerized, email-safe ═══

function head(title: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title></head><body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};-webkit-font-smoothing:antialiased;">`;
}

/** Free, open layout — content sits directly on the black page, no card box. */
function wrapStart(): string {
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="background:${BG};border:none;border-collapse:collapse;"><tr><td align="center" style="padding:56px 24px 64px;"><table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width:576px;width:100%;border:none;border-collapse:collapse;"><tr><td style="padding:0;">`;
}

function wrapEnd(): string {
  return `</td></tr></table></td></tr></table></body></html>`;
}

// Logo loaded directly from the public asset host — no attachment rows,
// renders full-width-inline at 132px. resolveLogo guarantees the host is
// publicly reachable (never localhost).
function logoBlock(logo?: string): string {
  const src = resolveLogo(String(logo || '')) || LOGO_URL;
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-bottom:40px;"><img src="${src}" width="132" alt="Tirbeo" style="display:block;border:0;outline:none;text-decoration:none;max-width:132px;width:132px;height:auto;color:${TEXT};font-size:22px;font-weight:700;letter-spacing:-0.01em;"></td></tr></table>`;
}

function heroIcon(iconKey: keyof typeof ICONS, title: string, subtitle?: string): string {
  const glyph = ICONS[iconKey] || '';
  // Circle treatment reserved for success states (tick) only — every other
  // email opens with a clean centered title.
  const showGlyph = glyph !== '' && (iconKey === 'check' || iconKey === 'star');
  return `<div style="text-align:center;margin-bottom:38px;">${showGlyph ? `<div style="width:68px;height:68px;line-height:68px;border-radius:50%;background:${GREEN}1f;font-size:30px;font-weight:700;color:${GREEN};text-align:center;margin:0 auto 24px;font-family:Georgia,'Times New Roman',serif;">${glyph}</div>` : ''}<h1 style="margin:0;font-size:27px;font-weight:650;color:${TEXT};letter-spacing:-0.015em;line-height:34px;">${title}</h1>${subtitle ? `<p style="margin:12px 0 0;font-size:15.5px;color:${TEXT2};line-height:24px;">${subtitle}</p>` : ''}</div>`;
}

function otpBlock(code: string): string {
  return `<div style="text-align:center;margin:8px 0 36px;"><span style="display:inline-block;font-size:38px;font-weight:700;letter-spacing:11px;text-indent:11px;color:${TEXT};font-family:'SF Mono',ui-monospace,Consolas,monospace;padding:20px 30px;background:${SURFACE2};border:1px solid ${BORDER};border-radius:14px;">${code}</span></div>`;
}

function btn(url: string, label: string): string {
  return `<div style="text-align:center;margin:36px 0;"><a href="${url}" style="display:inline-block;padding:16px 40px;background:${ACCENT};color:${BG};font-size:15.5px;font-weight:600;text-decoration:none;border-radius:10px;">${label}</a></div>`;
}

function infoBox(content: string): string {
  return `<div style="margin:26px 0;padding:20px 24px;background:#0d0d0d;border-radius:12px;">${content}</div>`;
}

/** Structured key/value row set used inside infoBox blocks. */
function kv(pairs: Array<[string, string]>): string {
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">${pairs.map(([k, v]) => `<tr><td style="padding:7px 0;font-size:14px;color:${MUTED};width:118px;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:7px 0;font-size:14px;color:${TEXT2};line-height:21px;">${v}</td></tr>`).join('')}</table>`;
}

function sectionLabel(text: string): string {
  return `<p style="margin:28px 0 12px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">${text}</p>`;
}

function divider(): string {
  return `<div style="height:1px;background:${BORDER};margin:34px 0;"></div>`;
}

/** Simple company signature — no border separator so Gmail doesn't hide it behind ... */
function footer(): string {
  const year = new Date().getFullYear();
  return `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding-top:36px;">
<p style="margin:0;font-size:12px;color:#9a9a9a;">Tirbeo Inc. &middot; Kathmandu, Nepal</p>
<p style="margin:8px 0 0;font-size:11px;color:#6e6e6e;">&copy; ${year} Tirbeo Inc. All rights reserved.</p>{{unsubscribeSection}}</td></tr></table>`;
}

function body(text: string): string {
  return `<p style="margin:0 0 18px;font-size:16px;line-height:27px;color:${TEXT2};">${text}</p>`;
}

function small(text: string): string {
  return `<p style="margin:0;font-size:13px;line-height:21px;color:${MUTED};">${text}</p>`;
}

/** Reusable static security footnote for account-action emails. */
const SECURITY_NOTE = `${divider()}${small('Security note: Tirbeo will never ask for your password or verification code over email or phone.')}`;

// ═══ TEMPLATES ═══

export const EMAIL_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {

  signup_otp: (logo) => tpl(
    'Your Tirbeo verification code is {{otp}}',
    `${head('Verify Your Email')}${wrapStart()}${logoBlock(logo)}${heroIcon('mail', 'Verify your email', 'You\'re one step away from your new workspace.')}${body('Hello,')}${body('Use the verification code below to confirm your email address and activate your Tirbeo account. This code works only once and only for this signup.')}${otpBlock('{{otp}}')}${infoBox(kv([['Valid for', '10 minutes'],['Purpose', 'Email verification']]))}${small('Didn\'t sign up for Tirbeo? You can safely ignore this email — no account will be created without verification.')}${footer()}${wrapEnd()}`
  ),

  login_otp: (logo) => tpl(
    'Your Tirbeo login code is {{otp}}',
    `${head('Your Login Code')}${wrapStart()}${logoBlock(logo)}${heroIcon('key', 'Your login code', 'Enter this code to finish signing in.')}${body('Hello,')}${body('Here is your one-time code to sign in to Tirbeo. For your security it expires quickly and can be used exactly once.')}${otpBlock('{{otp}}')}${infoBox(kv([['Valid for', '10 minutes'],['Purpose', 'Account sign-in']]))}${small('Didn\'t try to sign in? Someone may have your password — we recommend changing it right away from your account security page.')}${footer()}${wrapEnd()}`
  ),

  verify_email: (logo) => tpl(
    'Verify your Tirbeo email',
    `${head('Verify Your Email')}${wrapStart()}${logoBlock(logo)}${heroIcon('mail', 'Verify your email address', 'Confirming your address keeps your account recoverable.')}${body('Hello,')}${body('Please confirm this email address belongs to you by entering the code below in the window that asked for it. A verified email means you can always reset access if you\'re ever locked out.')}${otpBlock('{{otp}}')}${small('This code expires in 10 minutes. If you didn\'t request it, nothing else is needed — just ignore this message.')}${footer()}${wrapEnd()}`
  ),

  magic_link: (logo) => tpl(
    'Sign in to Tirbeo',
    `${head('Sign in to Tirbeo')}${wrapStart()}${logoBlock(logo)}${heroIcon('externalLink', 'Sign in to Tirbeo', 'One click, no password needed.')}${body('Hi {{name}},')}${body('We received a request to sign you in with a one-time link. Click below and you\'ll land straight in your dashboard — no typing required.')}${btn('{{magicLink}}', 'Sign In to Tirbeo')}${divider()}${sectionLabel('About this link')}${kv([['Valid for', '15 minutes'],['Uses', 'Single use only'],['Requested for', '{{name}}']])}${small('If you didn\'t request a sign-in link, you can safely ignore this email — your account remains secure and no changes have been made.')}${footer()}${wrapEnd()}`
  ),

  password_reset_otp: (logo) => tpl(
    'Your Tirbeo password reset code is {{otp}}',
    `${head('Reset Your Password')}${wrapStart()}${logoBlock(logo)}${heroIcon('lock', 'Reset your password', 'Choose a strong, unique password you don\'t use elsewhere.')}${body('Hi {{name}},')}${body('We received a request to reset the password for your Tirbeo account. Enter the code below in the reset screen to continue.')}${otpBlock('{{otp}}')}${infoBox(kv([['Valid for', '15 minutes'],['Purpose', 'Password reset']]))}${SECURITY_NOTE}${small('If you didn\'t request a reset, your password hasn\'t been changed — you can ignore this email. It may simply mean someone typed their email incorrectly.')}${footer()}${wrapEnd()}`
  ),

  delete_account_otp: (logo) => tpl(
    'Your Tirbeo account deletion code is {{otp}}',
    `${head('Delete Account')}${wrapStart()}${logoBlock(logo)}${heroIcon('trash', 'Confirm account deletion', 'This step starts permanent removal of your account and data.')}${body('Hi {{name}},')}${body('You requested to delete your Tirbeo account. Enter the confirmation code below to schedule the deletion. Once confirmed, your account enters a 30-day grace period before all data is permanently erased.')}${otpBlock('{{otp}}')}${infoBox(kv([['Valid for', '10 minutes'],['What happens next', '30-day grace period'],['Can it be undone?', 'Yes — cancel anytime during the grace period']]))}${SECURITY_NOTE}${small('Didn\'t request deletion? Protect your account by changing your password immediately and reviewing your active sessions.')}${footer()}${wrapEnd()}`
  ),

  password_reset_link: (logo) => tpl(
    'Reset your Tirbeo password',
    `${head('Reset Your Password')}${wrapStart()}${logoBlock(logo)}${heroIcon('lock', 'Reset your password', 'The link below takes you straight to the reset form.')}${body('Hi {{name}},')}${body('We received a request to reset the password on your Tirbeo account. Click the button below to choose a new one — it only takes a minute.')}${btn('{{resetUrl}}', 'Reset Password')}${divider()}${sectionLabel('About this link')}${kv([['Valid for', '15 minutes'],['Uses', 'Single use only']])}${small('If you didn\'t request a reset, no action is needed — your password hasn\'t been changed and will keep working as usual.')}${footer()}${wrapEnd()}`
  ),

  password_changed: (logo) => tpl(
    'Your Tirbeo password was changed',
    `${head('Password Changed')}${wrapStart()}${logoBlock(logo)}${heroIcon('check', 'Password changed successfully', 'Your account is protected with your new password.')}${body('Hi {{name}},')}${body('This is a confirmation that the password on your Tirbeo account was just updated. All future sign-ins will require the new password.')}${sectionLabel('Change details')}${infoBox(kv([['When', '{{changedAt}}'],['From IP address', '{{ipAddress}}']]))}${small('If you made this change, there\'s nothing more to do. If you don\'t recognize it, reset your password immediately and review your active sessions — whoever made the change may still have access.')}${footer()}${wrapEnd()}`
  ),

  suspicious_login: (logo) => tpl(
    'Suspicious login detected on your Tirbeo account',
    `${head('Security Alert')}${wrapStart()}${logoBlock(logo)}${heroIcon('shield', 'Suspicious login detected', 'We noticed something out of the ordinary.')}${body('Hi {{name}},')}${body('A sign-in to your account came from a location or device we don\'t usually see. We\'re flagging it so you can double-check — here are the details of the attempt:')}${sectionLabel('Sign-in details')}${infoBox(kv([['Location', '{{location}}'],['Device', '{{device}}'],['Time', '{{loginTime}}'],['IP address', '{{ipAddress}}']]))}${btn(SESSIONS_URL, 'Review Active Sessions')}${small('If this was you, you\'re all set — no action needed. If it wasn\'t, secure your account right away: end that session, change your password, and consider enabling two-factor authentication.')}${footer()}${wrapEnd()}`
  ),

  login_alert: (logo) => tpl(
    'New sign-in to your Tirbeo account',
    `${head('New Sign-in')}${wrapStart()}${logoBlock(logo)}${heroIcon('globe', 'New sign-in detected', 'Your account was just accessed.')}${body('Hi {{name}},')}${body('Your Tirbeo account was just signed in. Here are the details of the session:')}${sectionLabel('Session details')}${infoBox(kv([['Location', '{{location}}'],['Device', '{{device}}'],['Time', '{{loginTime}}']]))}${btn(SESSIONS_URL, 'Review Sessions')}${small('If this was you, no action is needed. If you don\'t recognize this sign-in, review your sessions and change your password right away.')}${footer()}${wrapEnd()}`
  ),

  account_recovery: (logo) => tpl(
    'Reset your Tirbeo account',
    `${head('Account Recovery')}${wrapStart()}${logoBlock(logo)}${heroIcon('key', 'Recover your account', 'Regain access in a couple of minutes.')}${body('Hi {{name}},')}${body('We received a request to start recovery for your Tirbeo account. Click the button below to continue — you\'ll be guided through verifying your identity and choosing a new password.')}${btn('{{recoveryUrl}}', 'Recover Account')}${divider()}${sectionLabel('About this link')}${kv([['Valid for', '15 minutes'],['Uses', 'Single use only']])}${small('If you didn\'t request this, you can safely ignore this email — nothing has been changed on your account.')}${footer()}${wrapEnd()}`
  ),

  welcome: (logo) => tpl(
    'Welcome to Tirbeo, {{name}} — you\'re in',
    `${head('Welcome to Tirbeo')}${wrapStart()}${logoBlock(logo)}${heroIcon('star', 'Welcome aboard, {{name}}', 'Your workspace is live and ready.')}${body('We know there are a lot of places you could have chosen to do this work. The fact that you\'re here, starting something new with us, genuinely means a lot.')}${body('Your account is live and ready. No settling in required — everything you need is already where you\'d expect it to be.')}${sectionLabel('A good place to start')}${infoBox(`<p style="margin:0;font-size:14.5px;color:${TEXT2};line-height:26px;">Fill in a few details on your profile so your workspace feels like yours.<br>Take a slow first look around the dashboard — nothing to rush.<br>Connect the first app or integration you rely on most.</p>`)}${btn(DASHBOARD_URL, 'Go to Your Dashboard')}${divider()}${body('If anything feels unclear, reach us at admin@tirbeo.app — a real person reads every message.')}${body('Glad you\'re here.<br><span style="color:#ffffff;font-weight:600;">The Tirbeo team</span>')}${footer()}${wrapEnd()}`
  ),

  notification_digest: (logo) => tpl(
    'Your Tirbeo digest — {{count}} new updates',
    `${head('Your Tirbeo Digest')}${wrapStart()}${logoBlock(logo)}${heroIcon('bell', 'You have {{count}} new updates', 'Here\'s what happened while you were away.')}${body('Hi {{name}},')}${`<div style="margin:8px 0 26px;">{{digestItems}}</div>`}${`{{activitySection}}`}${btn('{{dashboardUrl}}', 'View All Updates')}${small('You\'re receiving this digest because you opted into periodic summaries. You can change how often we write to you from your notification preferences.')}${footer()}${wrapEnd()}`
  ),

  product_update: (logo) => tpl(
    '{{title}}',
    `${head('Product Update')}${wrapStart()}${logoBlock(logo)}${heroIcon('zap', '{{title}}', 'Fresh from the Tirbeo team.')}${body('Hi {{name}},')}${body('{{message}}')}${btn('{{ctaUrl}}', '{{ctaLabel}}')}${small('You\'re receiving product updates because they\'re part of your account communications. Manage what you hear about from your notification preferences.')}${footer()}${wrapEnd()}`
  ),

  weekly_summary: (logo) => tpl(
    'Your Tirbeo week — {{periodLabel}}',
    `${head('Weekly Summary')}${wrapStart()}${logoBlock(logo)}${heroIcon('barChart', 'Your week on Tirbeo', '{{periodLabel}}')}${`<div style="margin:24px 0;">{{statRows}}</div>`}${'{{suspiciousSection}}'}${btn(`${DASHBOARD_URL}/activity/history`, 'View Full Activity')}${small('This summary covers your account activity for the period shown. Adjust delivery from your notification preferences anytime.')}${footer()}${wrapEnd()}`
  ),

  account_tip: (logo) => tpl(
    'Tip: {{tipTitle}}',
    `${head('Tips & Updates')}${wrapStart()}${logoBlock(logo)}${heroIcon('zap', '{{tipTitle}}', 'A quick way to get more out of Tirbeo.')}${body('Hi {{name}},')}${body('{{tipBody}}')}${btn('{{actionUrl}}', '{{actionLabel}}')}${small('These tips are sent occasionally based on how your account is set up. You can turn them off from your notification preferences.')}${footer()}${wrapEnd()}`
  ),

  account_suspended: (logo) => tpl(
    'Your Tirbeo account has been {{statusType}}',
    `${head('Account Status')}${wrapStart()}${logoBlock(logo)}${heroIcon('alertTriangle', 'Account {{statusType}}', 'Please read the details below carefully.')}${body('Hi {{name}},')}${body('The status of your Tirbeo account has changed. Here are the details:')}${sectionLabel('Status details')}${infoBox(kv([['Status', '{{statusType}}'],['Reason', '{{reason}}'],['Until', '{{untilLabel}}'],['What to do', '{{actionLabel}}']]))}${btn('{{dashboardUrl}}/account', 'Go to Your Account')}${small('If you believe this was applied in error, reply to this email or reach out through support and our team will review it promptly.')}${footer()}${wrapEnd()}`
  ),

  account_deleted: (logo) => tpl(
    'Your Tirbeo account is scheduled for deletion',
    `${head('Deletion Scheduled')}${wrapStart()}${logoBlock(logo)}${heroIcon('trash', 'Deletion scheduled', 'Permanent removal begins after the grace period.')}${body('Hi {{name}},')}${body('As requested, your Tirbeo account is scheduled for deletion. Below are the key facts:')}${sectionLabel('Deletion details')}${infoBox(kv([['Scheduled date', '{{dateLabel}}'],['Grace period', '30 days'],['Data removal', 'All account data is permanently erased']]))}${body('Changed your mind? Sign in any time before <strong style="color:' + TEXT + ';">{{dateLabel}}</strong> to cancel — everything will be exactly as you left it.')}${btn('{{dashboardUrl}}/account/security', 'Cancel Deletion')}${footer()}${wrapEnd()}`
  ),

  admin_alert: (logo) => tpl(
    '[Admin] {{subject}}',
    `${head('Admin Alert')}${wrapStart()}${logoBlock(logo)}${heroIcon('shield', '{{subject}}', 'Administrative notice — internal use.')}${body('{{message}}')}${sectionLabel('Details')}${infoBox(`<div style="font-size:14px;color:${TEXT2};line-height:23px;">{{details}}</div>`)}${btn('{{dashboardUrl}}', 'View Admin Dashboard')}${small('Automated alert from the Tirbeo platform. Investigate promptly if unexpected.')}${footer()}${wrapEnd()}`
  ),

  system_alert: (logo) => tpl(
    '[System] {{subject}}',
    `${head('System Alert')}${wrapStart()}${logoBlock(logo)}${heroIcon('settings', '{{subject}}', 'Platform monitoring notice.')}${body('{{message}}')}${sectionLabel('Event details')}${infoBox(kv([['Service', '{{service}}'],['Time', '{{alertTime}}']]))}${small('Automated system alert — no customer action is required. Reply to this email to reach on-call engineering.')}${footer()}${wrapEnd()}`
  ),

  admin_crash_report: (logo) => tpl(
    '[Crash] {{severity}}: {{errorType}}',
    `${head('Crash Report')}${wrapStart()}${logoBlock(logo)}${heroIcon('alertTriangle', '{{severity}} crash reported', '{{errorType}}')}${body('A client-side crash was captured by automatic error reporting. Details follow:')}${sectionLabel('Crash details')}${infoBox(kv([['Message', '{{message}}'],['User', '{{userEmail}} ({{username}})'],['Page', '{{url}}'],['Source', '{{source}}'],['Device', '{{userAgent}}']]))}${sectionLabel('Stack trace')}${`<pre style="margin:0 0 24px;font-size:12px;color:${MUTED};font-family:'SF Mono',ui-monospace,Consolas,monospace;background:#0d0d0d;border-radius:10px;padding:16px 18px;white-space:pre-wrap;word-break:break-all;max-height:280px;overflow:auto;">{{stack}}</pre>`}${btn(DASHBOARD_URL, 'Open Admin Dashboard')}${small('User consented to crash reporting. Handle the attached stack per your data policy.')}${footer()}${wrapEnd()}`
  ),

  export_ready: (logo) => tpl(
    'Your data has been exported',
    `${head('Data Exported')}${wrapStart()}${logoBlock(logo)}${heroIcon('download', 'Your export is ready', 'A complete copy of your account data was generated.')}${body('Hi {{name}},')}${body('Your data export was processed successfully. The download should have started automatically from the page that requested it — the file contains your information in portable JSON format.')}${sectionLabel('Export details')}${infoBox(kv([['Generated at', '{{exportedAt}}'],['Format', 'JSON']]))}${SECURITY_NOTE}${small('If this wasn\'t you, change your password immediately — exports contain personal information.')}${footer()}${wrapEnd()}`
  ),

  form_submission_confirmation: (logo) => tpl(
    'Your response to {{formTitle}} was recorded',
    `${head('Response Recorded')}${wrapStart()}${logoBlock(logo)}${heroIcon('check', 'Response recorded', 'Thank you — your submission went through.')}${body('Your response to <strong style="color:' + TEXT + ';">{{formTitle}}</strong> was recorded successfully. No further action is needed on your part.')}${btn('{{formUrl}}', 'View Form')}${small('You received this because you submitted a response to this form. The form owner manages delivery of these confirmations.')}${footer()}${wrapEnd()}`
  ),

  form_response: (logo) => tpl(
    'New response to "{{formTitle}}"',
    `${head('New Form Response')}${wrapStart()}${logoBlock(logo)}${heroIcon('fileText', 'New response received', '{{formTitle}}')}${body('Someone just submitted a response to your form. Here\'s what they said:')}${sectionLabel('Response details')}${infoBox(kv([['Respondent', '{{respondentName}}'],['Submitted', '{{submittedAt}}']]))}<div style="margin:8px 0 26px;">{{answers}}</div>${btn('{{adminUrl}}', 'View in Dashboard')}${footer()}${wrapEnd()}`
  ),

  form_notification: (logo) => tpl(
    'New form submission: {{formTitle}}',
    `${head('New Form Submission')}${wrapStart()}${logoBlock(logo)}${heroIcon('bell', 'New submission', '{{formTitle}}')}${body('A new submission arrived on your form. The collected data is below:')}${`<div style="margin:8px 0 26px;">{{submissionData}}</div>`}${btn('{{formUrl}}', 'View Submission')}${footer()}${wrapEnd()}`
  ),

  form_flagged: (logo) => tpl(
    'Your form "{{formTitle}}" was flagged',
    `${head('Form Flagged')}${wrapStart()}${logoBlock(logo)}${heroIcon('alertTriangle', 'Form flagged for review', '{{formTitle}}')}${body('Our moderation systems flagged one of your forms for manual review. While flagged, some capabilities may be limited until the review completes.')}${sectionLabel('Flag details')}${infoBox(kv([['Reason', '{{reason}}'],['Flagged at', '{{flaggedAt}}']]))}${btn('{{adminUrl}}', 'View Flag Details')}${small('If you believe this flag is incorrect, reply to this email and our team will take another look.')}${footer()}${wrapEnd()}`
  ),

  form_published: (logo) => tpl(
    'Your form "{{formTitle}}" is now live',
    `${head('Form Published')}${wrapStart()}${logoBlock(logo)}${heroIcon('zap', 'Your form is live', '{{formTitle}} is accepting responses.')}${body('Your form was published and the public link is active. Share it wherever your audience is — every submission lands in your dashboard in real time.')}${btn('{{formUrl}}', 'View Form')}${small('You can pause, edit, or unpublish the form at any time from your dashboard without losing responses.')}${footer()}${wrapEnd()}`
  ),

  form_closed: (logo) => tpl(
    'Your form "{{formTitle}}" has been closed',
    `${head('Form Closed')}${wrapStart()}${logoBlock(logo)}${heroIcon('lock', 'Form closed', '{{formTitle}} is no longer accepting responses.')}${body('Your form was closed. Visitors who open its link now see a closed notice instead of the questions. Responses collected so far remain intact and exportable.')}${small('You can reopen the form from your dashboard whenever you\'re ready to collect again.')}${footer()}${wrapEnd()}`
  ),

  form_deleted: (logo) => tpl(
    'Your form "{{formTitle}}" has been deleted',
    `${head('Form Deleted')}${wrapStart()}${logoBlock(logo)}${heroIcon('trash', 'Form deleted', '{{formTitle}} and its data were removed.')}${body('Your form was permanently deleted along with its configuration and public link. This action cannot be undone.')}${small('Was this unexpected? Check your dashboard activity log, and contact support right away if something looks off.')}${footer()}${wrapEnd()}`
  ),

  form_archived: (logo) => tpl(
    'Your form "{{formTitle}}" has been archived',
    `${head('Form Archived')}${wrapStart()}${logoBlock(logo)}${heroIcon('download', 'Form archived', '{{formTitle}} moved to your archive.')}${body('Your form was moved to the archive. It stops collecting responses but nothing is lost — the setup and all collected responses stay available for export.')}${small('Archived forms can be restored from your dashboard at any time.')}${footer()}${wrapEnd()}`
  ),

  response_updated: (logo) => tpl(
    'A response to "{{formTitle}}" was updated',
    `${head('Response Updated')}${wrapStart()}${logoBlock(logo)}${heroIcon('edit', 'Response updated', '{{formTitle}}')}${body('An existing response on your form was modified. Review the change history in your dashboard to see exactly what changed.')}${sectionLabel('Update details')}${infoBox(kv([['Response ID', '{{responseId}}'],['Updated at', '{{updatedAt}}']]))}${footer()}${wrapEnd()}`
  ),

  response_deleted: (logo) => tpl(
    'A response to "{{formTitle}}" was deleted',
    `${head('Response Deleted')}${wrapStart()}${logoBlock(logo)}${heroIcon('trash', 'Response deleted', '{{formTitle}}')}${body('A response on your form was deleted and can no longer be viewed or exported.')}${sectionLabel('Deletion details')}${infoBox(kv([['Response ID', '{{responseId}}'],['Deleted at', '{{deletedAt}}']]))}${footer()}${wrapEnd()}`
  ),

  ticket_created: (logo) => tpl(
    'Support ticket opened: {{ticketSubject}}',
    `${head('Support Ticket Opened')}${wrapStart()}${logoBlock(logo)}${heroIcon('fileText', 'Ticket opened', 'Our support team is on it.')}${body('Thanks for reaching out — your support ticket was created successfully. A member of our team will review it and reply as soon as possible; you\'ll receive an email the moment there\'s an update.')}${sectionLabel('Ticket details')}${infoBox(kv([['Ticket ID', '{{ticketId}}'],['Subject', '{{ticketSubject}}'],['Status', '{{ticketStatus}}']]))}${btn('{{ticketUrl}}', 'View Ticket')}${small('You can reply to this ticket and add screenshots or files from the ticket page above. Please keep this email for reference.')}${footer()}${wrapEnd()}`
  ),

  ticket_updated: (logo) => tpl(
    'Update on your support ticket {{ticketId}}',
    `${head('Ticket Updated')}${wrapStart()}${logoBlock(logo)}${heroIcon('edit', 'Ticket updated', '{{ticketId}}')}${body('There\'s new activity on your support ticket.')}${sectionLabel('Update')}${infoBox(`<p style="margin:0;font-size:14.5px;color:${TEXT2};line-height:24px;">{{updateMessage}}</p>`)}${sectionLabel('Ticket details')}${infoBox(kv([['Ticket ID', '{{ticketId}}'],['Subject', '{{ticketSubject}}'],['Status', '{{ticketStatus}}']]))}${btn('{{ticketUrl}}', 'View Ticket')}${small('Replying to this ticket keeps the conversation in one place — use the button above to respond.')}${footer()}${wrapEnd()}`
  ),

  ticket_closed: (logo) => tpl(
    'Your support ticket {{ticketId}} has been closed',
    `${head('Ticket Closed')}${wrapStart()}${logoBlock(logo)}${heroIcon('check', 'Ticket resolved', '{{ticketId}} has been closed.')}${body('We\'re marking your support ticket as complete — we hope the issue is fully resolved. Closing tickets helps us respond faster to everyone who needs help.')}${sectionLabel('Ticket details')}${infoBox(kv([['Ticket ID', '{{ticketId}}']]))}${btn('{{ticketUrl}}', 'View Ticket')}${small('Need more help with the same issue? Simply reopen the ticket from the page above, or open a new one anytime — we\'re glad to assist.')}${footer()}${wrapEnd()}`
  ),

  form_auto_reply: (logo) => tpl(
    'Thanks for submitting to {{formTitle}}',
    `${head('Submission Received')}${wrapStart()}${logoBlock(logo)}${heroIcon('check', 'Thank you!', 'Your response was recorded successfully.')}${body('We received your submission to <strong style="color:' + TEXT + ';">{{formTitle}}</strong>. Here\'s a copy of what you sent:')}${`<div style="margin:8px 0 26px;">{{fieldsRows}}</div>`}${sectionLabel('Submission details')}${infoBox(kv([['Submission ID', '{{submissionId}}'],['Received at', '{{submittedAt}}']]))}${small('No further action is needed. If you submitted this form by mistake, contact the form owner.')}${footer()}${wrapEnd()}`
  ),

  form_submission_notification: (logo) => tpl(
    'New submission on {{formTitle}}',
    `${head('New Form Submission')}${wrapStart()}${logoBlock(logo)}${heroIcon('fileText', 'New response received', '{{formTitle}}')}${body('Someone just submitted a response to your form. The collected data is below:')}${sectionLabel('Submitted data')}${`<div style="margin:8px 0 10px;">{{fieldRows}}</div>`}${sectionLabel('Submission details')}${infoBox(kv([['Submission ID', '{{submissionId}}'],['Received at', '{{submittedAt}}'],['IP address', '{{ip}}']]))}${btn('{{viewUrl}}', 'View Submission')}${footer()}${wrapEnd()}`
  ),

  admin_test: (logo) => tpl(
    'Test email from Tirbeo',
    `${head('Test Email')}${wrapStart()}${logoBlock(logo)}${heroIcon('check', 'Email is working', 'This is what a Tirbeo email looks like.')}${body('If you\'re reading this in your inbox, the email configuration for <strong style="color:' + TEXT + ';">{{sentFor}}</strong> is working correctly — delivery, design, and links are all live.')}${small('No action is needed — this was a configuration test, not a real notification.')}${footer()}${wrapEnd()}`
  ),
};

// ─── FORM NOTIFICATION TEMPLATES ───
export const FORM_NOTIFICATION_TEMPLATES: Record<string, (logo: string, imageBase: string) => EmailTemplate> = {

  form_milestone: (logo) => tpl(
    'Milestone: {{formTitle}} reached {{milestone}} responses!',
    `${head('Milestone Reached!')}${wrapStart()}${logoBlock(logo)}${heroIcon('star', 'Milestone reached', '{{formTitle}} keeps growing.')}${`<div style="text-align:center;margin:8px 0 32px;"><p style="margin:0;font-size:52px;font-weight:700;color:${TEXT};">{{milestone}}</p><p style="margin:6px 0 0;font-size:13px;color:${MUTED};">Total responses</p></div>`}${body('Congratulations — your form just crossed a meaningful milestone. Momentum like this is a great moment to share the form more widely while interest is high.')}${btn('{{adminUrl}}', 'View Overview')}${footer()}${wrapEnd()}`
  ),

  form_spike: (logo) => tpl(
    'Response spike detected on "{{formTitle}}"',
    `${head('Response Spike')}${wrapStart()}${logoBlock(logo)}${heroIcon('zap', 'Response spike detected', '{{formTitle}} is receiving unusual traffic.')}${body('Your form received a burst of responses in a very short window. This often follows a share going out — but if you didn\'t expect it, it\'s worth a quick look at the latest submissions.')}${sectionLabel('Spike details')}${infoBox(kv([['Last 10 minutes', '{{responseCount}} responses'],['Total so far', '{{totalResponses}}']]))}${btn('{{adminUrl}}', 'View Responses')}${footer()}${wrapEnd()}`
  ),

  form_revival: (logo) => tpl(
    'Your form "{{formTitle}}" is active again',
    `${head('Form Revival')}${wrapStart()}${logoBlock(logo)}${heroIcon('bell', 'Active again', '{{formTitle}} just received a new response.')}${body('After a quiet stretch, your form picked up a fresh response. Sometimes all it takes is one to get things moving again — worth checking what brought them in.')}${btn('{{adminUrl}}', 'View Responses')}${footer()}${wrapEnd()}`
  ),

  form_test: (logo) => tpl(
    'Test notification: {{formTitle}}',
    `${head('Test Notification')}${wrapStart()}${logoBlock(logo)}${heroIcon('check', 'Notifications working', 'This is what a real alert will look like.')}${body('This is a test notification for <strong style="color:' + TEXT + ';">{{formTitle}}</strong>. If you\'re reading this in your inbox, form notifications are correctly configured and will arrive like this one.')}${small('No action is needed — test alerts don\'t appear in your analytics.')}${footer()}${wrapEnd()}`
  ),

  form_summary_daily: (logo) => tpl(
    'Daily Summary: {{formTitle}} — {{newResponses}} new responses',
    `${head('Daily Summary')}${wrapStart()}${logoBlock(logo)}${heroIcon('barChart', 'Daily summary', '{{formTitle}}')}${body('Here\'s how your form performed today:')}${`<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin:8px 0 30px;background:#0d0d0d;border-radius:12px;"><tr><td style="width:50%;text-align:center;border-right:1px solid ${BORDER};padding:22px 0;"><p style="margin:0;font-size:34px;font-weight:700;color:${TEXT};">{{newResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">New</p></td><td style="width:50%;text-align:center;padding:22px 0;"><p style="margin:0;font-size:34px;font-weight:700;color:${TEXT};">{{totalResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">Total</p></td></tr></table>`}${btn('{{adminUrl}}', 'View Analytics')}${small('Daily summaries help you spot trends early. Adjust frequency from your form\'s notification settings.')}${footer()}${wrapEnd()}`
  ),

  form_summary_weekly: (logo) => tpl(
    'Weekly Summary: {{formTitle}} — {{newResponses}} new responses',
    `${head('Weekly Summary')}${wrapStart()}${logoBlock(logo)}${heroIcon('barChart', 'Weekly summary', '{{formTitle}}')}${body('Here\'s how your form performed this week:')}${`<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="margin:8px 0 30px;background:#0d0d0d;border-radius:12px;"><tr><td style="width:50%;text-align:center;border-right:1px solid ${BORDER};padding:22px 0;"><p style="margin:0;font-size:34px;font-weight:700;color:${TEXT};">{{newResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">New</p></td><td style="width:50%;text-align:center;padding:22px 0;"><p style="margin:0;font-size:34px;font-weight:700;color:${TEXT};">{{totalResponses}}</p><p style="margin:4px 0 0;font-size:12px;color:${MUTED};">Total</p></td></tr></table>`}${btn('{{adminUrl}}', 'View Analytics')}${small('Weekly summaries help you spot trends early. Adjust frequency from your form\'s notification settings.')}${footer()}${wrapEnd()}`
  ),

  webhook_failed: (logo) => tpl(
    'Webhook delivery failed for "{{formTitle}}"',
    `${head('Webhook Failed')}${wrapStart()}${logoBlock(logo)}${heroIcon('alertTriangle', 'Webhook delivery failed', '{{formTitle}}')}${body('A webhook connected to your form could not deliver its payload. Responses are safe and stored normally — only the outbound delivery failed. Retries happen automatically for a limited period.')}${sectionLabel('Delivery details')}${infoBox(kv([['Endpoint', '{{webhookUrl}}'],['HTTP status', '{{httpStatus}}'],['Error', '{{errorMessage}}']]))}${btn('{{settingsUrl}}', 'Check Settings')}${small('Common causes: endpoint downtime, expired credentials, or a firewall change. Verify the endpoint is reachable and expects POST requests.')}${footer()}${wrapEnd()}`
  ),

  collaborator_added: (logo) => tpl(
    'You have been added as a collaborator to "{{formTitle}}"',
    `${head('Collaborator Added')}${wrapStart()}${logoBlock(logo)}${heroIcon('users', 'Added as {{role}}', '{{formTitle}}')}${body('You\'ve been granted collaborator access to a form. Depending on your role you can view responses, edit the form, or manage its settings.')}${sectionLabel('Access details')}${infoBox(kv([['Your role', '{{role}}'],['Added by', '{{addedByName}}']]))}${btn('{{formUrl}}', 'Open Form')}${small('If you weren\'t expecting this invitation, you can simply ignore it — or let the form owner know.')}${footer()}${wrapEnd()}`
  ),

  response_limit_reached: (logo) => tpl(
    'Response limit reached for "{{formTitle}}"',
    `${head('Response Limit Reached')}${wrapStart()}${logoBlock(logo)}${heroIcon('xCircle', 'Limit reached', '{{formTitle}} hit {{limit}} responses.')}${body('Your form reached its configured response limit and has stopped accepting new submissions automatically. Existing responses are untouched.')}${btn('{{settingsUrl}}', 'Update Settings')}${small('To keep collecting, raise the limit or remove it entirely from the form\'s settings — the change applies instantly.')}${footer()}${wrapEnd()}`
  ),

  form_scheduled: (logo) => tpl(
    'Your form "{{formTitle}}" will open on {{scheduledAt}}',
    `${head('Form Scheduled')}${wrapStart()}${logoBlock(logo)}${heroIcon('calendar', 'Scheduled to open', '{{formTitle}} opens automatically.')}${body('Your form is scheduled to go live automatically — no need to publish anything manually. When the time comes, the public link starts accepting responses on its own.')}${sectionLabel('Schedule details')}${infoBox(kv([['Opens at', '{{scheduledAt}}']]))}${btn('{{adminUrl}}', 'View Form')}${small('Need a different time? Reschedule from the form\'s settings up until the moment it opens.')}${footer()}${wrapEnd()}`
  ),
};

export function buildTemplates(logoUrl: string = '', imageBase: string = ''): Record<string, EmailTemplate> {
  const logo = resolveLogo(logoUrl);
  const result: Record<string, EmailTemplate> = {};
  for (const [key, fn] of Object.entries(EMAIL_TEMPLATES)) {
    result[key] = fn(logo, imageBase);
  }
  for (const [key, fn] of Object.entries(FORM_NOTIFICATION_TEMPLATES)) {
    if (!result[key]) result[key] = fn(logo, imageBase);
  }
  return result;
}

// Variables whose values are trusted HTML fragments (built server-side).
// These must pass through unescaped — escaping them turns the markup into
// visible text in the recipient's inbox.
const RAW_HTML_VARS = new Set([
  'unsubscribeSection', 'managePreferencesUrl',
  'digestItems', 'activitySection', 'statRows', 'suspiciousSection',
  'submissionData', 'answers', 'details',
  'fieldsRows', 'fieldRows',
]);

export function renderTemplate(html: string, vars: Record<string, string>): string {
  let result = html;
  for (const [key, val] of Object.entries(vars)) {
    if (RAW_HTML_VARS.has(key)) {
      result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), val);
    } else {
      result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), val.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));
    }
  }
  return result;
}
