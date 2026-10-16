import { getApiOrigin } from '@/features/branding/branding';
import { getDashboardBaseUrl, prodSafeEnvUrl } from '@/config/app-urls';
import { BTN, FAINT, FONT_STACK, MONO, MUTED, TEXT, TEXT_2 } from '@/features/email/email-theme';

/**
 * The built-in email catalogue.
 *
 * Plain string templates — no React, no component library, no table layouts and
 * no Outlook conditional comments. A mail is a heading, a few paragraphs, one
 * code or button, and a footer; a `div` with inline styles does all of it in
 * every client that matters. Dropping the render pass also drops the reason the
 * send path used to need a cache: building one of these is a string join.
 *
 * Templates declare their values as `{{name}}` and leave substitution to
 * `renderTemplate` at send time, so the rendered text is cacheable per logo and
 * one template can be reused across many recipients.
 */

export type EmailTemplate = { subject: string; html: string };

const DASHBOARD_URL = () => getDashboardBaseUrl();
const SESSIONS_URL = () => `${getDashboardBaseUrl()}/account/sessions`;

// Workspace / profile destination for email CTAs. Ops can point this at either
// host via NEXT_PUBLIC_MYPROFILE_URL (or NEXT_PUBLIC_WORKSPACE_URL); it falls
// back to the dashboard address so no deployment is left with a broken "Open
// your workspace" link.
const WORKSPACE_URL = () => (
  prodSafeEnvUrl(process.env.NEXT_PUBLIC_MYPROFILE_URL) ||
  prodSafeEnvUrl(process.env.NEXT_PUBLIC_WORKSPACE_URL) ||
  getDashboardBaseUrl()
).replace(/\/+$/, '');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'admin@tirbeo.com';

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!,
  );

/** Body copy. The argument is markup we control, already interpolated. */
const para = (text: string): string =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:25px;color:${TEXT_2}">${text}</p>`;

/** Quiet helper copy: expiry rules, what to do if it wasn't you. */
const note = (text: string): string =>
  `<p style="margin:0 0 12px;font-size:13.5px;line-height:21px;color:${MUTED}">${text}</p>`;

const caption = (text: string): string =>
  `<p style="margin:8px 0 16px;font-size:12.5px;line-height:18px;color:${MUTED};text-align:center">${text}</p>`;

/** The one-time code. Monospace and centred, no plate around it. */
const code = (value: string, hint?: string): string =>
  `<div style="margin:26px 0 6px;text-align:center;font-family:${MONO};font-size:26px;line-height:34px;font-weight:700;letter-spacing:6px;text-indent:6px;color:${TEXT}">${value}</div>`
  + (hint ? caption(hint) : '');

/** A secret that must be transcribed exactly — no wide tracking, selectable. */
const secret = (value: string, hint?: string): string =>
  `<div style="margin:26px 0 6px;text-align:center;font-family:${MONO};font-size:20px;line-height:28px;font-weight:600;color:${TEXT};word-break:break-all">${value}</div>`
  + (hint ? caption(hint) : '');

type BtnVariant = 'primary' | 'ghost' | 'danger';

const button = (url: string, label: string, variant: BtnVariant = 'primary'): string => {
  const href = esc(url);
  const text = esc(label);
  if (variant === 'ghost') {
    return `<p style="margin:12px 0 0;text-align:center">`
      + `<a href="${href}" style="color:${BTN};font-size:15px;font-weight:600;text-decoration:none">${text}</a></p>`;
  }
  const bg = variant === 'danger' ? '#b42318' : BTN;
  return `<p style="margin:22px 0 0;text-align:center">`
    + `<a href="${href}" style="display:inline-block;padding:12px 26px;background:${bg};border-radius:4px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${text}</a></p>`;
};

const btn = (url: string, label: string): string => button(url, label, 'primary');
const btnGhost = (url: string, label: string): string => button(url, label, 'ghost');
const btnDanger = (url: string, label: string): string => button(url, label, 'danger');

