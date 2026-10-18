/**
 * The mail's palette and type.
 *
 * No chrome: everything sits on white, one heading, body copy, one thing to
 * press, a grey footer. Declared once because two files read it —
 * `email-templates.ts` styles the shell and `email-fragments.ts` builds the
 * digest, recap and reminder HTML at runtime. Those fragments are substituted
 * into the shell after it is built, so a colour change that reaches one file and
 * not the other ships a mismatched mail.
 *
 * The scale is the one the product itself uses: near-black ink, three greys for
 * how much a line matters, one blue for anything you can follow, and a black
 * fill for the single thing worth pressing. Hairlines are #eaeaea — visible
 * against white, gone the moment you stop looking for them.
 *
 * Every value must clear contrast on white: MUTED is 4.6:1 and FAINT 4.7:1, so
 * an unsubscribe line stays legible to the person it exists for.
 */

/** Ink — the heading and anything set in it. */
export const TEXT = '#171717';
/** Secondary copy — the paragraphs under a heading. */
export const TEXT_2 = '#3f3f46';
/** Tertiary copy: sub-headings, captions, row labels. */
export const MUTED = '#5d5d66';
/** Footer/legal tone — the faintest grey that still passes on white. */
export const FAINT = '#71717a';

/** Hairline: the shell's rule, plate borders, the code block's edge. */
export const LINE = '#eaeaea';
/** Wash: the ground a code block or a detail plate sits on. */
export const WASH = '#f9f9f9';

/** Action blue — body links and the quiet, text-only action. */
export const BTN = '#0070f3';
/** The primary button: black, because a mail gets one and it should look like
    the only decision in it. */
export const INK = '#171717';
/** The destructive variant, kept out of the palette's blue so "delete" never
    looks like "continue". */
export const DANGER = '#dc2626';
/** The amber of a "look at this" that is not an alarm. */
export const WARN = '#9a5b00';
/** The green of something done that is worth confirming — a good outcome, never
    a button. */
export const SUCCESS = '#15803d';

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
