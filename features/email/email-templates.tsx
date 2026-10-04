import React from 'react';
import {
  Html,
  Head,
  Preview,
  Body,
  Container,
  Section,
  Text,
  Heading,
  Link,
  Hr,
  Img } from '@react-email/components';
import { render } from '@react-email/render';
import { getApiOrigin } from '@/features/branding/branding';

/**
 * Outlook's VML namespace. Word and Outlook desktop drop `background-color` on
 * an anchor, so a primary CTA renders as a bare underlined link unless it is
 * also expressed as a <v:roundrect>.
 *
 * Those elements are namespaced XML (`v:`, `w:`), and a namespaced name is not
 * a valid JSX element name at all — the compiler rejects it outright, whatever
 * any module augmentation claims about React's intrinsic types. Declaring them
 * was enough to pass `tsc` and not enough to be loadable: every API route that
 * imports this file failed to compile and answered 500, which is what broke
 * passkey sign-in. So they are written here as raw HTML and injected with
 * dangerouslySetInnerHTML, which is what they were all along.
 */

export type EmailTemplate = {
  subject: string;
  html: string;
};

function tpl(subject: string, html: string): EmailTemplate {
  return { subject, html };
}

const APP_DOMAIN = (
  process.env.NEXT_PUBLIC_APP_DOMAIN || 'tirbeo.com'
)
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');

const DASHBOARD_URL =
  process.env.NEXT_PUBLIC_DASHBOARD_URL ||
  `https://dashboard.${APP_DOMAIN}`;

const SESSIONS_URL = `${DASHBOARD_URL}/account/sessions`;

// Workspace / profile destination for email CTAs. Ops can point this at either
// tirbeo.com or tirbeo.com via NEXT_PUBLIC_MYPROFILE_URL (or NEXT_PUBLIC_WORKSPACE_URL);
// it falls back to the dashboard address so no deployment is ever left with a
// broken "Open your workspace" link.
const WORKSPACE_URL = (
  process.env.NEXT_PUBLIC_MYPROFILE_URL ||
  process.env.NEXT_PUBLIC_WORKSPACE_URL ||
  DASHBOARD_URL
)
  .replace(/\/+$/, '');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'admin@tirbeo.com';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/* -------------------------------------------------------------------------- */
/* Design tokens — the screenshot scheme: pure black canvas, one dark surface
   for cards and codes, white type, one grey for secondary lines. Monochrome:
   no coloured fills, no uppercase eyebrows, no tracking. */
/* -------------------------------------------------------------------------- */

const PAGE = '#000000';
const SURFACE = '#18181a';
const TEXT = '#ffffff';
const MUTED = '#8a8a8e';
const FAINT = '#6e6e73';
const BORDER = '#2a2a2c';
const BORDER_SOFT = '#222224';
const RULE = '#1f1f22';
const BTN_BG = '#ffffff';
const BTN_FG = '#000000';
const DANGER_BG = '#ff453a';
const RADIUS = 14;

type Block = React.ReactNode;

/* -------------------------------------------------------------------------- */
/* Shell / layout (react-email)                                                */
/* -------------------------------------------------------------------------- */

const bodyStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  backgroundColor: PAGE,
  color: TEXT,
  fontFamily: FONT_STACK,
  WebkitFontSmoothing: 'antialiased',
  MozOsxFontSmoothing: 'grayscale',
  lineHeight: 1.6 };

const containerStyle: React.CSSProperties = {
  maxWidth: 600,
  width: '100%',
  margin: '0 auto',
  padding: '24px 20px 32px' };

/**
 * Client CSS. Split into two halves on purpose.
 *
 * The <style> block only reaches clients that honour it — Apple Mail, iOS Mail,
 * Thunderbird, and most webmail on desktop. Everything that matters for layout
 * is therefore ALSO expressed as inline attributes on each element below, and
 * this block is treated purely as the responsive layer on top.
 *
 * Dark mode is the other half. A near-black canvas with near-white type is a
 * genuine hazard: Gmail on Android and Outlook for iOS do not respect
 * `color-scheme` and simply invert whatever they find, which turns this design
 * into white text on a white page — unreadable. The opt-out block below is
 * re-asserted for both engines, and the `[data-ogsc]` selectors cover Outlook
 * for Windows' own colour rewriting.
 */
const CLIENT_CSS = `
  :root { color-scheme: dark only; supported-color-schemes: dark; }
  body, table, td, div, p, span, h1, a { color-scheme: dark only; }
  /* Gmail Android strips <style> in some accounts and inlines into a <style>
     sibling of the body; the "u + .body" selector is the documented fix. */
  u + #body a { color: inherit; text-decoration: none; }
  /* Outlook.com / Outlook Windows dark-mode re-colouring. */
  [data-ogsc] .tb-page { background-color: ${PAGE} !important; }
  [data-ogsc] .tb-btn-wrap a { background-color: ${BTN_BG} !important; color: ${BTN_FG} !important; border-radius: 12px !important; }
  [data-ogsc] .tb-otp { color: ${TEXT} !important; letter-spacing: 10px !important; }

  @media only screen and (max-width: 560px) {
    .tb-container { padding: 20px 16px 28px !important; }
    .tb-title { font-size: 23px !important; line-height: 30px !important; }
    .tb-lede { font-size: 15px !important; line-height: 24px !important; }
    .tb-btn-wrap { display: block !important; width: 100% !important; }
    .tb-btn-wrap table, .tb-btn-wrap td { width: 100% !important; }
    .tb-btn-wrap a { display: block !important; width: 100% !important; box-sizing: border-box !important; text-align: center !important; }
    .tb-kv-key { width: auto !important; display: block !important; padding: 10px 16px 2px 16px !important; white-space: normal !important; }
    .tb-kv-val { display: block !important; padding: 2px 16px 10px 16px !important; }
    .tb-otp { font-size: 26px !important; line-height: 36px !important; letter-spacing: 6px !important; }
    .tb-otp-box { padding: 20px 10px !important; }
  }
`;

