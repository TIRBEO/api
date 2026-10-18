/**
 * The mail's palette and type — the Apple transactional-mail surface.
 *
 * Emails cannot use CSS custom properties reliably, so these are the LITERAL
 * hexes from the canonical Apple token spec (docs/design/apple-tokens.css),
 * light scheme only: mail clients render dark mode inconsistently, and a mail
 * pinned to light is what was drawn.
 *
 * The ground is #f2f2f7 (iOS grouped canvas); the mail itself sits on a white
 * plate with 17px corners, the same card radius every other Tirbeo surface
 * uses. Ink is #171717, secondary copy #5d5d66, hairlines #c6c6c8. One blue —
 * #007AFF — marks everything pressable: links and the single button, which is
 * blue with white text, 12px corners and generous padding. Red (#e0342c) is
 * reserved: it appears only where a security alert says something is wrong.
 *
 * Declared once because two files read it — `email-templates.ts` styles the
 * shell and `email-fragments.ts` builds the digest, recap and reminder HTML at
 * runtime. Those fragments are substituted into the shell after it is built, so
 * a colour change that reaches one file and not the other ships a mismatched
 * mail.
 *
 * Type is the Apple system stack; the scale follows the token spec's ladder
 * (17 body, 15 secondary, 13 caption).
 */

/** The page ground: the iOS grouped canvas a mail is delivered onto. */
export const PAGE = '#f2f2f7';
/** The plate the mail lives on: white, 17px corners, on top of PAGE. */
export const CARD = '#ffffff';

/** Ink — the heading and anything set in it. */
export const TEXT = '#171717';
/** Secondary copy — the paragraphs under a heading. */
export const TEXT_2 = '#3f3f46';
/** Tertiary copy: sub-headings, captions, row labels. */
export const MUTED = '#5d5d66';
/** Footer/legal tone — Apple's tertiary label grey, quiet but legible. */
export const FAINT = '#8e8e93';

/** Hairline: the shell's rule, plate borders, the code block's edge. */
export const LINE = '#c6c6c8';
/** Wash: the ground a code block or a detail plate sits on. */
export const WASH = '#f2f2f7';

/** Action blue — the one colour for anything pressable: links and buttons. */
export const BTN = '#007AFF';
/** The destructive variant, kept out of the palette's blue so "delete" never
    looks like "continue" — and used only for security-alert emphasis. */
export const DANGER = '#e0342c';
/** The amber of a "look at this" that is not an alarm (spec --warn-text). */
export const WARN = '#9d6300';
/** The green of something done that is worth confirming — a good outcome, never
    a button (spec --success-text). */
export const SUCCESS = '#188a3e';

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
