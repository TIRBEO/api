import { getDashboardBaseUrl, prodSafeEnvUrl } from '@/config/app-urls';
import { TIRBEO_MAIL_DOMAIN } from '@/features/identity/tirbeo';
import {
  BTN,
  CARD,
  DANGER,
  FAINT,
  FONT_STACK,
  LINE,
  LINK,
  MONO,
  MUTED,
  PAGE,
  PLATE,
  SUPPORT,
  TEXT,
  TEXT_2,
} from '@/features/email/email-theme';

/**
 * The built-in email catalogue.
 *
 * Plain string templates — no React, no component library. The shell is a
 * presentational table with fixed widths and `bgcolor` fallbacks, because a
 * div-only mail collapses or loses its canvas in Outlook and the stricter
 * clients; inside the card a `div` with inline styles does the rest in every
 * client that matters. A mail is a heading, a few paragraphs, one
 * code or button, and a footer. Dropping the render pass also drops the reason the
 * send path used to need a cache: building one of these is a string join.
 *
 * Templates declare their values as `{{name}}` and leave substitution to
 * `renderTemplate` at send time, so the rendered text is cacheable per logo and
 * one template can be reused across many recipients.
 *
 * Everything is left-aligned on pure white and reads top-to-bottom like a
 * document: the wordmark, one coloured word naming the category, an ink
 * headline, the copy, a sign-off, fine print. The only fill inside the mail is
 * the pale plate around a quoted message; every other division is a hairline.
 * Landing systemBlue marks anything pressable; everything else is ink or grey.
 */

export type EmailTemplate = { subject: string; html: string };

const DASHBOARD_URL = () => getDashboardBaseUrl();
const SESSIONS_URL = () => `${getDashboardBaseUrl()}/settings/devices`;

// Account/settings destination for email CTAs. Ops can point this at either
// host via NEXT_PUBLIC_MYPROFILE_URL (or NEXT_PUBLIC_WORKSPACE_URL); it falls
// back to the dashboard address so no deployment is left with a broken "Open
// my account" link.
const WORKSPACE_URL = () => (
  prodSafeEnvUrl(process.env.NEXT_PUBLIC_MYPROFILE_URL) ||
  prodSafeEnvUrl(process.env.NEXT_PUBLIC_WORKSPACE_URL) ||
  getDashboardBaseUrl()
).replace(/\/+$/, '');

/** The address a customer writes to. It matches the support sender below, so
 *  the reply lands in the mailbox the question came out of. */
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@tirbeo.com';

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

const esc = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!,
  );

/** A link inside a sentence. The mail's actions are links, not buttons, so
    they are underlined and carry no arrow. */
const link = (url: string, label: string): string =>
  `<a href="${esc(url)}" style="color:${LINK};text-decoration:underline">${esc(label)}</a>`;

const mailto = (address: string, label: string): string =>
  `<a href="mailto:${esc(address)}" style="color:${LINK};text-decoration:underline">${esc(label)}</a>`;

/** Body copy. The argument is markup we control, already interpolated. */
const para = (text: string): string =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${TEXT_2}">${text}</p>`;

/** Quiet helper copy: expiry rules, what to do if it wasn't you. */
const note = (text: string): string =>
  `<p style="margin:0 0 14px;font-size:13px;line-height:20px;color:${MUTED}">${text}</p>`;

/**
 * The one-time code: the digits themselves, with nothing drawn around them.
 * A plate or a border is decoration over the one line the reader actually came
 * for, and centring them would put the only non-left-aligned thing in a mail
 * that reads top-to-bottom like a document.
 */
const code = (value: string, hint?: string): string =>
  `<div style="margin:30px 0 26px"><div class="mail-code" style="font-family:${MONO};font-size:34px;line-height:42px;font-weight:bold;letter-spacing:5px;color:${TEXT}">${value}</div>${hint ? `<div style="margin-top:10px;font-size:13px;line-height:19px;color:${MUTED}">${hint}</div>` : ''}</div>`;

/** A secret that has to be transcribed exactly — the code's shape, but small
    enough to fit and left untracked so a double-click selects all of it. */
const secret = (value: string, hint?: string): string =>
  `<div style="margin:30px 0 26px"><div style="font-family:${MONO};font-size:22px;line-height:30px;font-weight:bold;color:${TEXT};word-break:break-all">${value}</div>${hint ? `<div style="margin-top:10px;font-size:13px;line-height:19px;color:${MUTED}">${hint}</div>` : ''}</div>`;

/**
 * A reference code: the short handle a person quotes and staff search by.
 *
 * One quiet line, at the end of the mail. It used to be a plate — mono, bold,
 * 20px, first thing in the body — and that read as the mail's headline, which
 * is wrong twice over: the reader came for the news, and the code is only
 * needed once, when they reply. Bold also broke the one thing it is for: a
 * bolded code in a coloured plate looks like the digits a phishing mail wants
 * you to type somewhere.
 */