function logoBlock(logo: string): Block {
  const src = logo || `${getApiOrigin()}/logo.png`;
  return (
    <Section style={{ paddingBottom: 34 }}>
      <table
        role="presentation"
        border={0}
        cellPadding={0}
        cellSpacing={0}
        style={{ borderCollapse: 'collapse' }}
      >
        <tr>
          <td style={{ verticalAlign: 'middle', paddingRight: 10 }}>
            <Img
              src={src}
              width={32}
              height={32}
              alt="Tirbeo"
              style={{
                display: 'block',
                width: 32,
                height: 32,
                border: `1px solid ${BORDER}`,
                borderRadius: 8,
                backgroundColor: SURFACE }}
            />
          </td>
          <td
            style={{
              verticalAlign: 'middle',
              fontSize: 16,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: TEXT }}
          >
            Tirbeo
          </td>
        </tr>
      </table>
    </Section>
  );
}

/**
 * Renders the shared shell.
 *
 * `preheader` is the grey "…" line Gmail and Apple Mail show next to the
 * subject. It is separate from `title` because the best preheader is not a
 * restatement of the headline — it is the sentence that answers "why did I get
 * this?" before the reader has opened anything. Templates that pass nothing get
 * a sensible default rather than a duplicated subject.
 */
function mail(
  logo: string,
  title: string,
  blocks: Block[],
  preheader?: string,
): Promise<string> {
  const pre = preheader || title;
  return render(
    <Html lang="en">
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
        <meta name="x-apple-disable-message-reformatting" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: CLIENT_CSS }} />
      </Head>
      <Body className="tb-page" style={bodyStyle}>
        <Container className="tb-container" style={containerStyle}>
          {logoBlock(logo)}
          {/* The block helpers return plain nodes, and an array of them needs a
              key each — otherwise React warns on every message rendered. */}
          {blocks.map((block, i) => (
            <React.Fragment key={`b${i}`}>{block}</React.Fragment>
          ))}
        </Container>
      </Body>
    </Html>,
  );
}

/* -------------------------------------------------------------------------- */
/* Block components                                                            */
/* -------------------------------------------------------------------------- */

function title(text: string): Block {
  return (
    <Heading
      as="h1"
      className="tb-title"
      style={{
        margin: '0 0 20px',
        fontSize: 27,
        lineHeight: '34px',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        color: TEXT }}
    >
      {text}
    </Heading>
  );
}

/** The greeting line — "Hello," or "Hello {{name}}," on its own. */
function greet(name?: string): Block {
  return (
    <Text style={{ margin: '0 0 16px', fontSize: 15, lineHeight: '24px', color: TEXT }}>
      Hello{name ? ` ${name}` : ''},
    </Text>
  );
}

/** Lead paragraph — same voice as body; kept as its own helper so templates
    read as intro → detail, not one wall of identical calls. */
function lede(text: string): Block {
  return (
    <Text
      className="tb-lede"
      style={{ margin: '0 0 16px', fontSize: 15, lineHeight: '24px', color: TEXT }}
    >
      <span dangerouslySetInnerHTML={{ __html: text }} />
    </Text>
  );
}

function body(text: string): Block {
  return (
    <Text
      className="tb-body"
      style={{ margin: '0 0 16px', fontSize: 15, lineHeight: '24px', color: TEXT }}
    >
      <span dangerouslySetInnerHTML={{ __html: text }} />
    </Text>
  );
}

function small(text: string): Block {
  return (
    <Text
      className="tb-small"
      style={{ margin: '0 0 10px', fontSize: 14, lineHeight: '20px', color: MUTED }}
    >
      <span dangerouslySetInnerHTML={{ __html: text }} />
    </Text>
  );
}

/**
 * The one-time code.
 *
 * Spacing is carried by `letter-spacing` on a monospace run, and the media
 * query trims both size and tracking on phones so a six-digit code never
 * clips at 320px. Word drops letter-spacing entirely — the code still reads
 * there, just tighter.
 */
function otpBlock(code: string): Block {
  return (
    <div
      className="tb-otp-box"
      style={{
        margin: '26px 0',
        padding: '28px 16px',
        backgroundColor: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 16,
        textAlign: 'center' as const }}
    >
      <span
        className="tb-otp"
        style={{
          display: 'inline-block',
          fontSize: 32,
          lineHeight: '40px',
          fontWeight: 700,
          letterSpacing: '10px',
          color: TEXT,
          fontFamily: MONO_STACK,
          maxWidth: '100%' }}
      >
        {code}
      </span>
    </div>
  );
}

type BtnVariant = 'primary' | 'ghost' | 'danger';

