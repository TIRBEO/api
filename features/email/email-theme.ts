/**
 * The mail's palette — the Tirbeo email design system.
 *
 * A white sheet with a band of colour across its top naming what the mail is
 * about, on a white canvas. The canvas is white because the reader's own pane is
 * white: a grey ground reads as part of the message on the phones and clients
 * that render a mail full-bleed, and a mail that starts with a grey border looks
 * like a screenshot of a mail. The card therefore carries its own edges — one
 * hairline and the band — and everything inside it that is not the letter is a
 * plate of `PLATE` grey, which is where the framing comes from.
 *
 * The band carries the severity, so the colour is the thing a reader learns to
 * sort an inbox by: blue for a code, red for an account at risk, orange for a
 * change worth looking at, green for something that finished well. Every band
 * colour is dark enough to hold white type.
 *
 * Arial per the spec: the one web-safe stack every mail client renders the same.
 */

/** The canvas behind the card. */
export const PAGE = '#FFFFFF';
export const CARD = '#FFFFFF';
/** The only fill inside the card: a quoted message, a code, a plate of facts.
    On a white card this is the only thing that says "framed", so it is grey. */
export const PLATE = '#F8F9FA';

export const TEXT = '#202124'; // headings, the wordmark, body copy, codes
export const TEXT_2 = '#3C4043'; // secondary body copy
export const MUTED = '#5F6368'; // labels and asides
export const FAINT = '#80868B'; // footer fine print

export const LINE = '#DADCE0';
/** The hairline the card itself wears. */
export const EDGE = '#DADCE0';

export const BTN = '#1A73E8';
export const LINK = '#1A73E8';
export const DANGER = '#D93025';
export const WARN = '#E8710A';
/* Green belongs to a person. It is the colour of the two support mails, which
   are the only ones in the set that somebody wrote by hand — so a reader who
   sees green in an inbox knows a human answered, not a job finished. */
export const SUPPORT = '#188038';
/** A finished job, a changed setting: teal, so it stays a calm "done" and does
    not compete with the green above it. */
export const SUCCESS = '#00838F';
/** Neutral band for a mail that is neither an action nor an alarm. */
export const INFO = '#5F6368';
/** The band for the mails that are Tirbeo talking about itself. */
export const BRAND = '#673AB7';
/** The band for a first mail to a new account. */
export const WELCOME = '#3949AB';

export const RADIUS_CARD = '8px';
export const RADIUS_PILL = '999px';
export const RADIUS_PLATE = '6px';

export const FONT_STACK = "Arial, Helvetica, sans-serif";
export const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