/** Detail rows — what happened, when, from where. Label above value. */
const well = (pairs: Array<[string, string]>): string =>
  `<div style="margin:22px 0">`
  + pairs.map(([key, value]) =>
      `<div style="margin:0 0 10px">`
      + `<div style="font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}">${key}</div>`
      + `<div style="font-size:14.5px;line-height:21px;color:${TEXT};word-break:break-word">${value}</div>`
      + `</div>`)
    .join('')
  + `</div>`;

/** One heading and one paragraph, tinted by tone only through the heading. */
const callout = (heading: string, text: string, color = BTN): string =>
  `<div style="margin:20px 0">`
  + `<div style="font-size:14px;line-height:21px;font-weight:700;color:${color}">${heading}</div>`
  + `<div style="font-size:14px;line-height:22px;color:${TEXT_2}">${text}</div>`
  + `</div>`;

/** A slot that already holds finished markup. */
const raw = (content: string): string => `<div style="margin:20px 0">${content}</div>`;

const INFO = BTN;
const WARN = '#b45309';
const DANGER = '#b42318';

/* The standard "this did not come from us" warning. */
const safetyNote = (): string =>
  callout(
    'We will never ask for it',
    'Tirbeo will not ask for your password or a verification code by email, phone or chat. Anything that does did not come from us.',
    INFO,
  );

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

type MailOpts = {
  title: string;
  /** One line under the headline. May contain markup. */
  sub?: string;
  blocks: string[];
  /** The grey line the inbox shows beside the subject. Kept separate from
      `title` because the best preheader answers "why did I get this?" instead
      of repeating the headline. */
  preheader?: string;
};

/**
 * The shared shell: one centred column, the brand, the headline, the blocks and
 * the footer. Templates hand over blocks only, so no template can forget the
 * footer — that is where the unsubscribe link lives.
 */