/** The same style object React would have written, as a CSS string. */
function cssText(style: React.CSSProperties): string {
  return Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}:${v}`)
    .join(';');
}

/** For the attribute and text nodes inside the raw VML string. */
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;' })[c] || c,
  );
}

/**
 * A button Outlook renders as a button.
 *
 * Modern mail clients are happy with the styled <a> alone. Word and
 * Outlook.com are not — they drop the background on an anchor and show a bare
 * underlined word — so the same link is also written as the VML roundrect they
 * do honour. The two cannot be expressed together as JSX (see the note at the
 * top of this file), and a component module here may not import
 * react-dom/server to render the inner link, so the anchor is written out by
 * hand: one <a> with a style string, which is exactly what <Link> renders.
 */
function button(url: string, label: string, variant: BtnVariant): Block {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '14px 28px',
    textDecoration: 'none',
    fontSize: 15,
    lineHeight: '20px',
    fontWeight: 600,
    borderRadius: 12,
    whiteSpace: 'nowrap',
    msoPaddingAlt: '0' };

  const style: React.CSSProperties =
    variant === 'primary'
      ? { ...base, backgroundColor: BTN_BG, color: BTN_FG }
      : variant === 'danger'
        ? { ...base, backgroundColor: DANGER_BG, color: '#ffffff' }
        : {
            ...base,
            backgroundColor: 'transparent',
            color: TEXT,
            border: `1px solid ${BORDER}` };

  const vmlFg = variant === 'primary' ? BTN_FG : '#ffffff';
  const radius = 12;
  const arc = Math.round((radius / 52) * 100);
  const anchor =
    `<a href="${escapeHtml(url)}" style="${escapeHtml(cssText(style))}">${escapeHtml(label)}</a>`;
  const vml =
    '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml"' +
    ' xmlns:w="urn:schemas-microsoft-com:office:word"' +
    ' style="height:52px;v-text-anchor:middle;width:260px;"' +
    ` arcsize="${arc}%" stroke="f" fillcolor="${String(style.backgroundColor)}">` +
    '<w:anchorlock/>' +
    `<center style="color:${vmlFg};font-family:${FONT_STACK};font-size:15px;font-weight:bold;">${anchor}</center>` +
    '</v:roundrect>';

  return (
    <Text className="tb-btn-wrap" style={{ margin: '24px 0 20px' }}>
      {/* Outlook.com / Outlook 2013+ ignore the background on a plain <a>. */}
      <table
        role="presentation"
        border={0}
        cellPadding={0}
        cellSpacing={0}
        style={{ borderCollapse: 'separate' }}
      >
        <tr>
          <td
            align="center"
            style={{ borderRadius: radius, backgroundColor: style.backgroundColor }}
            dangerouslySetInnerHTML={{ __html: vml }}
          />
        </tr>
      </table>
    </Text>
  );
}

function btn(url: string, label: string): Block {
  return button(url, label, 'primary');
}

function btnGhost(url: string, label: string): Block {
  return button(url, label, 'ghost');
}

function btnDanger(url: string, label: string): Block {
  return button(url, label, 'danger');
}

function divider(): Block {
  return <Hr style={{ borderColor: RULE, borderWidth: 1, margin: '28px 0 18px' }} />;
}

/**
 * Key/value detail table — one dark surface, hairline row rules, sentence-case
 * grey labels beside white values.
 *
 * The label column is a shared class so the media query can collapse the grid
 * into stacked rows on a phone — a fixed gutter plus a value that wraps is how
 * an IP address ends up hyphenated across two lines at 320px.
 */
function kv(pairs: Array<[string, string]>): Block {
  return (
    <table
      role="presentation"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
      style={{
        margin: '20px 0',
        width: '100%',
        tableLayout: 'fixed',
        backgroundColor: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        borderSpacing: '0 0' }}
    >
      {pairs.map(([key, value], i) => (
        <tr key={key}>
          <td
            className="tb-kv-key"
            style={{
              padding: i === 0 ? '12px 0 12px 16px' : '12px 0 12px 16px',
              borderTop: i === 0 ? 'none' : `1px solid ${BORDER_SOFT}`,
              fontSize: 13,
              lineHeight: '20px',
              color: MUTED,
              width: 120,
              verticalAlign: 'top',
              whiteSpace: 'nowrap' }}
          >
            {key}
          </td>
          <td
            className="tb-kv-val"
            style={{
              padding: i === 0 ? '12px 16px 12px 0' : '12px 16px 12px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${BORDER_SOFT}`,
              fontSize: 14,
              lineHeight: '20px',
              color: TEXT,
              verticalAlign: 'top',
              wordBreak: 'break-word' as const,
              overflowWrap: 'anywhere' as const }}
            dangerouslySetInnerHTML={{ __html: value }}
          />
        </tr>
      ))}
    </table>
  );
}

/** Callout box for a quoted / pre-formatted payload. */
function plainBlock(content: string): Block {
  return (
    <div
      style={{
        margin: '20px 0',
        padding: '16px 18px',
        backgroundColor: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        color: TEXT }}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}

/** Highlighted note with a title. */
function noteBox(heading: string, content: string): Block {
  return (
    <table
      role="presentation"
      width="100%"
      border={0}
      cellPadding={0}
      cellSpacing={0}
      style={{
        margin: '16px 0',
        width: '100%',
        borderCollapse: 'separate',
        backgroundColor: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS }}
    >
      <tr>
        <td style={{ padding: '14px 16px' }}>
          <div
            style={{
              marginBottom: 4,
              fontSize: 14,
              lineHeight: '20px',
              fontWeight: 600,
              color: TEXT }}
          >
            {heading}
          </div>
          <div
            style={{ fontSize: 14, lineHeight: '20px', color: MUTED }}
            dangerouslySetInnerHTML={{ __html: content }}
          />
        </td>
      </tr>
    </table>
  );
}

/** Raw-HTML placeholder container (e.g. {{digestItems}}) substituted later. */
function rawBlock(content: string): Block {
  return <div style={{ margin: '16px 0' }} dangerouslySetInnerHTML={{ __html: content }} />;
}

/** Code/password box. */
function darkCode(code: string): Block {
  return (
    <div
      style={{
        margin: '16px 0',
        padding: '16px',
        backgroundColor: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: RADIUS,
        color: TEXT,
        fontFamily: MONO_STACK,
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: 2,
        textAlign: 'center' as const }}
      dangerouslySetInnerHTML={{ __html: code }}
    />
  );
}

function footerEl(): Block {
  return (
    <React.Fragment>
      {divider()}
      <Text style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: FAINT }}>
        Tirbeo Inc. · Kathmandu, Nepal
      </Text>
      <Text style={{ margin: '4px 0 0', fontSize: 13, lineHeight: '20px', color: FAINT }}>
        © {new Date().getFullYear()} Tirbeo Inc. All rights reserved.
      </Text>
      {/* The unsubscribe block is injected by the sender as
          {{unsubscribeSection}}. It is intentionally last: an unsubscribe link
          that scrolls off the bottom is not one anybody can act on. */}
      <div style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: '{{unsubscribeSection}}' }} />
    </React.Fragment>
  );
}

