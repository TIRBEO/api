/**
 * The mail's palette — the Tirbeo email design system.
 *
 * Pure white, top to bottom. The canvas and the card are the same #FFFFFF, the
 * copy is set in near-black ink (#172033) with grey only for the lines that
 * explain rather than say, and hairlines (#E5E7EB) do the separating that a
 * coloured band used to do. The one place a fill is allowed inside the mail is
 * `PLATE` — a quote, a code, a fact block — and it is the only grey left.
 *
 * Arial per the spec: the one web-safe stack every mail client renders the same.
 */

/** The canvas behind the mail. White, because a grey page makes a white card
    look like a box someone else put there. */
export const PAGE = '#FFFFFF';
export const CARD = '#FFFFFF';
/** The only fill inside the card: a quoted message, a code, a plate of facts. */
export const PLATE = '#F5F7FA';

export const TEXT = '#172033'; // headings, the wordmark, body copy, codes
export const TEXT_2 = '#344054'; // secondary body copy
export const MUTED = '#667085'; // labels and asides
export const FAINT = '#98A2B3'; // footer fine print

export const LINE = '#E5E7EB';

export const BTN = '#2563EB';
export const LINK = '#2563EB';
export const DANGER = '#DC2626';
export const WARN = '#B54708';
export const SUCCESS = '#067647';
/** The category a mail belongs to. No longer painted across the top of the
    card — it is the small word above the headline, so the colour still tells
    the reader what kind of mail this is without the mail becoming a banner. */
export const SUPPORT = '#0F766E';

export const RADIUS_CARD = '12px';
export const RADIUS_PILL = '999px';
export const RADIUS_PLATE = '10px';

export const FONT_STACK = "Arial, Helvetica, sans-serif";
export const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";