function mail(logo: string, opts: MailOpts): string {
  const { title, sub, blocks, preheader } = opts;
  const pre = esc(preheader || sub || title);
  const src = esc(logo || `${getApiOrigin()}/logo.png`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:24px 16px;background:#ffffff;color:${TEXT};font-family:${FONT_STACK};line-height:1.6;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0" data-skip-in-text="true">${pre}&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;</div>
<div style="max-width:560px;margin:0 auto">
<div style="text-align:center;margin:0 0 22px"><img src="${src}" width="26" height="26" alt="Tirbeo" style="display:inline-block;vertical-align:middle;width:26px;height:26px"> <span style="vertical-align:middle;font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${TEXT}">Tirbeo</span></div>
<h1 style="margin:0 0 12px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.011em;color:${TEXT};text-align:center">${title}</h1>
${sub ? `<p style="margin:0 0 22px;font-size:15.5px;line-height:25px;color:${MUTED};text-align:center">${sub}</p>` : ''}
${blocks.join('\n')}
<div style="margin:32px 0 0;padding-top:16px;border-top:1px solid #eceef1;text-align:center">
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${MUTED}">Questions? <a href="mailto:${esc(SUPPORT_EMAIL)}" style="color:${BTN};text-decoration:underline">${SUPPORT_EMAIL}</a></p>
<p style="margin:0;font-size:12.5px;line-height:19px;color:${FAINT}">Tirbeo Inc. &middot; Kathmandu, Nepal</p>
<p style="margin:2px 0 0;font-size:12.5px;line-height:19px;color:${FAINT}">&copy; ${new Date().getFullYear()} Tirbeo Inc. All rights reserved.</p>
<div style="margin:6px 0 0;font-size:12.5px;line-height:19px;color:${FAINT}">{{unsubscribeSection}}</div>
</div>
</div>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

function t(subject: string, opts: MailOpts, logo: string): EmailTemplate {
  return { subject, html: mail(logo, opts) };
}

export const EMAIL_TEMPLATES: Record<string, (logo: string) => EmailTemplate> = {
  signup_otp: (logo) =>
    t('Your Tirbeo verification code is {{otp}}', {
      title: 'Verify your email',
      sub: 'Enter this code to activate your Tirbeo account.',
      preheader: 'It expires in 15 minutes and works once.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        note("Didn’t sign up for Tirbeo? You can safely ignore this email — no account will be created."),
      ],
    }, logo),

  login_otp: (logo) =>
    t('Your Tirbeo login code is {{otp}}', {
      title: 'Your login code',
      sub: 'Enter this code to finish signing in to Tirbeo.',
      preheader: 'It expires in 15 minutes and works once.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        note("Didn’t try to sign in? Change your password and review your active sessions — someone else has your code."),
        btn(SESSIONS_URL(), 'Review my sessions'),
      ],
    }, logo),

  /* A code that confirms an action inside an already-signed-in account. Its own
     template because the login mail says "finish signing in", and this code
     expires on the sensitive-action clock, not the login one. */
  reauth_otp: (logo) =>
    t('Your Tirbeo confirmation code is {{otp}}', {
      title: 'Confirm this change',
      sub: 'Enter this code to confirm a change on your Tirbeo account.',
      preheader: 'One change, one code — it does not sign anyone in.',
      blocks: [
        code('{{otp}}', `Expires in {{lifetimeMinutes}} minutes &middot; single use`),
        safetyNote(),
        note('This code confirms one change. It does not sign anyone in to your account.'),
      ],
    }, logo),

  verify_email: (logo) =>
    t('Verify your Tirbeo email: {{otp}}', {
      title: 'Confirm {{primaryEmail}}',
      sub: 'Enter this code to confirm your email address.',
      preheader: 'It expires in 10 minutes and works once.',
      blocks: [
        code('{{otp}}', 'Expires in 10 minutes &middot; single use'),
        note("Didn’t request this code? You can safely ignore this email."),
      ],
    }, logo),

  magic_link: (logo) =>
    t('Sign in to Tirbeo', {
      title: 'One tap to sign in',
      sub: 'Hello {{name}}, we received a request to sign you in to Tirbeo.',
      preheader: 'This link expires in 15 minutes and works once.',
      blocks: [
        btn('{{magicLink}}', 'Sign in to Tirbeo'),
        note('This link expires in 15 minutes and can only be used once.'),
        note("Didn’t request this link? Ignore the email — nobody signed in with it."),
      ],
    }, logo),

  password_reset_otp: (logo) =>
    t('Your Tirbeo password reset code is {{otp}}', {
      title: 'Reset your password',
      sub: 'Enter this code to continue resetting the password for {{primaryEmail}}.',
      preheader: 'Your password has not been changed yet.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        safetyNote(),
        note("Didn’t request a reset? Your password is still yours and nothing has changed."),
      ],
    }, logo),

  password_reset_otp_recovery: (logo) =>
    t('Password reset code for {{primaryEmail}}: {{otp}}', {
      title: 'Code sent to your recovery email',
      sub: 'A reset was requested for <strong>{{primaryEmail}}</strong>. The code went to your recovery address <strong>{{recoveryEmail}}</strong>.',
      preheader: 'Your password has not been changed yet.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        well([
          ['Account', '{{primaryEmail}}'],
          ['Recovery email', '{{recoveryEmail}}'],
        ]),
        safetyNote(),
        note("Didn’t request this reset? Your password has not been changed."),
      ],
    }, logo),

  delete_account_otp: (logo) =>
    t('Confirm deleting your Tirbeo account: {{otp}}', {
      title: 'Confirm account deletion',
      sub: 'Hello {{name}}, enter this code to confirm that you want to delete {{primaryEmail}}.',
      preheader: 'Deletion starts a 30-day grace period you can cancel from.',
      blocks: [
        code('{{otp}}', `Expires in {{lifetimeMinutes}} minutes &middot; single use`),
        callout(
          'What happens next',
          'Nothing is deleted by this email. Confirming starts a 30-day grace period, and you can cancel it by signing in at any time.',
          WARN,
        ),
        safetyNote(),
      ],
    }, logo),

  password_reset_link: (logo) =>
    t('Reset your Tirbeo password', {
      title: 'Choose a new password',
      sub: 'Hello {{name}}, we received a request to reset your Tirbeo password.',
      preheader: 'This link expires in 15 minutes and works once.',
      blocks: [
        btn('{{resetUrl}}', 'Reset password'),
        note('This link expires in 15 minutes and can only be used once.'),
        note("Didn’t request this? Your password has not been changed and you can ignore this email."),
        safetyNote(),
      ],
    }, logo),

  password_changed: (logo) =>
    t('Your Tirbeo password was changed', {
      title: 'Your password was changed',
      sub: 'Hello {{name}}, the password for {{primaryEmail}} was changed.',
      preheader: 'If that wasn’t you, act now — the next mail is on us.',
      blocks: [
        well([
          ['When', '{{changedAt}}'],
          ['IP address', '{{ipAddress}}'],
        ]),
        para('If this wasn’t you, someone else can sign in to your account. Reset the password and end every session you do not recognise.'),
        btn(`${DASHBOARD_URL()}/settings/security`, 'Secure my account'),
        btnGhost(SESSIONS_URL(), 'Review active sessions'),
      ],
    }, logo),

  suspicious_login: (logo) =>
    t('New sign-in to your Tirbeo account — was that you?', {
      title: 'A sign-in we did not expect',
      sub: 'Your Tirbeo account was just signed in to from a device we have not seen before.',
      preheader: 'If that wasn’t you, change your password now.',
      blocks: [
        well([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
          ['IP address', '{{ipAddress}}'],
        ]),
        callout(
          "If this wasn't you",
          'Change your password right away and end the sessions you do not recognise. Anyone with this session can read and change your account.',
          DANGER,
        ),
        btnDanger(SESSIONS_URL(), 'Review my account'),
        note('Was it you? Nothing to do — this email is informational.'),
        safetyNote(),
      ],
    }, logo),

  two_factor_disabled: (logo) =>
    t('Two-step verification was turned off', {
      title: 'Two-step verification is off',
      sub: 'Two-step verification was just turned off on {{primaryEmail}}. Your password is now the only thing protecting the account.',
      preheader: 'Turn it back on if that wasn’t you.',
      blocks: [
        well([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
        ]),
        btn('{{twoFactorUrl}}', 'Turn two-step back on'),
        callout(
          'If this was not you',
          'Someone with access to your account turned this off. Change your password, then re-enable two-step verification.',
          WARN,
        ),
        safetyNote(),
      ],
    }, logo),

  login_alert: (logo) =>
    t('New sign-in to your Tirbeo account', {
      title: 'New sign-in',
      sub: 'Your Tirbeo account was just accessed.',
      preheader: 'Recognise this device? If not, revoke it.',
      blocks: [
        well([
          ['Time', '{{loginTime}}'],
          ['Device', '{{device}}'],
          ['Location', '{{location}}'],
        ]),
        btn(SESSIONS_URL(), 'Review sessions'),
        note("Don’t recognise this sign-in? Change your password immediately — revoke this session while you are there."),
      ],
    }, logo),

  security_tip: (logo) =>
    t('{{tipTitle}}', {
      title: '{{tipTitle}}',
      sub: 'Hello {{name}}, one thing your account does not have set up yet.',
      preheader: 'A single change that makes your account harder to break into.',
      blocks: [
        para('{{tipBody}}'),
        btn('{{actionUrl}}', '{{actionLabel}}'),
        note('We send one tip at a time, picked from what your account does not have set up yet.'),
      ],
    }, logo),

  account_recovery: (logo) =>
    t('Recover your Tirbeo account', {
      title: 'Recover your account',
      sub: 'Hello {{name}}, we received a request to recover {{primaryEmail}}.',
      preheader: 'This link expires in 15 minutes and works once.',
      blocks: [
        btn('{{recoveryUrl}}', 'Recover account'),
        note('This link expires in 15 minutes and can only be used once.'),
        note("Didn’t request this? Ignore this email — nothing has changed."),
        safetyNote(),
      ],
    }, logo),

  welcome: (logo) =>
    t('Welcome to Tirbeo, {{name}}', {
      title: 'Your workspace is ready',
      sub: 'Hello {{name}}, your Tirbeo account is created and everything is set up.',
      preheader: 'Three minutes of setup, and you are done.',
      blocks: [
        para('Sign in to manage your profile, security and workspace settings from one place.'),
        btn(WORKSPACE_URL(), 'Open your workspace'),
        btnGhost(`${WORKSPACE_URL()}/settings`, 'Set up your profile'),
        para('From there you can review your personal information, account details, notification preferences and security settings.'),
        callout(
          'First thing worth doing',
          'Turn on two-step verification under <strong>Settings → Security</strong>. It is the one setting that makes a stolen password useless.',
          '#15803d',
        ),
        para(`Need a hand? Write to ${SUPPORT_EMAIL} and a person will answer.`),
      ],
    }, logo),

  notification_digest: (logo) =>
    t('Your Tirbeo digest — {{count}} updates', {
      title: '{{count}} new updates',
      sub: 'Hello {{name}}, here is what has been waiting for you.',
      preheader: 'Everything from the last few hours, in one place.',
      blocks: [
        raw('{{digestItems}}'),
        raw('{{activitySection}}'),
        btn('{{dashboardUrl}}', 'View updates'),
        note('You get this because you turned periodic summaries on. Turn it off any time from your notification settings.'),
      ],
    }, logo),

  product_update: (logo) =>
    t('{{title}}', {
      title: '{{title}}',
      sub: 'Hello {{name}}, a change you may want to know about.',
      preheader: '{{title}} — what it means for your account.',
      blocks: [
        para('{{message}}'),
        btn('{{ctaUrl}}', '{{ctaLabel}}'),
        note('You are receiving this as part of your account communications.'),
      ],
    }, logo),

  weekly_summary: (logo) =>
    t('Your Tirbeo week — {{periodLabel}}', {
      title: 'What happened this week',
      sub: '{{periodLabel}}',
      preheader: 'Your Tirbeo account, recapped in thirty seconds.',
      blocks: [
        para('Hello {{name}}, here is the shape of your week.'),
        raw('{{statRows}}'),
        raw('{{suspiciousSection}}'),
        btn(`${DASHBOARD_URL()}/settings/your-activity`, 'View activity'),
      ],
    }, logo),

  reactivation: (logo) =>
    t('Your Tirbeo workspace is still here, {{name}}', {
      title: 'Nothing was lost',
      sub: `It has been {{daysSince}} days since your last visit, {{name}}. Your workspace is exactly where you left it.`,
      preheader: 'Your data, forms and settings are untouched.',
      blocks: [
        raw('{{activitySummary}}'),
        btn('{{dashboardUrl}}', 'Open Tirbeo'),
        note('Inactivity reminders are one of the email categories you can turn off in notification settings.'),
      ],
    }, logo),

  maintenance_notification: (logo) =>
    t('Scheduled maintenance — {{maintenanceTitle}}', {
      title: '{{maintenanceTitle}}',
      sub: '{{maintenanceMessage}}',
      preheader: 'What is affected, and when it should be back.',
      blocks: [
        well([
          ['Starts', '{{startTime}}'],
          ['Duration', '{{duration}}'],
          ['Ends by', '{{estimatedEnd}}'],
        ]),
        note('Some features may be briefly unavailable during this window. Nothing you have saved is affected.'),
      ],
    }, logo),

  maintenance_complete: (logo) =>
    t('Maintenance complete — {{maintenanceTitle}}', {
      title: '{{maintenanceTitle}} is complete',
      sub: '{{completionMessage}}',
      preheader: 'Everything is back and running.',
      blocks: [
        well([
          ['Completed', '{{completedAt}}'],
          ['Duration', '{{duration}}'],
        ]),
        btn('{{dashboardUrl}}', 'Open Tirbeo'),
      ],
    }, logo),

  account_suspended: (logo) =>
    t('Your Tirbeo account has been {{statusType}}', {
      title: 'Your account is {{statusType}}',
      sub: 'Hello {{name}}, the status of {{primaryEmail}} has changed.',
      preheader: 'Why it changed, how long it lasts, and what you can do.',
      blocks: [
        well([
          ['Status', '{{statusType}}'],
          ['Reason', '{{reason}}'],
          ['Until', '{{suspendedUntil}}'],
          ['What to do', '{{suspendedNextStep}}'],
        ]),
        btn('{{dashboardUrl}}/account', 'Open my account'),
        note('Believe this was a mistake? Appeal it from your account and a person will read it.'),
      ],
    }, logo),

  account_deleted: (logo) =>
    t('Your Tirbeo account is scheduled for deletion', {
      title: 'Deletion scheduled',
      sub: 'Hello {{name}}, {{primaryEmail}} is scheduled for deletion.',
      preheader: 'You can still cancel until that date.',
      blocks: [
        well([
          ['Scheduled date', '{{dateLabel}}'],
          ['Grace period', '30 days'],
          ['Data removal', 'All account data is erased permanently'],
        ]),
        para('You can stop this at any time before the scheduled date by signing in.'),
        btnDanger('{{dashboardUrl}}/account/security', 'Cancel deletion'),
        note('After the grace period the data is gone and cannot be recovered by anyone, including us.'),
      ],
    }, logo),

  admin_alert: (logo) =>
    t('[Admin] {{subject}}', {
      title: '{{subject}}',
      sub: '{{message}}',
      preheader: '{{subject}} — details inside.',
      blocks: [
        raw('{{details}}'),
        btn('{{dashboardUrl}}', 'Open dashboard'),
        note('Automated administrative alert from Tirbeo.'),
      ],
    }, logo),

  export_ready: (logo) =>
    t('Your Tirbeo data export is ready', {
      title: 'Your export is ready',
      sub: 'Hello {{name}}, the export you requested for {{primaryEmail}} was generated.',
      preheader: 'One JSON archive, everything on your account.',
      blocks: [
        well([
          ['Generated', '{{exportedAt}}'],
          ['Format', 'JSON'],
        ]),
        para('Open your account settings to download the archive. The link is available for a limited time.'),
        btn(`${DASHBOARD_URL()}/settings`, 'Open my account'),
        safetyNote(),
      ],
    }, logo),

  admin_test: (logo) =>
    t('Test email from Tirbeo', {
      title: 'Email is working',
      sub: 'This test confirms that delivery for <strong>{{sentFor}}</strong> is working.',
      preheader: 'No action needed — this was a configuration test.',
      blocks: [
        note('Nothing else was sent. This message only checked that a message can reach this address.'),
      ],
    }, logo),

  tirbeo_account_onboarding: (logo) =>
    t('Your Tirbeo account is ready: {{username}}@tirbeo.com', {
      title: '{{username}}@tirbeo.com',
      sub: 'Hello {{name}}, this is your Tirbeo identity — your username, your mail address and your sign-in. Keep it professional; it is unique to you.',
      preheader: 'Sign in with the temporary password, then replace it.',
      blocks: [
        para('Use this one-time temporary password to sign in:'),
        secret('{{password}}', 'Temporary &middot; you will be asked to replace it'),
        btn('{{accountsUrl}}', 'Open my Tirbeo account'),
        note('Your recovery email is {{recoveryEmail}}. It is used only for account recovery — it can never sign in.'),
        safetyNote(),
      ],
    }, logo),
};

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