function securityNote(): Block[] {
  return [
    noteBox(
      'Keep your account safe',
      'Tirbeo will never ask for your password or verification code by email or phone. If anything asks you for one, it did not come from us.',
    ),
  ];
}


/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

export const EMAIL_TEMPLATES: Record<
  string,
  (logo: string) => Promise<EmailTemplate>
> = {
  signup_otp: async (logo) =>
    tpl(
      'Your Tirbeo verification code is {{otp}}',
      await mail(logo, 'Verify your email', [
        title('Verify your email'),
        greet(),
        lede('Use the code below to verify your email address and activate your Tirbeo account.'),
        otpBlock('{{otp}}'),
        small('This code expires in 10 minutes and can only be used once.'),
        small("If you didn't sign up for Tirbeo, you can safely ignore this email."),
        footerEl(),
      ]),
    ),

  login_otp: async (logo) =>
    tpl(
      'Your Tirbeo login code is {{otp}}',
      await mail(logo, 'Your login code', [
        title('Your login code'),
        greet(),
        lede('Use the code below to finish signing in to Tirbeo.'),
        otpBlock('{{otp}}'),
        small('This code expires in 10 minutes and can only be used once.'),
        small("If you didn't try to sign in, we recommend changing your password."),
        footerEl(),
      ]),
    ),

  /* A code that confirms an action inside an already-signed-in account. Its own
     template because the login mail above says "finish signing in" and the
     reauth code expires on the sensitive-code core's clock, not the login one —
     a reader who is told to sign in, when nobody asked them to, reasonably
     thinks somebody else tried. */
  reauth_otp: async (logo) =>
    tpl(
      'Your Tirbeo confirmation code is {{otp}}',
      await mail(logo, 'Confirm it’s you', [
        title('Confirm it’s you'),
        greet(),
        lede('Use the code below to confirm this change on your Tirbeo account.'),
        otpBlock('{{otp}}'),
        small(
          'This code expires in {{lifetimeMinutes}} minutes and can only be used once. It confirms one change — it does not sign anyone in.',
        ),
        ...securityNote(),
        small("If you didn’t ask for this, don’t enter the code anywhere."),
        footerEl(),
      ]),
    ),

  verify_email: async (logo) =>
    tpl(
      'Verify your Tirbeo email',
      await mail(logo, 'Verify your email', [
        title('Verify your email'),
        greet(),
        lede('Enter the verification code below to confirm your email address.'),
        otpBlock('{{otp}}'),
        small('This code expires in 15 minutes.'),
        small("If you didn't request this code, you can safely ignore this email."),
        footerEl(),
      ]),
    ),

  magic_link: async (logo) =>
    tpl(
      'Sign in to Tirbeo',
      await mail(logo, 'Sign in to Tirbeo', [
        title('Sign in to Tirbeo'),
        greet('{{name}}'),
        lede('We received a request to sign you in. Use the button below to continue.'),
        btn('{{magicLink}}', 'Sign in'),
        small('This link expires in 15 minutes and can only be used once.'),
        small("If you didn't request this sign-in link, you can safely ignore this email."),
        footerEl(),
      ]),
    ),

  password_reset_otp: async (logo) =>
    tpl(
      'Your Tirbeo password reset code is {{otp}}',
      await mail(logo, 'Reset your password', [
        title('Reset your password'),
        greet('{{name}}'),
        lede('Use the code below to continue resetting your Tirbeo password.'),
        otpBlock('{{otp}}'),
        small('This code expires in 15 minutes and can only be used once.'),
        ...securityNote(),
        small("If you didn't request a password reset, your password has not been changed."),
        footerEl(),
      ]),
    ),

  password_reset_otp_recovery: async (logo) =>
    tpl(
      'Password reset for {{primaryEmail}}',
      await mail(logo, 'Reset your password', [
        title('Reset your password'),
        greet('{{name}}'),
        lede(
          'A password reset was requested for <strong>{{primaryEmail}}</strong>. The verification code was sent to your recovery email <strong>{{recoveryEmail}}</strong>.',
        ),
        otpBlock('{{otp}}'),
        small('This code expires in 15 minutes and can only be used once.'),
        kv([
          ['Account', '{{primaryEmail}}'],
          ['Recovery email', '{{recoveryEmail}}'],
        ]),
        ...securityNote(),
        small("If you didn't request this reset, your password has not been changed."),
        footerEl(),
      ]),
    ),

  delete_account_otp: async (logo) =>
    tpl(
      'Your Tirbeo account deletion code is {{otp}}',
      await mail(logo, 'Delete account', [
        title('Confirm account deletion'),
        greet('{{name}}'),
        lede('Use the code below to confirm your request to delete your Tirbeo account.'),
        otpBlock('{{otp}}'),
        small(
          'The code expires in {{lifetimeMinutes}} minutes. After confirmation, your account enters a 30-day grace period.',
        ),
        ...securityNote(),
        small(
          "If you didn't request account deletion, change your password and review your active sessions.",
        ),
        footerEl(),
      ]),
    ),

  password_reset_link: async (logo) =>
    tpl(
      'Reset your Tirbeo password',
      await mail(logo, 'Reset your password', [
        title('Reset your password'),
        greet('{{name}}'),
        lede('We received a request to reset your Tirbeo password. Use the button below to continue.'),
        btn('{{resetUrl}}', 'Reset password'),
        small('This link expires in 15 minutes and can only be used once.'),
        small("If you didn't request this, your password has not been changed."),
        footerEl(),
      ]),
    ),

  password_changed: async (logo) =>
    tpl(
      'Your Tirbeo password was changed',
      await mail(logo, 'Password changed', [
        title('Password changed'),
        greet('{{name}}'),
        lede('Your Tirbeo password was successfully changed.'),
        kv([
          ['When', '{{changedAt}}'],
          ['IP address', '{{ipAddress}}'],
        ]),
        small(
          "If you didn't make this change, reset your password and review your active sessions immediately.",
        ),
        footerEl(),
      ]),
    ),

  suspicious_login: async (logo) =>
    tpl(
      "New sign-in to your Tirbeo account \u2014 was that you?",
      await mail(logo, 'New sign-in', [
        title('A sign-in we did not expect'),
        greet('{{name}}'),
        lede('Your Tirbeo account was just signed in to.'),
        kv([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
          ['Location', '{{location}}'],
          ['IP address', '{{ipAddress}}'],
        ]),
        body('This does not match the devices you usually sign in from. Was that you?'),
        noteBox(
          "If this wasn't you",
          'Change your password right away and review your active sessions. End any session you do not recognize.',
        ),
        btnDanger(SESSIONS_URL, 'Review my account'),
        small('If this was you, you do not need to do anything.'),
        ...securityNote(),
        footerEl(),
      ]),
    ),

  two_factor_disabled: async (logo) =>
    tpl(
      'Two-step verification was turned off',
      await mail(logo, 'Security change', [
        title('Two-step verification is off'),
        greet('{{name}}'),
        lede('Two-step verification was just turned off on your Tirbeo account. Anyone with your password can sign in again.'),
        kv([
          ['When', '{{loginTime}}'],
          ['Device', '{{device}}'],
        ]),
        noteBox(
          'If this was not you',
          'Someone with access to your account turned this off. Change your password and turn two-factor back on.',
        ),
        btn('{{twoFactorUrl}}', 'Turn two-step back on'),
        ...securityNote(),
        footerEl(),
      ]),
    ),

  login_alert: async (logo) =>
    tpl(
      'New sign-in to your Tirbeo account',
      await mail(logo, 'New sign-in', [
        title('New sign-in'),
        greet('{{name}}'),
        lede('Your Tirbeo account was just accessed.'),
        kv([
          ['Location', '{{location}}'],
          ['Device', '{{device}}'],
          ['Time', '{{loginTime}}'],
        ]),
        btn(SESSIONS_URL, 'Review sessions'),
        small("If you don't recognize this sign-in, change your password immediately."),
        footerEl(),
      ]),
    ),

  security_tip: async (logo) =>
    tpl(
      'A quick thing that would make your account harder to break into',
      await mail(logo, 'Security tip', [
        title('{{tipTitle}}'),
        greet('{{name}}'),
        body('{{tipBody}}'),
        btn('{{actionUrl}}', '{{actionLabel}}'),
        small('We send one tip per email, picked from what your account does not have set up yet.'),
        footerEl(),
      ]),
    ),

  account_recovery: async (logo) =>
    tpl(
      'Reset your Tirbeo account',
      await mail(logo, 'Account recovery', [
        title('Recover your account'),
        greet('{{name}}'),
        lede('We received a request to recover your Tirbeo account. Use the button below to continue.'),
        btn('{{recoveryUrl}}', 'Recover account'),
        small('This link expires in 15 minutes and can only be used once.'),
        small("If you didn't request this, you can safely ignore this email."),
        footerEl(),
      ]),
    ),

  welcome: async (logo) =>
    tpl(
      'Welcome to Tirbeo, {{name}}',
      await mail(logo, 'Welcome to Tirbeo', [
        title('Welcome to Tirbeo'),
        greet('{{name}}'),
        lede('Your Tirbeo account has been created and your workspace is ready to use.'),
        body(
          'Sign in to manage your account, profile, and workspace settings from one place.',
        ),
        btn(WORKSPACE_URL, 'Open your workspace'),
        body(
          'Your Tirbeo profile is available through your account. From there you can review and update your personal information, account details, preferences, and more.',
        ),
        btnGhost(WORKSPACE_URL, 'Manage your profile'),
        body(
          `If you need help at any point, reach our support team at ${SUPPORT_EMAIL}. We're happy to assist with your account or workspace.`,
        ),
        body('Thank you for joining Tirbeo — we are glad to have you with us.'),
        body('Best regards,<br />The Tirbeo Team'),
        footerEl(),
      ]),
    ),

  notification_digest: async (logo) =>
    tpl(
      'Your Tirbeo digest — {{count}} updates',
      await mail(logo, 'Tirbeo digest', [
        title('{{count}} new updates'),
        greet('{{name}}'),
        lede('Here is your Tirbeo activity summary.'),
        rawBlock('{{digestItems}}'),
        rawBlock('{{activitySection}}'),
        btn('{{dashboardUrl}}', 'View updates'),
        small('You receive this email because you enabled periodic summaries.'),
        footerEl(),
      ]),
    ),

  product_update: async (logo) =>
    tpl(
      '{{title}}',
      await mail(logo, 'Product update', [
        title('{{title}}'),
        greet('{{name}}'),
        body('{{message}}'),
        btn('{{ctaUrl}}', '{{ctaLabel}}'),
        small('You are receiving this as part of your account communications.'),
        footerEl(),
      ]),
    ),

  weekly_summary: async (logo) =>
    tpl(
      'Your Tirbeo recap — {{periodLabel}}',
      await mail(logo, 'Account recap', [
        title('What happened on your account'),
        greet('{{name}}'),
        lede('{{periodLabel}}'),
        rawBlock('{{statRows}}'),
        rawBlock('{{suspiciousSection}}'),
        btn(`${DASHBOARD_URL}/settings/your-activity`, 'View activity'),
        footerEl(),
      ]),
    ),

  reactivation: async (logo) =>
    tpl(
      'We miss you on Tirbeo',
      await mail(logo, 'Tirbeo', [
        title('We miss you'),
        greet('{{name}}'),
        lede(
          'It has been {{daysSince}} days since your last visit. Your workspace is still here whenever you need it.',
        ),
        rawBlock('{{activitySummary}}'),
        btn('{{dashboardUrl}}', 'Open Tirbeo'),
        small('You can turn off inactivity reminders from your notification preferences.'),
        footerEl(),
      ]),
    ),

  maintenance_notification: async (logo) =>
    tpl(
      'Scheduled maintenance — {{maintenanceTitle}}',
      await mail(logo, 'Scheduled maintenance', [
        title('{{maintenanceTitle}}'),
        greet('{{name}}'),
        lede('{{maintenanceMessage}}'),
        kv([
          ['Starts', '{{startTime}}'],
          ['Duration', '{{duration}}'],
          ['Ends by', '{{estimatedEnd}}'],
        ]),
        small('Some features may be temporarily unavailable during this window.'),
        footerEl(),
      ]),
    ),

  maintenance_complete: async (logo) =>
    tpl(
      'Maintenance complete — {{maintenanceTitle}}',
      await mail(logo, 'Maintenance complete', [
        title('{{maintenanceTitle}} complete'),
        greet('{{name}}'),
        lede('{{completionMessage}}'),
        kv([
          ['Completed', '{{completedAt}}'],
          ['Duration', '{{duration}}'],
        ]),
        btn('{{dashboardUrl}}', 'Open Tirbeo'),
        footerEl(),
      ]),
    ),

  account_suspended: async (logo) =>
    tpl(
      'Your Tirbeo account has been {{statusType}}',
      await mail(logo, 'Account status', [
        title('Account {{statusType}}'),
        greet('{{name}}'),
        lede('The status of your Tirbeo account has changed.'),
        kv([
          ['Status', '{{statusType}}'],
          ['Reason', '{{reason}}'],
          ['Until', '{{untilLabel}}'],
          ['What to do', '{{actionLabel}}'],
        ]),
        btn('{{dashboardUrl}}/account', 'Open account'),
        small('If you believe this action was taken in error, you can appeal from your account.'),
        footerEl(),
      ]),
    ),

  account_deleted: async (logo) =>
    tpl(
      'Your Tirbeo account is scheduled for deletion',
      await mail(logo, 'Account deletion', [
        title('Deletion scheduled'),
        greet('{{name}}'),
        lede('Your Tirbeo account is scheduled for deletion.'),
        kv([
          ['Scheduled date', '{{dateLabel}}'],
          ['Grace period', '30 days'],
          ['Data removal', 'All account data will be permanently erased'],
        ]),
        body('You can cancel the deletion before {{dateLabel}} by signing in.'),
        btnDanger('{{dashboardUrl}}/account/security', 'Cancel deletion'),
        footerEl(),
      ]),
    ),

  admin_alert: async (logo) =>
    tpl(
      '[Admin] {{subject}}',
      await mail(logo, 'Admin alert', [
        title('{{subject}}'),
        lede('{{message}}'),
        plainBlock('{{details}}'),
        btn('{{dashboardUrl}}', 'Open dashboard'),
        small('Automated administrative alert from Tirbeo.'),
        footerEl(),
      ]),
    ),

  system_alert: async (logo) =>
    tpl(
      '[System] {{subject}}',
      await mail(logo, 'System alert', [
        title('{{subject}}'),
        lede('{{message}}'),
        kv([
          ['Service', '{{service}}'],
          ['Time', '{{alertTime}}'],
        ]),
        small('Automated system alert.'),
        footerEl(),
      ]),
    ),

  admin_crash_report: async (logo) =>
    tpl(
      '[Crash] {{severity}}: {{errorType}}',
      await mail(logo, 'Crash report', [
        title('{{severity}} crash reported'),
        lede('{{errorType}}'),
        kv([
          ['Message', '{{message}}'],
          ['User', '{{userEmail}} ({{username}})'],
          ['Page', '{{url}}'],
          ['Source', '{{source}}'],
          ['Device', '{{userAgent}}'],
        ]),
        plainBlock(
          `<pre style="margin:0;font-size:12px;line-height:18px;font-family:${MONO_STACK};white-space:pre-wrap;word-break:break-word;color:${MUTED}">{{stack}}</pre>`,
        ),
        btn(DASHBOARD_URL, 'Open dashboard'),
        small('Automated crash report from Tirbeo.'),
        footerEl(),
      ]),
    ),

  export_ready: async (logo) =>
    tpl(
      'Your data has been exported',
      await mail(logo, 'Data export', [
        title('Your export is ready'),
        greet('{{name}}'),
        lede('Your Tirbeo data export was generated successfully.'),
        kv([
          ['Generated', '{{exportedAt}}'],
          ['Format', 'JSON'],
        ]),
        ...securityNote(),
        small("If this wasn't you, change your password immediately."),
        footerEl(),
      ]),
    ),

  form_submission_confirmation: async (logo) =>
    tpl(
      'Your response to {{formTitle}} was recorded',
      await mail(logo, 'Response recorded', [
        title('Response recorded'),
        lede('Your response to <strong>{{formTitle}}</strong> was recorded successfully.'),
        btn('{{formUrl}}', 'View form'),
        small('You received this email because you submitted a response to this form.'),
        footerEl(),
      ]),
    ),

  form_response: async (logo) =>
    tpl(
      'New response to "{{formTitle}}"',
      await mail(logo, 'New response', [
        title('New response'),
        lede('Someone submitted a response to <strong>{{formTitle}}</strong>.'),
        kv([
          ['Respondent', '{{respondentName}}'],
          ['Submitted', '{{submittedAt}}'],
        ]),
        rawBlock('{{answers}}'),
        btn('{{adminUrl}}', 'View response'),
        footerEl(),
      ]),
    ),

  form_notification: async (logo) =>
    tpl(
      'New form submission: {{formTitle}}',
      await mail(logo, 'New submission', [
        title('New submission'),
        lede('A new submission was received on <strong>{{formTitle}}</strong>.'),
        rawBlock('{{submissionData}}'),
        btn('{{formUrl}}', 'View submission'),
        footerEl(),
      ]),
    ),

  form_flagged: async (logo) =>
    tpl(
      'Your form "{{formTitle}}" was flagged',
      await mail(logo, 'Form flagged', [
        title('Form flagged'),
        lede('Your form <strong>{{formTitle}}</strong> was flagged for manual review.'),
        kv([
          ['Reason', '{{reason}}'],
          ['Flagged at', '{{flaggedAt}}'],
        ]),
        btn('{{adminUrl}}', 'View details'),
        small('If you believe this was incorrect, contact the Tirbeo team.'),
        footerEl(),
      ]),
    ),

  form_published: async (logo) =>
    tpl(
      'Your form "{{formTitle}}" is now live',
      await mail(logo, 'Form published', [
        title('Your form is live'),
        lede('<strong>{{formTitle}}</strong> is now accepting responses.'),
        btn('{{formUrl}}', 'View form'),
        small('You can pause, edit, or unpublish the form from your dashboard.'),
        footerEl(),
      ]),
    ),

  form_closed: async (logo) =>
    tpl(
      'Your form "{{formTitle}}" has been closed',
      await mail(logo, 'Form closed', [
        title('Form closed'),
        lede('<strong>{{formTitle}}</strong> is no longer accepting responses.'),
        small('Existing responses remain available from your dashboard.'),
        footerEl(),
      ]),
    ),

  form_deleted: async (logo) =>
    tpl(
      'Your form "{{formTitle}}" has been deleted',
      await mail(logo, 'Form deleted', [
        title('Form deleted'),
        lede('<strong>{{formTitle}}</strong> and its data were permanently deleted.'),
        noteBox('Cannot be undone', 'This action is permanent.'),
        footerEl(),
      ]),
    ),

  form_archived: async (logo) =>
    tpl(
      'Your form "{{formTitle}}" has been archived',
      await mail(logo, 'Form archived', [
        title('Form archived'),
        lede('<strong>{{formTitle}}</strong> was moved to your archive.'),
        small('The form stops collecting responses, but existing data remains available.'),
        footerEl(),
      ]),
    ),

  response_updated: async (logo) =>
    tpl(
      'A response to "{{formTitle}}" was updated',
      await mail(logo, 'Response updated', [
        title('Response updated'),
        lede('A response on <strong>{{formTitle}}</strong> was modified.'),
        kv([
          ['Response ID', '{{responseId}}'],
          ['Updated', '{{updatedAt}}'],
        ]),
        btn('{{adminUrl}}', 'View response'),
        footerEl(),
      ]),
    ),

  response_deleted: async (logo) =>
    tpl(
      'A response to "{{formTitle}}" was deleted',
      await mail(logo, 'Response deleted', [
        title('Response deleted'),
        lede('A response on <strong>{{formTitle}}</strong> was deleted.'),
        kv([
          ['Response ID', '{{responseId}}'],
          ['Deleted', '{{deletedAt}}'],
        ]),
        footerEl(),
      ]),
    ),

  ticket_created: async (logo) =>
    tpl(
      'Support ticket opened: {{ticketSubject}}',
      await mail(logo, 'Support ticket', [
        title('Support ticket opened'),
        lede('Your support ticket was created successfully.'),
        kv([
          ['Ticket ID', '{{ticketId}}'],
          ['Subject', '{{ticketSubject}}'],
          ['Status', '{{ticketStatus}}'],
        ]),
        btn('{{ticketUrl}}', 'View ticket'),
        footerEl(),
      ]),
    ),

  ticket_updated: async (logo) =>
    tpl(
      'Update on your support ticket {{ticketId}}',
      await mail(logo, 'Ticket update', [
        title('Ticket updated'),
        lede('There is new activity on your support ticket.'),
        plainBlock(
          `<p style="margin:0;font-size:14px;line-height:22px;color:${TEXT};white-space:pre-wrap;">{{updateMessage}}</p>`,
        ),
        kv([
          ['Ticket ID', '{{ticketId}}'],
          ['Subject', '{{ticketSubject}}'],
          ['Status', '{{ticketStatus}}'],
        ]),
        btn('{{ticketUrl}}', 'View ticket'),
        footerEl(),
      ]),
    ),

  ticket_closed: async (logo) =>
    tpl(
      'Your support ticket {{ticketId}} has been closed',
      await mail(logo, 'Ticket closed', [
        title('Ticket closed'),
        lede('Your support ticket has been closed.'),
        kv([
          ['Ticket ID', '{{ticketId}}'],
          ['Subject', '{{ticketSubject}}'],
          ['Status', 'Closed'],
        ]),
        btn('{{ticketUrl}}', 'View ticket'),
        footerEl(),
      ]),
    ),

  ticket_reopened: async (logo) =>
    tpl(
      'Your support ticket {{ticketId}} has been reopened',
      await mail(logo, 'Ticket reopened', [
        title('Ticket reopened'),
        lede('Your support ticket has been reopened and is active again.'),
        kv([
          ['Ticket ID', '{{ticketId}}'],
          ['Subject', '{{ticketSubject}}'],
          ['Status', 'Open'],
        ]),
        btn('{{ticketUrl}}', 'View ticket'),
        footerEl(),
      ]),
    ),

  ticket_replied: async (logo) =>
    tpl(
      'New reply on your support ticket {{ticketId}}',
      await mail(logo, 'Ticket reply', [
        title('New reply'),
        lede('You received a new reply on your support ticket.'),
        plainBlock(
          `<p style="margin:0;font-size:14px;line-height:22px;color:${TEXT};white-space:pre-wrap;word-break:break-word;">{{replyContent}}</p>`,
        ),
        kv([
          ['Ticket ID', '{{ticketId}}'],
          ['Subject', '{{ticketSubject}}'],
          ['Replied by', '{{replierName}}'],
        ]),
        btn('{{ticketUrl}}', 'View ticket'),
        footerEl(),
      ]),
    ),

  form_auto_reply: async (logo) =>
    tpl(
      'Thanks for submitting to {{formTitle}}',
      await mail(logo, 'Submission received', [
        title('Submission received'),
        lede('Your response to <strong>{{formTitle}}</strong> was received successfully.'),
        rawBlock('{{fieldsRows}}'),
        kv([
          ['Submission ID', '{{submissionId}}'],
          ['Received', '{{submittedAt}}'],
        ]),
        small('No further action is needed.'),
        footerEl(),
      ]),
    ),

  form_submission_notification: async (logo) =>
    tpl(
      'New submission on {{formTitle}}',
      await mail(logo, 'New submission', [
        title('New submission'),
        lede('A new submission was received on <strong>{{formTitle}}</strong>.'),
        rawBlock('{{fieldRows}}'),
        kv([
          ['Submission ID', '{{submissionId}}'],
          ['Received', '{{submittedAt}}'],
          ['IP address', '{{ip}}'],
        ]),
        btn('{{viewUrl}}', 'View submission'),
        footerEl(),
      ]),
    ),

  admin_test: async (logo) =>
    tpl(
      'Test email from Tirbeo',
      await mail(logo, 'Test email', [
        title('Email is working'),
        lede(
          'This test confirms that email delivery for <strong>{{sentFor}}</strong> is working correctly.',
        ),
        small('No action is needed. This was only a configuration test.'),
        footerEl(),
      ]),
    ),

  tirbeo_account_onboarding: async (logo) =>
    tpl(
      'You now have a Tirbeo account, {{name}}',
      await mail(logo, 'Your Tirbeo account', [
        title('Your Tirbeo account is ready'),
        greet('{{name}}'),
        lede(
          '<strong>{{username}}@tirbeo.com</strong> is your Tirbeo identity — your username, your mail address and your sign-in. Keep it professional; it is unique to you.',
        ),
        body('To secure the account on first sign in, use this one-time temporary password:'),
        darkCode('{{password}}'),
        body('You will be asked to replace it with a password only you know.'),
        btn('{{accountsUrl}}', 'Open Tirbeo account'),
        small(
          'Your recovery email is {{recoveryEmail}}. This address is used only for account recovery — it can never be used to sign in.',
        ),
        footerEl(),
      ]),
    ) };