const refLine = (value: string, label = 'Reference'): string =>
  `<p style="margin:18px 0 0;font-size:13px;line-height:20px;color:${MUTED}">${label} `
  + `<span style="font-family:${MONO};font-size:13px;color:${TEXT_2}">${value}</span></p>`;

/**
 * Something a person wrote, shown as what it is: their own words inside the
 * machine's mail. The panel and the pre-wrap are the point — a quote that
 * reflows into one grey soup of a paragraph is a quote nobody trusts.
 */
const messageBlock = (text: string, label = 'Your message'): string =>
  `<div style="margin:24px 0;padding:16px 18px;background:${PLATE}">`
  + `<div style="font-size:13px;line-height:19px;color:${MUTED}">${label}</div>`
  + `<div style="margin-top:8px;font-size:15px;line-height:24px;color:${TEXT};white-space:pre-wrap;word-break:break-word">${text}</div></div>`;

type BtnVariant = 'primary' | 'ghost';
/**
 * The action — an underlined sentence, never a button. A pill needs
 * `display:inline-block`, padding and a background on an anchor, which is
 * exactly the styling weaker clients strip, and a link that was meant to look
 * pressable but renders bare looks like a mistake. So the primary action is
 * bold blue text and the secondary one the same line in grey.
 *
 * A mail whose job is to deliver a code gets no `btn` at all — the reader's
 * action is transcribing digits into our app, and a call-to-action link in a
 * code mail is the exact shape of a phishing kit. Escape-hatch links in a code
 * mail are `btnGhost`.
 */
const button = (url: string, label: string, variant: BtnVariant = 'primary'): string => {
  const href = esc(url);
  const text = esc(label);
  if (variant === 'ghost') {
    return `<p style="margin:16px 0 14px;font-size:14px;line-height:22px"><a href="${href}" style="color:${MUTED};text-decoration:underline">${text}</a></p>`;
  }
  return `<p style="margin:22px 0 14px;font-size:15px;line-height:24px"><a href="${href}" style="color:${LINK};font-weight:bold;text-decoration:underline">${text}</a></p>`;
};

const btn = (url: string, label: string): string => button(url, label, 'primary');
const btnGhost = (url: string, label: string): string => button(url, label, 'ghost');

/**
 * Detail rows — what happened, when, from where.
 *
 * A divided plate rather than a loose stack: these are the facts a reader
 * compares against their own memory, so they get read in order, one line each,
 * and the hairlines carry the order without a second column of labels.
 */
const well = (pairs: Array<[string, string]>): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border-collapse:collapse">`
  + pairs.map(([key, value], i) =>
      `<tr>`
      + `<td width="120" align="left" valign="top" style="padding:9px 12px 9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:13px;line-height:20px;color:${MUTED}">${key}</td>`
      + `<td align="left" valign="top" style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font-size:15px;line-height:20px;color:${TEXT};word-break:break-word">${value}</td>`
      + `</tr>`)
    .join('')
  + `</table>`;

/**
 * A notice: what happened in one line, then the consequence.
 *
 * Plain prose with a bold lead-in — no plate, no coloured rule, no tinted
 * heading. A warning that has to look alarming to be read is a warning that
 * looks like a template, and the third row of decorated boxes in a mail is
 * what makes a legitimate notice indistinguishable from a phish.
 */
const callout = (heading: string, text: string): string =>
  `<p style="margin:0 0 16px;font-size:15px;line-height:25px;color:${TEXT_2}"><strong style="color:${TEXT}">${heading}:</strong> ${text}</p>`;

/** A slot that already holds finished markup. */
const raw = (content: string): string => `<div style="margin:24px 0">${content}</div>`;

/* The standard "this did not come from us" warning: one plain line, in the
   same voice as the rest of the copy, on every mail that carries a code. */
const safetyNote = (): string =>
  note('Tirbeo will never ask for your password or a verification code by email, phone or chat. Anything that does did not come from us.');

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
  /** The visual family of this mail. Absent means `info`. */
  tone?: Tone;
};

/* -------------------------------------------------------------------------- */
/* Tones — the category word above the headline                                */
/* -------------------------------------------------------------------------- */

export type Tone = 'otp' | 'security' | 'brand' | 'info' | 'welcome' | 'support';

/**
 * What the mail is, in one word and one colour.
 *
 * This used to be a band of colour across the top of the card with the headline
 * painted white inside it. A band says "automated message" before the reader
 * has seen a sentence, and every phish kit ships one, so the category moved to a
 * small coloured word over an ink headline — the arrangement a mail client uses
 * for its own labels, which reads as mail rather than as a flyer.
 */
