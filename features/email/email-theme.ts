/**
 * The mail's palette and type — the tirbeo.com landing theme in mail form.
 *
 * Emails cannot use CSS custom properties reliably, so these are the LITERAL
 * light-scheme hexes from `apps/landing/app/globals.css`. Mail clients render
 * dark mode inconsistently, and a mail pinned to light is what was drawn.
 *
 * The ground is #f2f2f7 (iOS grouped canvas); the mail itself sits on a white
 * plate with 17px corners, the same card radius the landing cards use. Ink is
 * #171717, secondary copy #3f3f46, tertiary #5d5d66, hairlines #d1d1d6. The
 * action fill is the landing's AA-checked `--accent-solid` (#0062cc) with a
 * 999px pill; links read as `--accent-text` (#0068d6). Red (#e0342c) is
 * reserved for security alerts.
 *
 * Declared once because two files read it — `email-templates.ts` styles the
 * shell and `email-fragments.ts` builds the digest, recap and reminder HTML at
 * runtime. Those fragments are substituted into the shell after it is built, so
 * a colour change that reaches one file and not the other ships a mismatched
 * mail.
 *
 * Type is the landing's system stack; the scale follows its form ladder
 * (15 body, 13 secondary, 12.5 caption).
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
/** Footer/legal tone — landing `--text-4`, quiet but legible. */
export const FAINT = '#6e6e76';

/** Hairline: the shell's rule, plate borders, the code block's edge. */
export const LINE = '#d1d1d6';
/** Wash: the ground a code block or a detail plate sits on. */
export const WASH = '#f2f2f7';

/** Action fill — landing `--accent-solid`: white text clears WCAG AA. */
export const BTN = '#0062cc';
/** Action ink — landing `--accent-text`, used for links and ghost actions. */
export const LINK = '#0068d6';
/** The destructive variant, kept out of the palette's blue so "delete" never
    looks like "continue" — and used only for security-alert emphasis. */
export const DANGER = '#e0342c';
/** The amber of a "look at this" that is not an alarm (landing --warn-text). */
export const WARN = '#8a5200';
/** The green of something done that is worth confirming (landing --success-text). */
export const SUCCESS = '#146c33';

/** Landing radii: the mail card, and the pill every action uses. */
export const RADIUS_CARD = '17px';
export const RADIUS_PILL = '999px';
export const RADIUS_PLATE = '14px';

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