/* -------------------------------------------------------------------------- */
/* Build templates                                                             */
/* -------------------------------------------------------------------------- */

export type TemplateMap = Record<string, EmailTemplate>;

/**
 * Rendered catalogue, keyed by logo URL.
 *
 * `sendTemplateEmail` needs one template and used to get all 55, because
 * `buildTemplates` had no way to build a subset. Every send therefore paid a
 * full `render()` pass over the catalogue — ~220ms of React-to-static-markup
 * work, plus 55 template literals of garbage — to use one string. On a shared
 * send path that is the difference between a request that feels instant and one
 * that does not.
 *
 * The cache is keyed on the logo URL because that is the only input the render
 * depends on, and it lives on `globalThis` so it survives the module instance
 * being re-evaluated the way it is under Next's dev server. A single-entry key
 * is deliberate: branding changes are rare, and holding every logo ever seen
 * would be an unbounded cache for no benefit.
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
 * partial bucket would look exactly like a complete one and every caller of
 * `buildTemplates` would silently get one template. This records which entries
 * are known-good in full.
 */
function fullCatalogs(): Set<string> {
  if (!g.__tirbeoFullCatalog) g.__tirbeoFullCatalog = new Set();
  return g.__tirbeoFullCatalog;
}

/** Build every template, ignoring the cache. */
async function renderAllTemplates(logoUrl: string): Promise<TemplateMap> {
  const result: TemplateMap = {};
  for (const [key, fn] of Object.entries(EMAIL_TEMPLATES)) {
    result[key] = await fn(logoUrl);
  }
  return result;
}