const TONE_MARK: Record<Tone, { label: string; color: string }> = {
  otp: { label: 'Verification', color: BTN },
  security: { label: 'Account security', color: DANGER },
  brand: { label: 'Tirbeo', color: TEXT },
  info: { label: 'Notice', color: MUTED },
  welcome: { label: 'Welcome', color: BTN },
  support: { label: 'Support', color: SUPPORT },
};

/** Every template's family, resolved by name at render time so no template
    has to remember to declare it. Unknown names read as `info`. */
const TEMPLATE_TONES: Record<string, Tone> = {
  signup_otp: 'otp', login_otp: 'otp', reauth_otp: 'otp', verify_email: 'otp',
  magic_link: 'otp', password_reset_otp: 'otp', password_reset_otp_recovery: 'otp',
  password_reset_link: 'otp', delete_account_otp: 'otp', account_recovery: 'otp',

  password_changed: 'security', suspicious_login: 'security',
  two_factor_disabled: 'security', two_factor_enabled: 'security', login_alert: 'security', security_tip: 'security',
  account_suspended: 'security', account_deleted: 'security',
  account_deactivated: 'info',
  admin_alert: 'security', admin_test: 'security',

  welcome: 'welcome',
  product_update: 'brand', reactivation: 'brand',
  tirbeo_account_onboarding: 'brand',

  notification_digest: 'info', weekly_summary: 'info',
  maintenance_notification: 'info', maintenance_complete: 'info',
  export_ready: 'info',

  // A conversation, not a notice: its own colour so it never reads as another
  // automated alert in a full inbox.
  support_request_received: 'support', support_reply: 'support',
  // Staff's side of the same conversation wears the same colour.
  support_request_admin: 'support',
};

/** Who signs off each family of mail, in the body's own voice. */
const TONE_TEAM: Record<Tone, string> = {
  otp: 'The Tirbeo Accounts team',
  security: 'The Tirbeo Security team',
  brand: 'The Tirbeo Team',
  info: 'The Tirbeo Support team',
  welcome: 'The Tirbeo Team',
  support: 'Tirbeo Support',
};

/**
 * The shared shell. Pure white, one column, left-aligned, no decoration beyond
 * hairlines: wordmark, category word, headline, the copy, a sign-off, and the
 * fine print under a rule.
 *
 * The card used to be a white sheet with a border on a grey page and a colour
 * band across its top. A mail client shows a message on the same white as the
 * rest of the reading pane, and a bordered sheet on tinted canvas is the shape
 * of a template — so the canvas, the card and the band all went, and what is
 * left is the document. Categories stay recognisable in a full inbox through
 * the coloured word over the headline and the sign-off line, neither of which a
 * client has to be coaxed into rendering.
 *
 * Nothing in the mail is an image: mail clients block remote images by
 * default, so the wordmark is letterspaced type. Actions are underlined text
 * links — a filled button is decoration that weaker clients strip. The `logo`
 * URL still flows through and still keys the template cache, but is not embedded
 * anywhere in the HTML.
 */
