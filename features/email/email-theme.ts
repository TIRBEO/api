/**
 * The mail's palette and type.
 *
 * No chrome: everything sits on white, one heading, body copy, one blue thing to
 * press, a grey footer. Declared once because two files read it —
 * `email-templates.ts` styles the shell and `email-fragments.ts` builds the
 * digest, recap and reminder HTML at runtime. Those fragments are substituted
 * into the shell after it is built, so a colour change that reaches one file and
 * not the other ships a mismatched mail.
 */

export const TEXT = '#111827';
/** Secondary copy — the paragraphs under a heading. */
export const TEXT_2 = '#374151';
/** Tertiary copy: sub-headings, captions, row labels. */
export const MUTED = '#5b6472';
/** Footer/legal tone. 4.8:1 on white — an unsubscribe link a reader cannot read
    is not one they can act on. */
export const FAINT = '#6b7280';

/** Action blue — the fill of the single thing worth pressing, and body links. */
export const BTN = '#2563eb';

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
export const MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
