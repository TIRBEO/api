import { getDashboardBaseUrl, prodSafeEnvUrl } from '@/config/app-urls';
import { TIRBEO_MAIL_DOMAIN } from '@/features/identity/tirbeo-domain';
import {
  BRAND,
  BTN,
  CARD,
  DANGER,
  EDGE,
  FAINT,
  FONT_STACK,
  INFO,
  LINE,
  LINK,
  MONO,
  MUTED,
  PAGE,
  PLATE,
  SUPPORT,
  SUCCESS,
  TEXT,
  TEXT_2,
  WELCOME,
  WARN,
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
 * Everything is one white card with a coloured band across its top, on a white
 * page: the band says what kind of mail this is — a code, an alarm, a change, a
 * finished job — before the reader has read a word, and the copy underneath is
 * ink on white, left-aligned, reading top-to-bottom like a document. A mail is
 * paragraphs, not a form: the facts a reader needs are sentences, and the only
 * thing set out of line is a code, which is large and centred because it is the
 * thing they came to copy.
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
 * The one-time code: large, centred, and spaced out, because it is the only
 * thing in the mail the reader has to copy. The padding-left takes back the
 * trailing letter-space so the digits sit optically centred rather than nudged
 * left by the gap after the last one.
 */
const code = (value: string, hint?: string): string =>
  `<div style="margin:28px 0 24px;text-align:center">`
  + `<div class="mail-code" style="padding-left:10px;font-size:38px;line-height:46px;font-weight:bold;letter-spacing:10px;color:${TEXT}">${value}</div>`
  + `${hint ? `<div style="margin-top:10px;font-size:13px;line-height:19px;color:${MUTED}">${hint}</div>` : ''}</div>`;

/** A secret that has to be transcribed exactly — the code's shape, small enough
    to fit and untracked at the ends so a double-click selects all of it. */
const secret = (value: string, hint?: string): string =>
  `<div style="margin:28px 0 24px;text-align:center">`
  + `<div style="padding-left:2px;font-family:${MONO};font-size:20px;line-height:28px;font-weight:bold;letter-spacing:2px;color:${TEXT};word-break:break-all">${value}</div>`
  + `${hint ? `<div style="margin-top:10px;font-size:13px;line-height:19px;color:${MUTED}">${hint}</div>` : ''}</div>`;

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
 * machine's mail. The border and the pre-wrap are the point — a quote that
 * reflows into one grey soup of a paragraph, or runs on from the copy above it
 * without an edge, is a quote nobody trusts.
 */
const messageBlock = (text: string, label = 'Your message'): string =>
  `<div class="mail-plate" style="margin:22px 0;padding:16px 18px;background:${PLATE};border:1px solid ${LINE};border-radius:6px">`
  + `<div style="font-size:13px;line-height:19px;color:${MUTED}">${label}</div>`
  + `<div style="margin-top:8px;font-size:15px;line-height:24px;color:${TEXT};white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere">${text}</div></div>`;

/**
 * The same frame around markup somebody else wrote — the answer a support agent
 * typed in the panel. It is boxed for the same reason the quote above is: the
 * mail's own voice and the person's words have to be tellable apart at a glance,
 * and the letter is the one thing in a reply the reader came for.
 */
const replyBlock = (content: string, label: string): string =>
  `<div class="mail-plate" style="margin:22px 0;padding:16px 18px;background:${PLATE};border:1px solid ${LINE};border-radius:6px">`
  + `<div style="font-size:13px;line-height:19px;color:${MUTED}">${label}</div>`
  + `<div style="margin-top:8px;font-size:15px;line-height:24px;color:${TEXT};word-break:break-word;overflow-wrap:anywhere">${content}</div></div>`;

type BtnVariant = 'primary' | 'ghost';
/**
 * The action. A primary action is a filled plate the eye goes straight to, and
 * a secondary one is the same line in grey text.
 *
 * The fill is a `bgcolor` on the anchor plus the inline style, which is the
 * long way round of saying Outlook: the client that ignores `border-radius` and
 * `padding` on an anchor still honours a table cell behind it, so the button is
 * built as a one-cell table with the anchor filling it. Worst case a client
 * strips the padding and the reader gets a blue block with a word in it, which
 * is still obviously the thing to press.
 *
 * A mail whose job is to deliver a code gets no `btn` at all — the reader's
 * action is transcribing digits into our app, and a call-to-action in a code
 * mail is the exact shape of a phishing kit. Escape-hatch links in a code mail
 * are `btnGhost`.
 */
const button = (url: string, label: string, variant: BtnVariant = 'primary'): string => {
  const href = esc(url);
  const text = esc(label);
  if (variant === 'ghost') {
    return `<p style="margin:16px 0 14px;font-size:14px;line-height:22px"><a href="${href}" style="color:${MUTED};text-decoration:underline">${text}</a></p>`;
  }
  /* Centred twice over on purpose: a nested table is a block, so the outer
     cell's `align` alone leaves the button against the left edge in Chrome and
     Firefox, while `margin:0 auto` is ignored by Outlook, which only reads the
     attribute. */
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 12px;border-collapse:collapse">`
    + `<tr><td align="center" style="text-align:center">`
    + `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto">`
    + `<tr>`
    + `<td align="center" bgcolor="${BTN}" style="background:${BTN};border-radius:6px">`
    + `<a href="${href}" style="display:inline-block;padding:13px 24px;font-size:15px;line-height:20px;font-weight:bold;color:#FFFFFF;text-decoration:none">${text}</a>`
    + `</td></tr></table>`
    + `</td></tr></table>`;
};

const btn = (url: string, label: string): string => button(url, label, 'primary');
const btnGhost = (url: string, label: string): string => button(url, label, 'ghost');

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
/* Tones — the band across the top of the card                                 */
/* -------------------------------------------------------------------------- */

export type Tone =
  | 'otp' | 'security' | 'warning' | 'success' | 'info' | 'brand' | 'welcome' | 'support';

/**
 * What the mail is, in one colour and one word.
 *
 * The band is the reader's sort key: before any sentence is read, blue means
 * "a code", red means "your account is at risk", orange means "something
 * changed that you should look at", green means "it finished". Every band is
 * dark enough to hold white type at headline weight, because a band you cannot
 * read the headline on is decoration, not information.
 */
const TONE_BAND: Record<Tone, string> = {
  otp: BTN,
  security: DANGER,
  warning: WARN,
  success: SUCCESS,
  info: INFO,
  brand: BRAND,
  welcome: WELCOME,
  support: SUPPORT,
};

/** Every template's family, resolved by name at render time so no template
    has to remember to declare it. Unknown names read as `info`.

    Severity, not subject matter, decides the band: a code that confirms
    deleting an account is an alarm, and a notice that says a change went
    through the way it should is green, not red. */
const TEMPLATE_TONES: Record<string, Tone> = {
  signup_otp: 'otp', login_otp: 'otp', reauth_otp: 'otp', verify_email: 'otp',
  magic_link: 'otp', password_reset_otp: 'otp', password_reset_otp_recovery: 'otp',
  password_reset_link: 'otp', account_recovery: 'warning',
  delete_account_otp: 'security',

  password_changed: 'success', two_factor_enabled: 'success',
  suspicious_login: 'security', login_alert: 'security',
  account_suspended: 'security', account_deleted: 'security', admin_alert: 'security',
  // A sanction ending is good news and is worn that way: the same decision that
  // arrived under a red band arrives back under a green one.
  account_reinstated: 'success',
  two_factor_disabled: 'warning', security_tip: 'warning',
  maintenance_notification: 'warning',
  account_deactivated: 'info', admin_test: 'info',

  welcome: 'welcome',
  product_update: 'brand', reactivation: 'brand',
  tirbeo_account_onboarding: 'brand',

  notification_digest: 'info', weekly_summary: 'info',
  maintenance_complete: 'success', export_ready: 'success',

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
  warning: 'The Tirbeo Security team',
  success: 'The Tirbeo Accounts team',
  info: 'The Tirbeo Support team',
  brand: 'The Tirbeo Team',
  welcome: 'The Tirbeo Team',
  support: 'Tirbeo Support',
};

/**
 * The shared shell. One white card with a coloured band across its top, sitting
 * on a white page: band (one headline, white on the tone colour), body (the copy,
 * one code or action, a sign-off), and the fine print below the card rather than
 * inside it — the footer belongs to the postman, not the letter.
 *
 * The card is the only shape on the page, so it draws its own edges: a hairline
 * all round, and the band as its top. What needs framing inside the card is
 * framed by a plate, not by another border.
 *
 * Nothing in the mail is an image: mail clients block remote images by default.
 * The `logo` URL still flows through and still keys the template cache, but is
 * not embedded anywhere in the HTML.
 */
function mail(logo: string, opts: MailOpts): string {
  const { title, sub, blocks, preheader } = opts;
  const tone = opts.tone ?? 'info';
  const band = TONE_BAND[tone];
  const pre = esc(preheader || sub || title);
  const support = esc(SUPPORT_EMAIL);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<style>
  body,table,td,h1,p{margin:0;padding:0}
  body{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;text-size-adjust:100%}
  a{text-decoration:none}
  img{border:0;line-height:100%;outline:none;text-decoration:none}
  /* A phone is where most of these are read, and a mail that needs a horizontal
     scroll on one is a mail nobody finishes. Everything wide is allowed to give
     way: the canvas padding, the band's headline, the plate's margins, and any
     long word (a token, a URL, a device string) breaks instead of pushing the
     column past the screen. */
  table{mso-table-lspace:0;mso-table-rspace:0}
  .mail-card,.mail-foot{width:100% !important;max-width:600px !important}
  .mail-body{word-break:break-word;overflow-wrap:anywhere}
  @media only screen and (max-width:640px){
    .mail-wrap{padding:16px 8px !important}
    .mail-band{padding:20px 18px 22px !important}
    .mail-band-title{font-size:21px !important;line-height:27px !important}
    .mail-body{padding:22px 18px 26px !important}
    .mail-foot{padding:16px 2px 0 !important}
    .mail-code{font-size:26px !important;line-height:36px !important;letter-spacing:5px !important;padding-left:5px !important}
    .mail-plate{padding:14px 15px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};color:${TEXT_2};font-family:${FONT_STACK};font-size:15px;line-height:1.7;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0" data-skip-in-text="true">${pre}&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};border-collapse:collapse">
<tr><td class="mail-wrap" align="center" style="padding:34px 12px">
<table role="presentation" class="mail-card" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${CARD}" style="width:100%;max-width:600px;background:${CARD};border:1px solid ${EDGE};border-radius:8px;border-collapse:separate;box-shadow:0 1px 2px rgba(60,64,67,0.10),0 2px 6px 1px rgba(60,64,67,0.05)">
<tr><td class="mail-band" align="left" bgcolor="${band}" style="background:${band};background-color:${band};padding:28px 32px;border-radius:8px 8px 0 0">
<div class="mail-band-title" style="font-size:26px;line-height:34px;font-weight:bold;color:#FFFFFF">${title}</div>
</td></tr>
<tr><td class="mail-body" align="left" style="padding:28px 32px 30px">
${sub ? `<p style="margin:0 0 18px;font-size:15px;line-height:26px;color:${TEXT_2}">${sub}</p>` : ''}
${blocks.join('\n')}
<p style="margin:28px 0 0;font-size:15px;line-height:24px;color:${TEXT}">Sincerely yours,</p>
<p style="margin:2px 0 0;font-size:15px;line-height:24px;color:${TEXT}">${TONE_TEAM[tone]}</p>
</td></tr>
</table>
<table role="presentation" class="mail-foot" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse">
<tr><td class="mail-foot" align="left" style="padding:22px 6px 0">
<p style="margin:0 0 6px;font-size:12px;line-height:19px;color:${MUTED}">Need help? Visit the <a href="https://tirbeo.com/contact" style="color:${LINK};text-decoration:underline">Tirbeo Help Center</a> or write to <a href="mailto:${support}" style="color:${LINK};text-decoration:underline">${support}</a>.</p>
<div style="margin:0 0 6px;font-size:12px;line-height:19px;color:${FAINT}">{{unsubscribeSection}}</div>
<p style="margin:0;font-size:12px;line-height:19px;color:${FAINT}">&copy; ${new Date().getFullYear()} Tirbeo Inc. &nbsp;&nbsp;<a href="https://tirbeo.com/privacy" style="color:${MUTED};text-decoration:underline">Privacy</a> &nbsp;&nbsp;<a href="https://tirbeo.com/terms" style="color:${MUTED};text-decoration:underline">Terms</a></p>
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
        para(`The account being reset is {{primaryEmail}}. This code went to your recovery address, {{recoveryEmail}}, instead of the one you sign in with — that is what keeps this mail out of the hands of whoever may already hold the first.`),
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
        para(`The change was made {{changedAt}}, from {{ipAddress}}.`),
        para('If that is your device and your time, nothing further is needed — this mail exists so a change you did not make is never silent. If it is not yours, someone else held your password. Reset it and end every session you do not recognise, from inside the app.'),
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
        para(`It happened {{loginTime}} on {{device}}, from {{ipAddress}}. Nothing else on your account was touched.`),
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
        para(`It was switched off {{loginTime}} on {{device}}.`),
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
        para(`It was turned on {{loginTime}} on {{device}}.`),
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
        para(`It came from {{device}} at {{loginTime}}, reaching Tirbeo from {{location}}.`),
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
        para(`It starts {{startTime}}, runs about {{duration}}, and everything should be back by {{estimatedEnd}}.`),
        note('Some features may be briefly unavailable during this window. Nothing you have saved is affected.'),
      ],
    }, logo, name),

  maintenance_complete: (logo, name) =>
    t('Maintenance complete — {{maintenanceTitle}}', {
      title: '{{maintenanceTitle}} is complete',
      sub: 'Hello {{name}}, {{completionMessage}}',
      preheader: 'Everything is back and running.',
      blocks: [
        para(`It finished {{completedAt}}, after about {{duration}}. Nothing you had saved moved, and nothing needs to be redone.`),
        btn('{{dashboardUrl}}', 'Open Tirbeo'),
      ],
    }, logo, name),

  account_suspended: (logo, name) =>
    t('Your Tirbeo account has been {{statusType}}', {
      title: 'Your account is {{statusType}}',
      sub: 'Hello {{name}}, the status of {{primaryEmail}} has changed.',
      preheader: 'Why it changed, how long it lasts, and what you can do.',
      blocks: [
        para(`{{primaryEmail}} is {{statusType}}. Nothing on the account was deleted, and the profile stays hidden for as long as it stands.`),
        para(`The reason on the record: {{reason}}. It lasts {{suspendedUntil}}.`),
        callout(
          'What this means for you',
          '{{suspendedNextStep}}',
        ),
        btn('{{dashboardUrl}}/settings', 'Open my account'),
        note('Believe this was a mistake? Appeal it from your account and a person will read it.'),
        // One line, at the end, and the only place the code appears: the news is
        // the sentence above, and the code is only needed when they write back.
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  /* The other half of account_suspended, and the mail that used to be missing:
     a sanction ending was written to the record and to no person. It says which
     decision ended, why it ended in the admin's own words, and repeats the code
     the account was mailed at the start — so the two mails quote one thing and
     nobody has to open a thread to prove the ban they were told about is over. */
  account_reinstated: (logo, name) =>
    t('The {{kindWord}} on your Tirbeo account has been lifted', {
      title: 'Your account is open again',
      sub: 'Hello {{name}}, the {{kindWord}} on {{primaryEmail}} has been lifted.',
      preheader: 'You can sign in again. Here is what was decided, and why it ended.',
      blocks: [
        para(`It ended {{liftedAt}}. Nothing on the account was deleted while it stood, and the account is where you left it.`),
        para(`Why the decision was lifted, in the words kept on the record: {{reason}}.`),
        para('{{liftedNextStep}}'),
        btn('{{dashboardUrl}}/settings', 'Open my account'),
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  account_deleted: (logo, name) =>
    t('Your Tirbeo account is scheduled for deletion', {
      title: 'Deletion scheduled',
      sub: 'Hello {{name}}, {{primaryEmail}} is scheduled for deletion.',
      preheader: 'You can still cancel until that date.',
      blocks: [
        para(`The date is {{dateLabel}}, and the grace period is 30 days. Signing in at any time before that date keeps the account open — the cancellation button is on the delete screen, and nothing is deleted while the window is running.`),
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
        para(`It went quiet {{dateLabel}}, from the account's own screen; the reason given was “{{reason}}”. The profile is hidden and every other device was signed out, but nothing was deleted and no setting was changed.`),
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
        btn('{{threadUrl}}', 'Open this request'),
        para(`The answer comes back to {{primaryEmail}}, and anything you add later belongs to the same thread — write it on that page rather than sending a second message.`),
        // The one place this mail names a code. It is not in the subject and not
        // in the band, because a reader who came for an answer should read a
        // sentence, not a handle.
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  /* Staff's copy of a request — a different mail from the account's receipt on
     purpose. The reader is the person who has to answer, so the message is
     quoted in full at the top, the facts a ticket system hides behind five tabs
     are two sentences under it, and the reply is one click that lands on the
     ticket already open. */
  support_request_admin: (logo, name) =>
    t('Support · {{subject}}', {
      title: '{{subject}}',
      sub: '<strong>{{senderName}}</strong> wrote in from {{contact}}.',
      preheader: 'A person is waiting on an answer to this one.',
      blocks: [
        messageBlock('{{message}}', 'Their message'),
        para(`It is filed on the account {{account}}, and the answer goes back to {{contact}}. The message came in {{receivedAt}} on {{device}}, reached from {{origin}}.`),
        btn('{{replyHref}}', '{{replyLabel}}'),
        note('Answer from the panel — the reply writes the record beside the request and tells the account it was answered. Replying from your own mail client answers the person and leaves both screens silent.'),
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  /* The answer, and nothing else. What the person wrote is the reason the mail
     exists, so their reply is the first thing on the page — boxed, because it is
     somebody's words inside our machine's mail — and the one action is the
     thread itself, where the answer can be read and questioned on the same
     screen. Three sentences is the whole letter; a support reply that has to
     explain how much it listened is a support reply nobody reads past. */
  support_reply: (logo, name) =>
    t('Re: {{subject}}', {
      title: 'An answer to your request',
      sub: 'Hello {{name}}, this is the reply to {{subject}}.',
      preheader: 'Read it, and write back from the same page.',
      blocks: [
        replyBlock('{{replyHtml}}', 'Their reply'),
        btn('{{threadUrl}}', 'Reply on Tirbeo'),
        para(`You asked on {{receivedAt}}. Anything you add goes to the same person on the same thread — no need to start over, and no need to reply to this address.`),
        refLine('{{refCode}}'),
      ],
    }, logo, name),

  export_ready: (logo, name) =>
    t('Your Tirbeo data export is ready', {
      title: 'Your export is ready',
      sub: 'Hello {{name}}, the export you requested for {{primaryEmail}} was generated.',
      preheader: 'One JSON archive, everything on your account.',
      blocks: [
        para(`It was built {{exportedAt}} as one JSON archive of everything on {{primaryEmail}}. The file is downloadable from your account settings for a limited time, and nobody else can reach it.`),
        btn(`${DASHBOARD_URL()}/settings`, 'Download from my account'),
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

    // Function replacer, never a string. In `String.replace`, a `$` in the
    // replacement is a directive — `$&` splices the matched placeholder, `` $` ``
    // everything before it, `$'` everything after. A name like `` 50% $` `` or a
    // subject containing `$&` would pour a slice of the surrounding template into
    // the value slot, and the escape helper above has no reason to touch `$`.
    result = rawVars.has(key)
      ? result.replace(pattern, () => val)
      : result.replace(pattern, () => esc(val));
  }

  return result;
}