function mail(logo: string, opts: MailOpts): string {
  const { title, sub, blocks, preheader } = opts;
  const tone = opts.tone ?? 'info';
  const mark = TONE_MARK[tone];
  const pre = esc(preheader || sub || title);
  const support = esc(SUPPORT_EMAIL);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<style>
  body,table,td,h1,p{margin:0;padding:0}
  body{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;text-size-adjust:100%}
  a{text-decoration:none}
  @media only screen and (max-width:640px){
    .mail-head{padding:24px 22px 0 !important}
    .mail-body{padding:18px 22px 26px !important}
    .mail-rule{padding:26px 22px 0 !important}
    .mail-foot{padding:16px 4px 0 !important}
    .mail-code{font-size:26px !important;line-height:36px !important;letter-spacing:4px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};color:${TEXT_2};font-family:${FONT_STACK};font-size:15px;line-height:1.7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0" data-skip-in-text="true">${pre}&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};border-collapse:collapse">
<tr><td align="center" style="padding:36px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="width:100%;max-width:600px;background:${CARD};border-collapse:collapse">
<tr><td class="mail-head" align="left" style="padding:32px 32px 0">
<div style="font-size:12px;line-height:16px;font-weight:bold;letter-spacing:4px;color:${TEXT}">TIRBEO</div>
<div style="margin-top:28px;font-size:12px;line-height:16px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${mark.color}">${mark.label}</div>
<div style="margin-top:8px;font-size:24px;line-height:32px;font-weight:bold;color:${TEXT}">${title}</div>
</td></tr>
<tr><td class="mail-body" align="left" style="padding:20px 32px 32px">
${sub ? `<p style="margin:0 0 18px;font-size:15px;line-height:26px;color:${TEXT_2}">${sub}</p>` : ''}
${blocks.join('\n')}
<p style="margin:30px 0 0;font-size:15px;line-height:24px;color:${TEXT_2}">Sincerely yours,</p>
<p style="margin:2px 0 0;font-size:15px;line-height:24px;color:${TEXT_2}">${TONE_TEAM[tone]}</p>
</td></tr>
<tr><td class="mail-rule" style="padding:28px 32px 0">
<div style="border-top:1px solid ${LINE}"></div>
</td></tr>
</table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse">
<tr><td class="mail-foot" align="left" style="padding:20px 6px 0">
<p style="margin:0 0 6px;font-size:12px;line-height:19px;color:${MUTED}">Need help? Visit the <a href="https://tirbeo.com/contact" style="color:${LINK};text-decoration:underline">Tirbeo Help Center</a> or write to <a href="mailto:${support}" style="color:${LINK};text-decoration:underline">${support}</a>.</p>
<div style="margin:0 0 6px;font-size:12px;line-height:19px;color:${FAINT}">{{unsubscribeSection}}</div>
<p style="margin:0;font-size:12px;line-height:19px;color:${FAINT}">&copy; ${new Date().getFullYear()} Tirbeo Inc. &nbsp;&nbsp;<a href="https://tirbeo.com/privacy" style="color:${FAINT};text-decoration:underline">Privacy</a> &nbsp;&nbsp;<a href="https://tirbeo.com/terms" style="color:${FAINT};text-decoration:underline">Terms</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

function t(subject: string, opts: MailOpts, logo: string, name: string): EmailTemplate {
  return { subject, html: mail(logo, { ...opts, tone: TEMPLATE_TONES[name] ?? 'info' }) };
}

export const EMAIL_TEMPLATES: Record<string, (logo: string, name: string) => EmailTemplate> = {
  signup_otp: (logo, name) =>
    t('Your Tirbeo verification code is {{otp}}', {
      title: 'Verify your email',
      sub: 'Hello {{name}}, enter this code to activate your Tirbeo account.',
      preheader: 'It expires in 15 minutes and works once.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        note("Didn’t sign up for Tirbeo? You can safely ignore this email — no account will be created."),
        safetyNote(),
      ],
    }, logo, name),

  login_otp: (logo, name) =>
    t('Your Tirbeo login code is {{otp}}', {
      title: 'Your login code',
      sub: 'Hello {{name}}, enter this code to finish signing in to Tirbeo.',
      preheader: 'It expires in 15 minutes and works once.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        note("Didn’t try to sign in? Change your password and review your active sessions — someone else has your code."),
        btnGhost(SESSIONS_URL(), 'Review active sessions'),
        safetyNote(),
      ],
    }, logo, name),

  /* A code that confirms an action inside an already-signed-in account. Its own
     template because the login mail says "finish signing in", and this code
     expires on the sensitive-action clock, not the login one. */
  reauth_otp: (logo, name) =>
    t('Your Tirbeo confirmation code is {{otp}}', {
      title: 'Confirm this change',
      sub: 'Hello {{name}}, enter this code to confirm a change on your Tirbeo account.',
      preheader: 'One change, one code — it does not sign anyone in.',
      blocks: [
        code('{{otp}}', `Expires in {{lifetimeMinutes}} minutes &middot; single use`),
        safetyNote(),
      ],
    }, logo, name),

  verify_email: (logo, name) =>
    t('Verify your Tirbeo email: {{otp}}', {
      title: 'Confirm {{primaryEmail}}',
      sub: 'Hello {{name}}, enter this code to confirm your email address.',
      preheader: 'It expires in 10 minutes and works once.',
      blocks: [
        code('{{otp}}', 'Expires in 10 minutes &middot; single use'),
        note("Didn’t request this code? You can safely ignore this email."),
        safetyNote(),
      ],
    }, logo, name),

  magic_link: (logo, name) =>
    t('Sign in to Tirbeo', {
      title: 'Sign in to Tirbeo',
      sub: 'Hello {{name}}, we received a request to sign your account in by email.',
      preheader: 'This link expires in 15 minutes and works once.',
      blocks: [
        btn('{{magicLink}}', 'Sign in to Tirbeo'),
        note('This link expires in 15 minutes and can only be used once. Didn’t request it? Ignore this email — nobody was signed in.'),
      ],
    }, logo, name),

  password_reset_otp: (logo, name) =>
    t('Your Tirbeo password reset code is {{otp}}', {
      title: 'Reset your password',
      sub: 'Hello {{name}}, enter this code to continue resetting the password for {{primaryEmail}}.',
      preheader: 'Your password has not been changed yet.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        note("Didn’t request a reset? Your password is still yours and nothing has changed."),
        safetyNote(),
      ],
    }, logo, name),

  password_reset_otp_recovery: (logo, name) =>
    t('Password reset code for {{primaryEmail}}: {{otp}}', {
      title: 'Code sent to your recovery email',
      sub: 'Hello {{name}}, a password reset was requested for your account. This code went to your recovery address, not the address you sign in with.',
      preheader: 'Your password has not been changed yet.',
      blocks: [
        code('{{otp}}', 'Expires in 15 minutes &middot; single use'),
        well([
          ['Account', '{{primaryEmail}}'],
          ['Code sent to', '{{recoveryEmail}}'],
        ]),
        note("Didn’t request this reset? Your password has not been changed."),
        safetyNote(),
      ],
    }, logo, name),

  delete_account_otp: (logo, name) =>
    t('Confirm deleting your Tirbeo account: {{otp}}', {
      title: 'Confirm account deletion',
      sub: 'Hello {{name}}, enter this code to confirm that you want to delete {{primaryEmail}}.',
      preheader: 'Deletion starts a 30-day grace period you can cancel from.',
      blocks: [
        code('{{otp}}', `Expires in {{lifetimeMinutes}} minutes &middot; single use`),
        callout(
          'What happens next',
          'Nothing is deleted by this email. Confirming starts a 30-day grace period, and you can cancel it by signing in at any time.',
        ),
        safetyNote(),
      ],
    }, logo, name),

  password_reset_link: (logo, name) =>
    t('Reset your Tirbeo password', {
      title: 'Choose a new password',
      sub: 'Hello {{name}}, we received a request to reset your Tirbeo password.',
      preheader: 'This link expires in 15 minutes and works once.',
      blocks: [
        btn('{{resetUrl}}', 'Reset password'),
        note('This link expires in 15 minutes and can only be used once. Didn’t request a reset? Your password has not been changed.'),
        safetyNote(),
      ],
    }, logo, name),

  password_changed: (logo, name) =>
    t('Your Tirbeo password was changed', {
      title: 'Your password was changed',
      sub: 'Hello {{name}}, the password for {{primaryEmail}} was changed.',
      preheader: 'If that wasn’t you, reset it and end every session now.',
      blocks: [
        well([
          ['When', '{{changedAt}}'],
          ['IP address', '{{ipAddress}}'],
        ]),
        para('If the two lines above are not yours, someone else held your password. Reset it and end every session you do not recognise, from inside the app.'),
        btn(`${DASHBOARD_URL()}/settings/security`, 'Secure my account'),
        btnGhost(SESSIONS_URL(), 'Review active sessions'),
      ],
    }, logo, name),

  suspicious_login: (logo, name) =>
    t('New sign-in to your Tirbeo account — was that you?', {
      title: 'New sign-in from an unfamiliar device',
      sub: 'Hello {{name}}, your Tirbeo account was signed in to from a device we have not seen before.',
      preheader: 'If that wasn’t you, change your password now.',
      blocks: [
        well([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
          ['IP address', '{{ipAddress}}'],
        ]),
        callout(
          "If this wasn't you",
          'Change your password right away and end the sessions you do not recognise. Anyone holding this session can read and change everything on your account.',
        ),
        btn(SESSIONS_URL(), 'Review my sessions'),
        note('Was it you? Nothing to do — this mail is informational, and it will not repeat for this device.'),
      ],
    }, logo, name),

  two_factor_disabled: (logo, name) =>
    t('Two-step verification was turned off', {
      title: 'Two-step verification is off',
      sub: `Hello {{name}}, two-step verification was just turned off on {{primaryEmail}}. Your password is now the only thing protecting the account.`,
      preheader: 'Turn it back on if that wasn’t you.',
      blocks: [
        well([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
        ]),
        callout(
          'If this was not you',
          'Someone who could already sign in turned this off. Change your password first, then re-enable two-step — in that order, or they simply turn it off again.',
        ),
        btn('{{twoFactorUrl}}', 'Turn two-step back on'),
        safetyNote(),
      ],
    }, logo, name),

  /* Enabling two-step is the account getting safer, so the mail says that and
     nothing else. It used to reuse `login_alert`, which tells the reader their
     account was signed in to — a stranger-warning sent for a change the person
     made themselves, from the session they were already in. */
  two_factor_enabled: (logo, name) =>
    t('Two-step verification is on', {
      title: 'Two-step verification is on',
      sub: 'Hello {{name}}, {{primaryEmail}} now needs a second factor to sign in.',
      preheader: 'Your password is no longer the only thing protecting the account.',
      blocks: [
        well([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
        ]),
        para('One-time backup codes were created with it. They are shown once and cannot be emailed, so keep them somewhere outside this account — they are the way back in if you lose the authenticator.'),
        btn('{{twoFactorUrl}}', 'Check two-step settings'),
        safetyNote(),
      ],
    }, logo, name),

  login_alert: (logo, name) =>
    t('New sign-in to your Tirbeo account', {
      title: 'New sign-in',
      sub: 'Hello {{name}}, your Tirbeo account was signed in to.',
      preheader: 'Recognise this device? If not, revoke it.',
      blocks: [
        well([
          ['Time', '{{loginTime}}'],
          ['Device', '{{device}}'],
          ['Location', '{{location}}'],
        ]),
        note("Don’t recognise this sign-in? Change your password, and revoke the session while you are there."),
        btnGhost(SESSIONS_URL(), 'Review active sessions'),
      ],
    }, logo, name),

  security_tip: (logo, name) =>
    t('{{tipTitle}}', {
      title: '{{tipTitle}}',
      sub: 'Hello {{name}}, one security setting on your account is not turned on yet.',
      preheader: 'A single change that makes your account harder to break into.',
      blocks: [
        para('{{tipBody}}'),
        btn('{{actionUrl}}', '{{actionLabel}}'),
        note('We send one tip at a time, picked from what your account does not have set up yet.'),
      ],
    }, logo, name),

  account_recovery: (logo, name) =>
    t('Recover your Tirbeo account', {
      title: 'Recover your account',
      sub: 'Hello {{name}}, we received a request to recover {{primaryEmail}}.',
      preheader: 'This link expires in 15 minutes and works once.',
      blocks: [
        btn('{{recoveryUrl}}', 'Recover account'),
        note('This link expires in 15 minutes and can only be used once. Didn’t request it? Ignore this email — nothing has changed.'),
        safetyNote(),
      ],
    }, logo, name),

  welcome: (logo, name) =>
    t('Welcome to Tirbeo, {{name}}', {
      title: 'Welcome to Tirbeo',
      sub: 'Hello {{name}}, your Tirbeo account has been created.',
      preheader: 'What is in your settings, and what is worth changing first.',
      blocks: [
        para(`This mail is a short guide to your account settings. Everything below is reachable from any device you sign in on, and none of it has a deadline.`),
        para(`Your ${link(`${WORKSPACE_URL()}/settings`, 'profile')} holds the name, photo and details other people see when you take part in a form or a conversation. It is the only part of your account that is not private by default, so it is worth reading once and editing anything you would not want shown.`),
        para(`${link(`${WORKSPACE_URL()}/settings/security`, 'Two-step verification')} is the setting that matters most. With it on, signing in from a device Tirbeo has not seen before asks for a one-time code from your authenticator app as well as your password, so a stolen password is no longer enough to get in. It takes about a minute to set up, and you will need an authenticator app on your phone.`),
        para(`The rest of the settings page is straightforward: every device currently signed in to your account, a log of what changed and when, a downloadable copy of your data, and the option to close the account. All of it works without contacting anyone, and account closure starts a 30-day period in which you can change your mind by signing back in.`),
        para(`If any of it does not behave as described, write to ${mailto(SUPPORT_EMAIL, 'our support address')} from the email address on your account and we will sort it out.`),
      ],
    }, logo, name),

  notification_digest: (logo, name) =>
    t('Your Tirbeo digest — {{count}} updates', {
      title: '{{count}} new updates',
      sub: 'Hello {{name}}, these are the updates on your account since the last email.',
      preheader: 'Everything from the last few hours, in one place.',
      blocks: [
        raw('{{digestItems}}'),
        raw('{{activitySection}}'),
        btn('{{dashboardUrl}}', 'View updates'),
        note('You get this because you turned periodic summaries on. Turn it off any time from your notification settings.'),
      ],
    }, logo, name),

  product_update: (logo, name) =>
    t('{{title}}', {
      title: '{{title}}',
      sub: 'Hello {{name}}, a change to how Tirbeo works.',
      preheader: '{{title}} — what it means for your account.',
      blocks: [
        para('{{message}}'),
        btn('{{ctaUrl}}', '{{ctaLabel}}'),
        note('These are the product notices on your account. The link at the bottom of this email turns them off.'),
      ],
    }, logo, name),

  weekly_summary: (logo, name) =>
    t('Your Tirbeo {{periodWord}} — {{periodLabel}}', {
      title: 'Your account this {{periodWord}}',
      sub: `Hello {{name}}, this is your account summary for {{periodLabel}}.`,
      preheader: 'Sign-ins, changes and security events in the period.',
      blocks: [
        raw('{{statRows}}'),
        raw('{{suspiciousSection}}'),
        btn(`${DASHBOARD_URL()}/settings/your-activity`, 'View activity'),
      ],
    }, logo, name),

  reactivation: (logo, name) =>
    t('Your Tirbeo account is unchanged', {
      title: 'Your account is unchanged',
      sub: `Hello {{name}}, it has been {{daysSince}} days since your last visit. Everything is where you left it.`,
      preheader: 'Nothing was deleted, and no setting was changed.',
      blocks: [
        raw('{{activitySummary}}'),
        btn('{{dashboardUrl}}', 'Open my account'),
        note('You can turn reminders like this off under Settings &rarr; Emails.'),
      ],
    }, logo, name),

  maintenance_notification: (logo, name) =>
    t('Scheduled maintenance — {{maintenanceTitle}}', {
      title: '{{maintenanceTitle}}',
      sub: 'Hello {{name}}, {{maintenanceMessage}}',
      preheader: 'What is affected, and when it should be back.',
      blocks: [
        well([
          ['Starts', '{{startTime}}'],
          ['Duration', '{{duration}}'],
          ['Ends by', '{{estimatedEnd}}'],
        ]),
        note('Some features may be briefly unavailable during this window. Nothing you have saved is affected.'),
      ],
    }, logo, name),

  maintenance_complete: (logo, name) =>
    t('Maintenance complete — {{maintenanceTitle}}', {
      title: '{{maintenanceTitle}} is complete',
      sub: 'Hello {{name}}, {{completionMessage}}',
      preheader: 'Everything is back and running.',
      blocks: [
        well([
          ['Completed', '{{completedAt}}'],
          ['Duration', '{{duration}}'],
        ]),
        btn('{{dashboardUrl}}', 'Open Tirbeo'),
      ],
    }, logo, name),

  account_suspended: (logo, name) =>
    t('Your Tirbeo account has been {{statusType}}', {
      title: 'Your account is {{statusType}}',
      sub: 'Hello {{name}}, the status of {{primaryEmail}} has changed.',
      preheader: 'Why it changed, how long it lasts, and what you can do.',
      blocks: [
        well([
          ['Status', '{{statusType}}'],
          ['Reason', '{{reason}}'],
          ['Until', '{{suspendedUntil}}'],
          // Last, not first: the decision is the news, the code is only what
          // they quote when they write about it.
          ['Reference', '{{refCode}}'],
        ]),
        callout(
          'What this means for you',
          '{{suspendedNextStep}}',
        ),
        btn('{{dashboardUrl}}/settings', 'Open my account'),
        note('Believe this was a mistake? Appeal it from your account and a person will read it.'),
      ],
    }, logo, name),

  account_deleted: (logo, name) =>
    t('Your Tirbeo account is scheduled for deletion', {
      title: 'Deletion scheduled',
      sub: 'Hello {{name}}, {{primaryEmail}} is scheduled for deletion.',
      preheader: 'You can still cancel until that date.',
      blocks: [
        well([
          ['Scheduled date', '{{dateLabel}}'],
          ['Grace period', '30 days'],
        ]),
        para('Signing in any time before that date keeps the account open, and the cancellation button is on the delete screen. Nothing is deleted while the window is running.'),
        btn('{{dashboardUrl}}/settings', 'Cancel deletion'),
        note('After the grace period the data is gone and cannot be recovered by anyone, including us.'),
      ],
    }, logo, name),

  account_deactivated: (logo, name) =>
    t('Your Tirbeo account is deactivated', {
      title: 'Account deactivated',
      sub: 'Hello {{name}}, {{primaryEmail}} is deactivated.',
      preheader: 'Nothing was deleted. Signing back in brings it all back.',
      blocks: [
        para('The profile is hidden and every other device was signed out. Nothing was deleted and no setting was changed.'),
        well([
          ['Deactivated', '{{dateLabel}}'],
          ['Reason', '{{reason}}'],
        ]),
        para('Signing in again brings the account back exactly as you left it — this browser can do it from the account screen, and the button there says "Reactivate".'),
        btn('{{accountsUrl}}', 'Sign back in'),
      ],
    }, logo, name),

  admin_alert: (logo, name) =>
    t('{{subject}}', {
      title: '{{subject}}',
      sub: '{{message}}',
      preheader: 'Something on Tirbeo needs a person.',
      blocks: [
        raw('{{details}}'),
        // No dashboard link, no "automated alert from Tirbeo" line: the mail is
        // addressed to someone whose whole job is reading it, and the facts
        // above are the call to action. The route they take is in their
        // bookmarks, not in a message that arrives forty times a day.
        // Last, because it is only needed when someone replies — and the same
        // code the account was shown, so both sides of this quote one thing.
        refLine('{{refCode}}', 'Reference'),
      ],
    }, logo, name),

  support_request_received: (logo, name) =>
    t('We have your message', {
      title: 'We have your message',
      sub: 'Hello {{name}}, this confirms support received what you sent about {{ticketSubject}}.',
      preheader: 'A person reads these in the order they arrive.',
      blocks: [
        messageBlock('{{message}}'),
        para('A person reads these in the order they arrive, and we answer to this address. Nothing is needed from you in the meantime — if something has to be checked first, the reply will say exactly what.'),
        well([
          ['Subject', '{{ticketSubject}}'],
          ['Received', '{{receivedAt}}'],
          ['Account', '{{primaryEmail}}'],
        ]),
        note('Replying to this email keeps the whole thread together.'),
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  /* Staff's copy of a request — a different mail from the account's receipt on
     purpose. The reader is the person who has to answer, so the message is
     quoted in full at the top, the facts a ticket system would hide behind five
     tabs sit under it in one plate, and the reply is a single click that opens
     already-addressed to the account. */
  support_request_admin: (logo, name) =>
    t('Support · {{subject}}', {
      title: '{{subject}}',
      sub: '<strong>{{senderName}}</strong> wrote in from {{contact}}.',
      preheader: 'A person is waiting on an answer to this one.',
      blocks: [
        messageBlock('{{message}}', 'Their message'),
        well([
          ['Account', '{{account}}'],
          ['Answer goes to', '{{contact}}'],
          ['Received', '{{receivedAt}}'],
          ['Device', '{{device}}'],
          ['Reached from', '{{origin}}'],
          ['Reference', '{{refCode}}'],
        ]),
        btn('{{replyHref}}', '{{replyLabel}}'),
        note('Answer from the panel — the reply writes the record beside the request and tells the account it was answered. Replying from your own mail client answers the person and leaves both screens silent.'),
      ],
    }, logo, name),

  support_reply: (logo, name) =>
    t('Re: {{subject}}', {
      title: 'A reply from Tirbeo Support',
      sub: 'Hello {{name}}, there is an answer on your request.',
      preheader: 'The reply is inside.',
      blocks: [
        raw('{{replyHtml}}'),
        well([
          ['Subject', '{{subject}}'],
          ['Answered', '{{receivedAt}}'],
        ]),
        note('Reply to this email to keep the thread. This address is monitored by a person, so the answer you just read can be questioned directly.'),
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  export_ready: (logo, name) =>
    t('Your Tirbeo data export is ready', {
      title: 'Your export is ready',
      sub: 'Hello {{name}}, the export you requested for {{primaryEmail}} was generated.',
      preheader: 'One JSON archive, everything on your account.',
      blocks: [
        well([
          ['Generated', '{{exportedAt}}'],
          ['Format', 'JSON'],
        ]),
        btn(`${DASHBOARD_URL()}/settings`, 'Download from my account'),
        note('The archive stays downloadable from your account settings for a limited time. Nobody else can reach it.'),
      ],
    }, logo, name),

  admin_test: (logo, name) =>
    t('Test email from Tirbeo', {
      title: 'Email is working',
      sub: 'This test confirms that delivery for <strong>{{sentFor}}</strong> is working.',
      preheader: 'No action needed — this was a configuration test.',
      blocks: [
        para('If you can read this, the provider accepted the message and delivered it to this address.'),
        note('Nothing else was sent, and no user was mailed as part of this test.'),
      ],
    }, logo, name),

  tirbeo_account_onboarding: (logo, name) =>
    t(`Your Tirbeo account is ready: {{username}}@${TIRBEO_MAIL_DOMAIN}`, {
      title: `{{username}}@${TIRBEO_MAIL_DOMAIN}`,
      sub: 'Hello {{name}}, your Tirbeo account is ready. This is the address you sign in with, and the username that goes with it.',
      preheader: 'Sign in with the temporary password, then replace it.',
      blocks: [
        para('Use this one-time temporary password to sign in:'),
        secret('{{password}}', 'Temporary &middot; you will be asked to replace it'),
        btn('{{accountsUrl}}', 'Open my Tirbeo account'),
        note('Your recovery email is {{recoveryEmail}}. It is used only for account recovery — it can never sign in.'),
        safetyNote(),
      ],
    }, logo, name),
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
 *
 * In development the cache is bypassed: it lives on `globalThis`, which
 * hot-reload does not clear, so an edited template would keep being served in
 * its stale form until the process restarted — mails silently rendered from
 * yesterday's design.
 */
const g = globalThis as typeof globalThis & {
  __tirbeoTemplateCache?: Map<string, TemplateMap>;
  __tirbeoFullCatalog?: Set<string>;
};

const cacheBypassed = () => process.env.NODE_ENV === 'development';

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
    result[key] = fn(logoUrl, key);
  }
  return result;
}

export function buildTemplates(logoUrl: string = ''): TemplateMap {
  if (cacheBypassed()) return renderAllTemplates(logoUrl);
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
  if (cacheBypassed()) return EMAIL_TEMPLATES[name]?.(logoUrl, name);
  const cache = templateCache();
  const existing = cache.get(logoUrl)?.[name];
  if (existing) return existing;

  const factory = EMAIL_TEMPLATES[name];
  if (!factory) return undefined;

  const template = factory(logoUrl, name);
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
  // The admin support composer writes markup; the shell wraps it, it is not
  // rebuilt from plain text.
  'replyHtml',
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