export type TemplateMap = Record<string, EmailTemplate>;

/**
 * Rendered catalogue, keyed by logo URL.
 *
 * These templates are string concatenation, so the cache is no longer what
 * makes a send fast — it exists so `getTemplate` and `buildTemplates` hand back
 * the same object for the same branding, which callers and tests rely on.
 */
const g = globalThis as typeof globalThis & {
  __tirbeoTemplateCache?: Map<string, TemplateMap>;
  __tirbeoFullCatalog?: Set<string>;
};

function templateCache(): Map<string, TemplateMap> {
  if (!g.__tirbeoTemplateCache) g.__tirbeoTemplateCache = new Map();
  return g.__tirbeoTemplateCache;
}

/**
 * Logos whose cache entry holds the *whole* catalogue.
 *
 * `getTemplate` stores a one-entry bucket under the same key `buildTemplates`
 * uses, so a full-catalogue hit cannot be inferred from the map alone — the
 * partial bucket would look exactly like a complete one. This records which
 * entries are known-good in full.
 */
function fullCatalogs(): Set<string> {
  if (!g.__tirbeoFullCatalog) g.__tirbeoFullCatalog = new Set();
  return g.__tirbeoFullCatalog;
}

function renderAllTemplates(logoUrl: string): TemplateMap {
  const result: TemplateMap = {};
  for (const [key, fn] of Object.entries(EMAIL_TEMPLATES)) {
    result[key] = fn(logoUrl);
  }
  return result;
}