export async function buildTemplates(
  logoUrl: string = '',
): Promise<TemplateMap> {
  const cache = templateCache();
  const hit = cache.get(logoUrl);
  if (hit && fullCatalogs().has(logoUrl)) return hit;
  const built = await renderAllTemplates(logoUrl);
  cache.set(logoUrl, built);
  fullCatalogs().add(logoUrl);
  return built;
}

/**
 * One template by name, rendered on first use and cached thereafter.
 *
 * Preferred over `buildTemplates()` on the send path: a brand-new template is
 * only paid for when someone actually triggers that email, so adding one does
 * not make every unrelated send slower.
 */
export async function getTemplate(
  name: string,
  logoUrl: string = '',
): Promise<EmailTemplate | undefined> {
  const cache = templateCache();
  const existing = cache.get(logoUrl)?.[name];
  if (existing) return existing;

  const factory = EMAIL_TEMPLATES[name];
  if (!factory) return undefined;

  const template = await factory(logoUrl);
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
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Variables whose value is trusted HTML and must not be escaped.
 *
 * These are the section slots the templates build themselves — the digest
 * items, the weekly-summary stat rows, the "suspicious activity" panel, the
 * substituted-in form fields. Every one of them is constructed from escaped
 * user data upstream; escaping them again here turns a working table into
 * visible `&lt;div&gt;` markup in the customer's inbox.
 *
 * This list used to exist here *and* be re-declared as a `rawVars` argument at
 * the call site in email.ts, with the two drifting apart — `jobs.ts` sent
 * `statRows` without listing it, so the weekly summary shipped as tag soup.
 * One list, exported, is the fix.
 */
export const RAW_HTML_VARS = new Set([
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
  extraRawVars?: Set<string>,
): string {
  // Additive on purpose. An earlier signature defaulted the parameter to
  // RAW_HTML_VARS, so any caller passing its own set silently dropped the whole
  // canonical list and re-escaped every section slot. `extra` means extra.
  const rawVars = extraRawVars
    ? new Set([...RAW_HTML_VARS, ...extraRawVars])
    : RAW_HTML_VARS;

  let result = html;

  for (const [key, val] of Object.entries(vars)) {
    // Keys come from our own templates and call sites, never from user input,
    // but escaping keeps a stray key from silently meaning something else.
    const pattern = new RegExp(
      `\\{\\{\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\}\\}`,
      'gi',
    );

    if (rawVars.has(key)) {
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
            "'": '&#39;' })[c] || c,
      );

      result = result.replace(pattern, escaped);
    }
  }

  return result;
}
