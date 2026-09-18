import { getApiOrigin } from '@/features/branding/branding';

export type EmailTemplate = {
  subject: string;
  html: string;
};

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

const APP_DOMAIN = (
  process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.app'
)
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');

const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ||
  `https://dashboard.${APP_DOMAIN}`;

const SESSIONS_URL = `${DASHBOARD_URL}/account/sessions`;

/* -------------------------------------------------------------------------- */
/* Simple email system                                                        */
/* -------------------------------------------------------------------------- */

const TEXT = '#111111';
const MUTED = '#666666';
const BORDER = '#e5e5e5';
const LINK = '#111111';

function head(title: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>${title}</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#ffffff;
    color:${TEXT};
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  "
>
`;
}

function wrapStart(): string {
  return `
<table
  role="presentation"
  width="100%"
  border="0"
  cellpadding="0"
  cellspacing="0"
  style="background:#ffffff;"
>
  <tr>
    <td
      align="center"
      style="padding:40px 20px;"
    >
      <table
        role="presentation"
        width="100%"
        border="0"
        cellpadding="0"
        cellspacing="0"
        style="max-width:560px;"
      >
        <tr>
          <td>
`;
}

function wrapEnd(): string {
  return `
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

function logoBlock(_logo?: string): string {
  const src = `${getApiOrigin()}/logo.png`;

  return `
<table
  role="presentation"
  width="100%"
  border="0"
  cellpadding="0"
  cellspacing="0"
>
  <tr>
    <td style="padding-bottom:32px;">
      <img
        src="${src}"
        width="28"
        height="28"
        alt="Tirbeo"
        style="
          display:block;
          width:28px;
          height:28px;
          border:0;
          border-radius:6px;
        "
      >
    </td>
  </tr>
</table>
`;
}

/* -------------------------------------------------------------------------- */
/* Typography                                                                  */
/* -------------------------------------------------------------------------- */

function title(text: string): string {
  return `
<h1
  style="
    margin:0 0 20px;
    font-size:24px;
    line-height:32px;
    font-weight:600;
    letter-spacing:-0.02em;
    color:${TEXT};
  "
>
  ${text}
</h1>
`;
}

function body(text: string): string {
  return `
<p
  style="
    margin:0 0 16px;
    font-size:15px;
    line-height:24px;
    color:${TEXT};
  "
>
  ${text}
</p>
`;
}

function small(text: string): string {
  return `
<p
  style="
    margin:0 0 12px;
    font-size:13px;
    line-height:20px;
    color:${MUTED};
  "
>
  ${text}
</p>
`;
}

/* -------------------------------------------------------------------------- */
/* Simple components                                                           */
/* -------------------------------------------------------------------------- */

function otpBlock(code: string): string {
  return `
<p
  style="
    margin:28px 0;
    font-size:32px;
    line-height:40px;
    font-weight:600;
    letter-spacing:6px;
    color:${TEXT};
    font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  "
>
  ${code}
</p>
`;
}

function btn(url: string, label: string): string {
  return `
<p style="margin:28px 0;">
  <a
    href="${url}"
    style="
      display:inline-block;
      padding:11px 18px;
      background:#111111;
      color:#ffffff;
      text-decoration:none;
      font-size:14px;
      line-height:20px;
      font-weight:500;
      border-radius:6px;
    "
  >
    ${label}
  </a>
</p>
`;
}

const btnDanger = btn;

function divider(): string {
  return `
<div
  style="
    height:1px;
    background:${BORDER};
    margin:32px 0;
  "
></div>
`;
}

function kv(pairs: Array<[string, string]>): string {
  return `
<table
  role="presentation"
  width="100%"
  border="0"
  cellpadding="0"
  cellspacing="0"
  style="margin:20px 0;"
>
  ${pairs
    .map(
      ([key, value]) => `
  <tr>
    <td
      style="
        padding:8px 0;
        font-size:13px;
        color:${MUTED};
        width:130px;
        vertical-align:top;
      "
    >
      ${key}
    </td>

    <td
      style="
        padding:8px 0;
        font-size:14px;
        line-height:21px;
        color:${TEXT};
        vertical-align:top;
      "
    >
      ${value}
    </td>
  </tr>
  `,
    )
    .join('')}
</table>
`;
}

function plainBlock(content: string): string {
  return `
<div
  style="
    margin:20px 0;
    padding:16px 0;
    border-top:1px solid ${BORDER};
    border-bottom:1px solid ${BORDER};
  "
>
  ${content}
</div>
`;
}

function footer(): string {
  const year = new Date().getFullYear();

  return `
${divider()}

<p
  style="
    margin:0;
    font-size:12px;
    line-height:18px;
    color:${MUTED};
  "
>
  Tirbeo Inc. · Kathmandu, Nepal
</p>

<p
  style="
    margin:4px 0 0;
    font-size:12px;
    line-height:18px;
    color:${MUTED};
  "
>
  © ${year} Tirbeo Inc. All rights reserved.
</p>

{{unsubscribeSection}}
`;
}

const SECURITY_NOTE = `
${divider()}

${small(
  'Tirbeo will never ask for your password or verification code by email or phone.',
)}
`;

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

export const EMAIL_TEMPLATES: Record<
  string,
  (logo: string) => EmailTemplate
> = {
  signup_otp: (logo) =>
    tpl(
      'Your Tirbeo verification code is {{otp}}',
      `${head('Verify your email')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Verify your email')}
      ${body('Hello,')}
      ${body(
        'Use the code below to verify your email address and activate your Tirbeo account.',
      )}
      ${otpBlock('{{otp}}')}
      ${small('This code expires in 10 minutes and can only be used once.')}
      ${small(
        "If you didn't sign up for Tirbeo, you can safely ignore this email.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  login_otp: (logo) =>
    tpl(
      'Your Tirbeo login code is {{otp}}',
      `${head('Your login code')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Your login code')}
      ${body('Hello,')}
      ${body('Use the code below to finish signing in to Tirbeo.')}
      ${otpBlock('{{otp}}')}
      ${small('This code expires in 10 minutes and can only be used once.')}
      ${small(
        "If you didn't try to sign in, we recommend changing your password.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  verify_email: (logo) =>
    tpl(
      'Verify your Tirbeo email',
      `${head('Verify your email')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Verify your email')}
      ${body('Hello,')}
      ${body(
        'Enter the verification code below to confirm your email address.',
      )}
      ${otpBlock('{{otp}}')}
      ${small('This code expires in 10 minutes.')}
      ${small(
        "If you didn't request this code, you can safely ignore this email.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  magic_link: (logo) =>
    tpl(
      'Sign in to Tirbeo',
      `${head('Sign in to Tirbeo')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Sign in to Tirbeo')}
      ${body('Hi {{name}},')}
      ${body(
        'We received a request to sign you in. Use the button below to continue.',
      )}
      ${btn('{{magicLink}}', 'Sign in')}
      ${small('This link expires in 15 minutes and can only be used once.')}
      ${small(
        "If you didn't request this sign-in link, you can safely ignore this email.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  password_reset_otp: (logo) =>
    tpl(
      'Your Tirbeo password reset code is {{otp}}',
      `${head('Reset your password')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Reset your password')}
      ${body('Hi {{name}},')}
      ${body(
        'Use the code below to continue resetting your Tirbeo password.',
      )}
      ${otpBlock('{{otp}}')}
      ${small('This code expires in 15 minutes and can only be used once.')}
      ${SECURITY_NOTE}
      ${small(
        "If you didn't request a password reset, your password has not been changed.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  password_reset_otp_recovery: (logo) =>
    tpl(
      'Password reset for {{primaryEmail}}',
      `${head('Reset your password')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Reset your password')}
      ${body('Hi {{name}},')}
      ${body(
        'A password reset was requested for <strong>{{primaryEmail}}</strong>. The verification code was sent to your recovery email <strong>{{recoveryEmail}}</strong>.',
      )}
      ${otpBlock('{{otp}}')}
      ${small('This code expires in 15 minutes and can only be used once.')}
      ${kv([
        ['Account', '{{primaryEmail}}'],
        ['Recovery email', '{{recoveryEmail}}'],
      ])}
      ${SECURITY_NOTE}
      ${small(
        "If you didn't request this reset, your password has not been changed.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  delete_account_otp: (logo) =>
    tpl(
      'Your Tirbeo account deletion code is {{otp}}',
      `${head('Delete account')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Confirm account deletion')}
      ${body('Hi {{name}},')}
      ${body(
        'Use the code below to confirm your request to delete your Tirbeo account.',
      )}
      ${otpBlock('{{otp}}')}
      ${small(
        'The code expires in 10 minutes. After confirmation, your account enters a 30-day grace period.',
      )}
      ${SECURITY_NOTE}
      ${small(
        "If you didn't request account deletion, change your password and review your active sessions.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  password_reset_link: (logo) =>
    tpl(
      'Reset your Tirbeo password',
      `${head('Reset your password')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Reset your password')}
      ${body('Hi {{name}},')}
      ${body(
        'We received a request to reset your Tirbeo password. Use the button below to continue.',
      )}
      ${btn('{{resetUrl}}', 'Reset password')}
      ${small('This link expires in 15 minutes and can only be used once.')}
      ${small(
        "If you didn't request this, your password has not been changed.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  password_changed: (logo) =>
    tpl(
      'Your Tirbeo password was changed',
      `${head('Password changed')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Password changed')}
      ${body('Hi {{name}},')}
      ${body(
        'Your Tirbeo password was successfully changed.',
      )}
      ${kv([
        ['When', '{{changedAt}}'],
        ['IP address', '{{ipAddress}}'],
      ])}
      ${small(
        "If you didn't make this change, reset your password and review your active sessions immediately.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  suspicious_login: (logo) =>
    tpl(
      'Suspicious login detected on your Tirbeo account',
      `${head('Security alert')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Suspicious login detected')}
      ${body('Hi {{name}},')}
      ${body(
        "We detected a sign-in from a device or location that isn't familiar to your account.",
      )}
      ${kv([
        ['Location', '{{location}}'],
        ['Device', '{{device}}'],
        ['Time', '{{loginTime}}'],
        ['IP address', '{{ipAddress}}'],
      ])}
      ${btnDanger(SESSIONS_URL, 'Review sessions')}
      ${small(
        "If this wasn't you, end the session, change your password, and enable two-factor authentication.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  login_alert: (logo) =>
    tpl(
      'New sign-in to your Tirbeo account',
      `${head('New sign-in')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('New sign-in')}
      ${body('Hi {{name}},')}
      ${body('Your Tirbeo account was just accessed.')}
      ${kv([
        ['Location', '{{location}}'],
        ['Device', '{{device}}'],
        ['Time', '{{loginTime}}'],
      ])}
      ${btn(SESSIONS_URL, 'Review sessions')}
      ${small(
        "If you don't recognize this sign-in, change your password immediately.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  account_recovery: (logo) =>
    tpl(
      'Reset your Tirbeo account',
      `${head('Account recovery')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Recover your account')}
      ${body('Hi {{name}},')}
      ${body(
        'We received a request to recover your Tirbeo account. Use the button below to continue.',
      )}
      ${btn('{{recoveryUrl}}', 'Recover account')}
      ${small('This link expires in 15 minutes and can only be used once.')}
      ${small(
        "If you didn't request this, you can safely ignore this email.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  welcome: (logo) =>
    tpl(
      "Welcome to Tirbeo, {{name}}",
      `${head('Welcome to Tirbeo')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Welcome to Tirbeo')}
      ${body('Hi {{name}},')}
      ${body(
        'Your Tirbeo account is ready.',
      )}
      ${body(
        'You can now sign in and start using your workspace.',
      )}
      ${btn(DASHBOARD_URL, 'Open Tirbeo')}
      ${body(
        'If you need help, contact us at admin@tirbeo.app.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  notification_digest: (logo) =>
    tpl(
      'Your Tirbeo digest — {{count}} updates',
      `${head('Tirbeo digest')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{count}} new updates')}
      ${body('Hi {{name}},')}
      ${body('Here is your Tirbeo activity summary.')}
      <div style="margin:20px 0;">
        {{digestItems}}
      </div>
      {{activitySection}}
      ${btn('{{dashboardUrl}}', 'View updates')}
      ${small(
        'You receive this email because you enabled periodic summaries.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  product_update: (logo) =>
    tpl(
      '{{title}}',
      `${head('Product update')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{title}}')}
      ${body('Hi {{name}},')}
      ${body('{{message}}')}
      ${btn('{{ctaUrl}}', '{{ctaLabel}}')}
      ${small(
        'You are receiving this as part of your account communications.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  weekly_summary: (logo) =>
    tpl(
      'Your Tirbeo summary — {{periodLabel}}',
      `${head('Activity summary')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Activity summary')}
      ${body('{{periodLabel}}')}
      <div style="margin:20px 0;">
        {{statRows}}
      </div>
      {{suspiciousSection}}
      ${btn(`${DASHBOARD_URL}/activity/history`, 'View activity')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  account_tip: (logo) =>
    tpl(
      'Tip: {{tipTitle}}',
      `${head('Tirbeo tip')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{tipTitle}}')}
      ${body('Hi {{name}},')}
      ${body('{{tipBody}}')}
      ${btn('{{actionUrl}}', '{{actionLabel}}')}
      ${small(
        'You can disable account tips from your notification preferences.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  reactivation: (logo) =>
    tpl(
      'We miss you on Tirbeo',
      `${head('Tirbeo')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('We miss you')}
      ${body('Hi {{name}},')}
      ${body(
        'It has been {{daysSince}} days since your last visit. Your workspace is still here whenever you need it.',
      )}
      <div style="margin:20px 0;">
        {{activitySummary}}
      </div>
      ${btn('{{dashboardUrl}}', 'Open Tirbeo')}
      ${small(
        'You can turn off inactivity reminders from your notification preferences.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  maintenance_notification: (logo) =>
    tpl(
      'Scheduled maintenance — {{maintenanceTitle}}',
      `${head('Scheduled maintenance')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{maintenanceTitle}}')}
      ${body('Hi {{name}},')}
      ${body('{{maintenanceMessage}}')}
      ${kv([
        ['Starts', '{{startTime}}'],
        ['Duration', '{{duration}}'],
        ['Ends by', '{{estimatedEnd}}'],
      ])}
      ${small(
        'Some features may be temporarily unavailable during this window.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  maintenance_complete: (logo) =>
    tpl(
      'Maintenance complete — {{maintenanceTitle}}',
      `${head('Maintenance complete')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{maintenanceTitle}} complete')}
      ${body('Hi {{name}},')}
      ${body('{{completionMessage}}')}
      ${kv([
        ['Completed', '{{completedAt}}'],
        ['Duration', '{{duration}}'],
      ])}
      ${btn('{{dashboardUrl}}', 'Open Tirbeo')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  account_suspended: (logo) =>
    tpl(
      'Your Tirbeo account has been {{statusType}}',
      `${head('Account status')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Account {{statusType}}')}
      ${body('Hi {{name}},')}
      ${body(
        'The status of your Tirbeo account has changed.',
      )}
      ${kv([
        ['Status', '{{statusType}}'],
        ['Reason', '{{reason}}'],
        ['Until', '{{untilLabel}}'],
        ['What to do', '{{actionLabel}}'],
      ])}
      ${btn('{{dashboardUrl}}/account', 'Open account')}
      ${small(
        'If you believe this action was taken in error, you can appeal from your account.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  account_deleted: (logo) =>
    tpl(
      'Your Tirbeo account is scheduled for deletion',
      `${head('Account deletion')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Deletion scheduled')}
      ${body('Hi {{name}},')}
      ${body(
        'Your Tirbeo account is scheduled for deletion.',
      )}
      ${kv([
        ['Scheduled date', '{{dateLabel}}'],
        ['Grace period', '30 days'],
        ['Data removal', 'All account data will be permanently erased'],
      ])}
      ${body(
        'You can cancel the deletion before {{dateLabel}} by signing in.',
      )}
      ${btnDanger(
        '{{dashboardUrl}}/account/security',
        'Cancel deletion',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  admin_alert: (logo) =>
    tpl(
      '[Admin] {{subject}}',
      `${head('Admin alert')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{subject}}')}
      ${body('{{message}}')}
      ${plainBlock('{{details}}')}
      ${btn('{{dashboardUrl}}', 'Open dashboard')}
      ${small('Automated administrative alert from Tirbeo.')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  system_alert: (logo) =>
    tpl(
      '[System] {{subject}}',
      `${head('System alert')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{subject}}')}
      ${body('{{message}}')}
      ${kv([
        ['Service', '{{service}}'],
        ['Time', '{{alertTime}}'],
      ])}
      ${small('Automated system alert.')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  admin_crash_report: (logo) =>
    tpl(
      '[Crash] {{severity}}: {{errorType}}',
      `${head('Crash report')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('{{severity}} crash reported')}
      ${body('{{errorType}}')}
      ${kv([
        ['Message', '{{message}}'],
        ['User', '{{userEmail}} ({{username}})'],
        ['Page', '{{url}}'],
        ['Source', '{{source}}'],
        ['Device', '{{userAgent}}'],
      ])}
      ${plainBlock(`
        <pre
          style="
            margin:0;
            font-size:12px;
            line-height:18px;
            font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
            white-space:pre-wrap;
            word-break:break-word;
            color:${TEXT};
          "
        >{{stack}}</pre>
      `)}
      ${btn(DASHBOARD_URL, 'Open dashboard')}
      ${small('Automated crash report from Tirbeo.')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  export_ready: (logo) =>
    tpl(
      'Your data has been exported',
      `${head('Data export')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Your export is ready')}
      ${body('Hi {{name}},')}
      ${body(
        'Your Tirbeo data export was generated successfully.',
      )}
      ${kv([
        ['Generated', '{{exportedAt}}'],
        ['Format', 'JSON'],
      ])}
      ${SECURITY_NOTE}
      ${small(
        "If this wasn't you, change your password immediately.",
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_submission_confirmation: (logo) =>
    tpl(
      'Your response to {{formTitle}} was recorded',
      `${head('Response recorded')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Response recorded')}
      ${body(
        'Your response to <strong>{{formTitle}}</strong> was recorded successfully.',
      )}
      ${btn('{{formUrl}}', 'View form')}
      ${small(
        'You received this email because you submitted a response to this form.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_response: (logo) =>
    tpl(
      'New response to "{{formTitle}}"',
      `${head('New response')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('New response')}
      ${body(
        'Someone submitted a response to <strong>{{formTitle}}</strong>.',
      )}
      ${kv([
        ['Respondent', '{{respondentName}}'],
        ['Submitted', '{{submittedAt}}'],
      ])}
      <div style="margin:20px 0;">
        {{answers}}
      </div>
      ${btn('{{adminUrl}}', 'View response')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_notification: (logo) =>
    tpl(
      'New form submission: {{formTitle}}',
      `${head('New submission')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('New submission')}
      ${body(
        'A new submission was received on <strong>{{formTitle}}</strong>.',
      )}
      <div style="margin:20px 0;">
        {{submissionData}}
      </div>
      ${btn('{{formUrl}}', 'View submission')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_flagged: (logo) =>
    tpl(
      'Your form "{{formTitle}}" was flagged',
      `${head('Form flagged')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Form flagged')}
      ${body(
        'Your form <strong>{{formTitle}}</strong> was flagged for manual review.',
      )}
      ${kv([
        ['Reason', '{{reason}}'],
        ['Flagged at', '{{flaggedAt}}'],
      ])}
      ${btn('{{adminUrl}}', 'View details')}
      ${small(
        'If you believe this was incorrect, contact the Tirbeo team.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_published: (logo) =>
    tpl(
      'Your form "{{formTitle}}" is now live',
      `${head('Form published')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Your form is live')}
      ${body(
        '<strong>{{formTitle}}</strong> is now accepting responses.',
      )}
      ${btn('{{formUrl}}', 'View form')}
      ${small(
        'You can pause, edit, or unpublish the form from your dashboard.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_closed: (logo) =>
    tpl(
      'Your form "{{formTitle}}" has been closed',
      `${head('Form closed')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Form closed')}
      ${body(
        '<strong>{{formTitle}}</strong> is no longer accepting responses.',
      )}
      ${small(
        'Existing responses remain available from your dashboard.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_deleted: (logo) =>
    tpl(
      'Your form "{{formTitle}}" has been deleted',
      `${head('Form deleted')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Form deleted')}
      ${body(
        '<strong>{{formTitle}}</strong> and its data were permanently deleted.',
      )}
      ${small('This action cannot be undone.')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_archived: (logo) =>
    tpl(
      'Your form "{{formTitle}}" has been archived',
      `${head('Form archived')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Form archived')}
      ${body(
        '<strong>{{formTitle}}</strong> was moved to your archive.',
      )}
      ${small(
        'The form stops collecting responses, but existing data remains available.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  response_updated: (logo) =>
    tpl(
      'A response to "{{formTitle}}" was updated',
      `${head('Response updated')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Response updated')}
      ${body(
        'A response on <strong>{{formTitle}}</strong> was modified.',
      )}
      ${kv([
        ['Response ID', '{{responseId}}'],
        ['Updated', '{{updatedAt}}'],
      ])}
      ${btn('{{adminUrl}}', 'View response')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  response_deleted: (logo) =>
    tpl(
      'A response to "{{formTitle}}" was deleted',
      `${head('Response deleted')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Response deleted')}
      ${body(
        'A response on <strong>{{formTitle}}</strong> was deleted.',
      )}
      ${kv([
        ['Response ID', '{{responseId}}'],
        ['Deleted', '{{deletedAt}}'],
      ])}
      ${footer()}
      ${wrapEnd()}`,
    ),

  ticket_created: (logo) =>
    tpl(
      'Support ticket opened: {{ticketSubject}}',
      `${head('Support ticket')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Support ticket opened')}
      ${body(
        'Your support ticket was created successfully.',
      )}
      ${kv([
        ['Ticket ID', '{{ticketId}}'],
        ['Subject', '{{ticketSubject}}'],
        ['Status', '{{ticketStatus}}'],
      ])}
      ${btn('{{ticketUrl}}', 'View ticket')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  ticket_updated: (logo) =>
    tpl(
      'Update on your support ticket {{ticketId}}',
      `${head('Ticket update')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Ticket updated')}
      ${body(
        'There is new activity on your support ticket.',
      )}
      ${plainBlock(`
        <p
          style="
            margin:0;
            font-size:14px;
            line-height:22px;
            color:${TEXT};
            white-space:pre-wrap;
          "
        >
          {{updateMessage}}
        </p>
      `)}
      ${kv([
        ['Ticket ID', '{{ticketId}}'],
        ['Subject', '{{ticketSubject}}'],
        ['Status', '{{ticketStatus}}'],
      ])}
      ${btn('{{ticketUrl}}', 'View ticket')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  ticket_closed: (logo) =>
    tpl(
      'Your support ticket {{ticketId}} has been closed',
      `${head('Ticket closed')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Ticket closed')}
      ${body(
        'Your support ticket has been closed.',
      )}
      ${kv([
        ['Ticket ID', '{{ticketId}}'],
        ['Subject', '{{ticketSubject}}'],
        ['Status', 'Closed'],
      ])}
      ${btn('{{ticketUrl}}', 'View ticket')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  ticket_reopened: (logo) =>
    tpl(
      'Your support ticket {{ticketId}} has been reopened',
      `${head('Ticket reopened')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Ticket reopened')}
      ${body(
        'Your support ticket has been reopened and is active again.',
      )}
      ${kv([
        ['Ticket ID', '{{ticketId}}'],
        ['Subject', '{{ticketSubject}}'],
        ['Status', 'Open'],
      ])}
      ${btn('{{ticketUrl}}', 'View ticket')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  ticket_replied: (logo) =>
    tpl(
      'New reply on your support ticket {{ticketId}}',
      `${head('Ticket reply')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('New reply')}
      ${body(
        'You received a new reply on your support ticket.',
      )}
      ${plainBlock(`
        <p
          style="
            margin:0;
            font-size:14px;
            line-height:22px;
            color:${TEXT};
            white-space:pre-wrap;
            word-break:break-word;
          "
        >
          {{replyContent}}
        </p>
      `)}
      ${kv([
        ['Ticket ID', '{{ticketId}}'],
        ['Subject', '{{ticketSubject}}'],
        ['Replied by', '{{replierName}}'],
      ])}
      ${btn('{{ticketUrl}}', 'View ticket')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_auto_reply: (logo) =>
    tpl(
      'Thanks for submitting to {{formTitle}}',
      `${head('Submission received')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Submission received')}
      ${body(
        'Your response to <strong>{{formTitle}}</strong> was received successfully.',
      )}
      <div style="margin:20px 0;">
        {{fieldsRows}}
      </div>
      ${kv([
        ['Submission ID', '{{submissionId}}'],
        ['Received', '{{submittedAt}}'],
      ])}
      ${small(
        'No further action is needed.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_submission_notification: (logo) =>
    tpl(
      'New submission on {{formTitle}}',
      `${head('New submission')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('New submission')}
      ${body(
        'A new submission was received on <strong>{{formTitle}}</strong>.',
      )}
      <div style="margin:20px 0;">
        {{fieldRows}}
      </div>
      ${kv([
        ['Submission ID', '{{submissionId}}'],
        ['Received', '{{submittedAt}}'],
        ['IP address', '{{ip}}'],
      ])}
      ${btn('{{viewUrl}}', 'View submission')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  admin_test: (logo) =>
    tpl(
      'Test email from Tirbeo',
      `${head('Test email')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Email is working')}
      ${body(
        'This test confirms that email delivery for <strong>{{sentFor}}</strong> is working correctly.',
      )}
      ${small(
        'No action is needed. This was only a configuration test.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),
};

/* -------------------------------------------------------------------------- */
/* Form notification templates                                                 */
/* -------------------------------------------------------------------------- */

export const FORM_NOTIFICATION_TEMPLATES: Record<
  string,
  (logo: string) => EmailTemplate
> = {
  form_milestone: (logo) =>
    tpl(
      'Milestone: {{formTitle}} reached {{milestone}} responses',
      `${head('Form milestone')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Milestone reached')}
      ${body(
        '<strong>{{formTitle}}</strong> reached {{milestone}} responses.',
      )}
      ${btn('{{adminUrl}}', 'View form')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_spike: (logo) =>
    tpl(
      'Response spike detected on "{{formTitle}}"',
      `${head('Response spike')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Response spike detected')}
      ${body(
        '<strong>{{formTitle}}</strong> received an unusual burst of responses.',
      )}
      ${kv([
        ['Last 10 minutes', '{{responseCount}} responses'],
        ['Total', '{{totalResponses}}'],
      ])}
      ${btn('{{adminUrl}}', 'View responses')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_revival: (logo) =>
    tpl(
      'Your form "{{formTitle}}" is active again',
      `${head('Form activity')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('New activity')}
      ${body(
        '<strong>{{formTitle}}</strong> received a new response after a quiet period.',
      )}
      ${btn('{{adminUrl}}', 'View responses')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_test: (logo) =>
    tpl(
      'Test notification: {{formTitle}}',
      `${head('Test notification')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Notifications are working')}
      ${body(
        'This is a test notification for <strong>{{formTitle}}</strong>.',
      )}
      ${small(
        'No action is needed.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_summary_daily: (logo) =>
    tpl(
      'Daily Summary: {{formTitle}} — {{newResponses}} new responses',
      `${head('Daily summary')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Daily summary')}
      ${body('<strong>{{formTitle}}</strong>')}
      ${kv([
        ['New responses', '{{newResponses}}'],
        ['Total responses', '{{totalResponses}}'],
      ])}
      ${btn('{{adminUrl}}', 'View analytics')}
      ${small(
        'Daily summaries can be managed from your notification preferences.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_summary_weekly: (logo) =>
    tpl(
      'Weekly Summary: {{formTitle}} — {{newResponses}} new responses',
      `${head('Weekly summary')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Weekly summary')}
      ${body('<strong>{{formTitle}}</strong>')}
      ${kv([
        ['New responses', '{{newResponses}}'],
        ['Total responses', '{{totalResponses}}'],
      ])}
      ${btn('{{adminUrl}}', 'View analytics')}
      ${small(
        'Weekly summaries can be managed from your notification preferences.',
      )}
      ${footer()}
      ${wrapEnd()}`,
    ),

  webhook_failed: (logo) =>
    tpl(
      'Webhook delivery failed for "{{formTitle}}"',
      `${head('Webhook failed')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Webhook delivery failed')}
      ${body(
        'A webhook connected to <strong>{{formTitle}}</strong> could not deliver its payload. Your form responses are still stored normally.',
      )}
      ${kv([
        ['Endpoint', '{{webhookUrl}}'],
        ['HTTP status', '{{httpStatus}}'],
        ['Error', '{{errorMessage}}'],
      ])}
      ${btn('{{settingsUrl}}', 'Check settings')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  collaborator_added: (logo) =>
    tpl(
      'You have been added as a collaborator to "{{formTitle}}"',
      `${head('Collaborator access')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('You were added as a collaborator')}
      ${body(
        'You have been given <strong>{{role}}</strong> access to <strong>{{formTitle}}</strong>.',
      )}
      ${kv([
        ['Role', '{{role}}'],
        ['Added by', '{{addedByName}}'],
      ])}
      ${btn('{{formUrl}}', 'Open form')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  response_limit_reached: (logo) =>
    tpl(
      'Response limit reached for "{{formTitle}}"',
      `${head('Response limit')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Response limit reached')}
      ${body(
        '<strong>{{formTitle}}</strong> reached its configured response limit and has stopped accepting submissions.',
      )}
      ${btn('{{settingsUrl}}', 'Update settings')}
      ${footer()}
      ${wrapEnd()}`,
    ),

  form_scheduled: (logo) =>
    tpl(
      'Your form "{{formTitle}}" will open on {{scheduledAt}}',
      `${head('Form scheduled')}
      ${wrapStart()}
      ${logoBlock(logo)}
      ${title('Form scheduled')}
      ${body(
        '<strong>{{formTitle}}</strong> is scheduled to open automatically.',
      )}
      ${kv([
        ['Opens at', '{{scheduledAt}}'],
      ])}
      ${btn('{{adminUrl}}', 'View form')}
      ${footer()}
      ${wrapEnd()}`,
    ),
};

/* -------------------------------------------------------------------------- */
/* Build templates                                                             */
/* -------------------------------------------------------------------------- */

export function buildTemplates(
  logoUrl: string = '',
): Record<string, EmailTemplate> {
  const logo = logoUrl || '';

  const result: Record<string, EmailTemplate> = {};

  for (const [key, fn] of Object.entries(EMAIL_TEMPLATES)) {
    result[key] = fn(logo);
  }

  for (const [key, fn] of Object.entries(FORM_NOTIFICATION_TEMPLATES)) {
    if (!result[key]) {
      result[key] = fn(logo);
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const RAW_HTML_VARS = new Set([
  'unsubscribeSection',
  'managePreferencesUrl',
  'digestItems',
  'activitySection',
  'statRows',
  'suspiciousSection',
  'submissionData',
  'answers',
  'details',
  'fieldsRows',
  'fieldRows',
  'activitySummary',
]);

export function renderTemplate(
  html: string,
  vars: Record<string, string>,
): string {
  let result = html;

  for (const [key, val] of Object.entries(vars)) {
    const pattern = new RegExp(
      `\\{\\{\\s*${key}\\s*\\}\\}`,
      'gi',
    );

    if (RAW_HTML_VARS.has(key)) {
      result = result.replace(pattern, val);
    } else {
      const escaped = val.replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c] || c,
      );

      result = result.replace(pattern, escaped);
    }
  }

  return result;
} 