export function buildTemplates(logoUrl: string = ''): TemplateMap {
  const cache = templateCache();
  const hit = cache.get(logoUrl);
  if (hit && fullCatalogs().has(logoUrl)) return hit;
  const built = renderAllTemplates(logoUrl);
  cache.set(logoUrl, built);
  fullCatalogs().add(logoUrl);
  return built;
}

/**
 * One template by name.
 *
 * Preferred over `buildTemplates()` on the send path: a single send renders one
 * mail, not twenty-eight.
 */
export function getTemplate(name: string, logoUrl: string = ''): EmailTemplate | undefined {
  const cache = templateCache();
  const existing = cache.get(logoUrl)?.[name];
  if (existing) return existing;

  const factory = EMAIL_TEMPLATES[name];
  if (!factory) return undefined;

  const template = factory(logoUrl);
  const bucket = cache.get(logoUrl) || {};
  bucket[name] = template;
  cache.set(logoUrl, bucket);
  return template;
}

/** Drop the rendered catalogue — for tests and after a branding change. */
export function clearTemplateCache(): void {
  templateCache().clear();
  fullCatalogs().clear();
}

/* -------------------------------------------------------------------------- */
/* Variable substitution                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Variables whose value is trusted HTML and must not be escaped.
 *
 * These are the section slots built at runtime — the digest items, the weekly
 * stat rows, the suspicious-activity panel, the admin alert details. Every one
 * of them is assembled from already-escaped data upstream; escaping them again
 * here turns a working list into visible `&lt;div&gt;` markup in the inbox.
 */
export const RAW_HTML_VARS = new Set([
  'unsubscribeSection',
  'managePreferencesUrl',
  'digestItems',
  'activitySection',
  'statRows',
  'suspiciousSection',
  'activitySummary',
  'details',
]);

export function renderTemplate(
  html: string,
  vars: Record<string, string>,
  extraRawVars?: Set<string>,
): string {
  // Additive on purpose. An earlier signature defaulted the parameter to
  // RAW_HTML_VARS, so any caller passing its own set silently dropped the whole
  // canonical list and re-escaped every section slot. `extra` means extra.
  const rawVars = extraRawVars ? new Set([...RAW_HTML_VARS, ...extraRawVars]) : RAW_HTML_VARS;

  let result = html;

  for (const [key, val] of Object.entries(vars)) {
    // Keys come from our own templates and call sites, never from user input,
    // but escaping keeps a stray key from silently meaning something else.
    const pattern = new RegExp(
      `\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`,
      'gi',
    );

    result = rawVars.has(key)
      ? result.replace(pattern, val)
      : result.replace(pattern, esc(val));
  }

  return result;
}
