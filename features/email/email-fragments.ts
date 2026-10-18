import { FAINT, LINE, MUTED, TEXT, TEXT_2, WARN } from '@/features/email/email-theme';

/**
 * The HTML the mail's section slots are built from.
 *
 * Three senders assemble rows at runtime — the per-notification digest
 * (`features/notifications`), the account recap and the inactivity reminder
 * (`jobs/jobs.ts`) — and the admin preview has to show what they will really
 * produce. One module, imported by all of them, so the preview cannot drift from
 * the mail.
 *
 * Everything here is a block that lives INSIDE the shell, so it uses the shell's
 * vocabulary: a left-aligned column, hairlines that carry the order, plates that
 * are bordered rather than shadowed. Every text argument is expected to be
 * ALREADY escaped by the caller (`escapeHtml` in notifications, `esc` in jobs).
 * Doubling up here would show `&amp;` to the reader.
 */

/** A standalone card — one notification, one recent event. */
export function cardItem(title: string, body?: string): string {
  return `<div style="padding:13px 0">`
    + `<div style="color:${TEXT};font-size:14.5px;font-weight:600;line-height:20px">${title}</div>`
    + (body
      ? `<div style="margin-top:3px;color:${MUTED};font-size:13px;line-height:19px">${body}</div>`
      : '')
    + `</div>`;
}

/** One row inside a grouped list: the thing, and when, on the same line. */
export function listRow(title: string, meta: string): string {
  return `<div style="padding:11px 0">`
    + `<div style="color:${TEXT};font-size:14px;line-height:20px">${title}</div>`
    + `<div style="margin-top:2px;color:${FAINT};font-size:12px;line-height:17px">${meta}</div>`
    + `</div>`;
}

/** A group heading above its rows, with the count beside it. */
export function listGroup(label: string, count: number, rows: string): string {
  return `<div style="margin:20px 0 6px;font-size:11.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;line-height:16px;color:${MUTED}">${label}`
    + ` <span style="color:${FAINT};font-weight:400;letter-spacing:0;text-transform:none">&middot; ${count}</span></div>`
    + rows;
}

/**
 * Groups a set of lists apart from the copy around them.
 *
 * The same bordered plate the detail rows use, with a hairline between rows
 * instead of a gap — a list of events is read top to bottom, and the rule says
 * where one ends and the next begins.
 */
export function listPlate(groups: string): string {
  return `<div style="margin:24px 0;border:1px solid ${LINE};border-radius:10px;overflow:hidden">${groups}</div>`;
}

/** Trailing "n more" line after a list. */
export function moreRow(text: string): string {
  return `<div style="padding:11px 0;font-size:13px;line-height:19px;color:${MUTED}">${text}</div>`;
}

/** The "things to look at" section — amber rule, never a red block. */
export function attentionPanel(heading: string, lines: string[]): string {
  return `<div style="margin:22px 0;padding:2px 0 2px 16px;border-left:2px solid ${WARN}">`
    + `<div style="font-size:14px;line-height:20px;font-weight:600;color:${WARN}">${heading}</div>`
    + lines.map((line) =>
        `<div style="margin-top:4px;font-size:14px;line-height:21px;color:${TEXT_2}">${line}</div>`).join('')
    + `</div>`;
}

/** A single quiet line when there is nothing to show. */
export function emptyNote(text: string): string {
  return `<div style="margin:20px 0;font-size:14px;line-height:21px;color:${MUTED}">${text}</div>`;
}

/**
 * The footer's opt-out line.
 *
 * `{{unsubscribeSection}}` is the slot; an essential email substitutes the empty
 * string, because a mail nobody can refuse must not offer a refusal.
 */
export function unsubscribeSection(url: string): string {
  return `<a href="${url}" style="color:${FAINT};text-decoration:underline">Unsubscribe from these emails</a>`;
}
