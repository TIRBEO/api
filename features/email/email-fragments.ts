import { FAINT, MUTED, TEXT, TEXT_2 } from '@/features/email/email-theme';

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
 * vocabulary: plain stacked text, no plates. Every text argument is expected to
 * be ALREADY escaped by the caller (`escapeHtml` in notifications, `esc` in
 * jobs). Doubling up here would show `&amp;` to the reader.
 */

/** A standalone card — one notification, one recent event. */
export function cardItem(title: string, body?: string): string {
  return `<div style="margin:0 0 14px">`
    + `<div style="color:${TEXT};font-size:14px;font-weight:600;line-height:22px">${title}</div>`
    + (body
      ? `<div style="color:${MUTED};font-size:13px;line-height:20px">${body}</div>`
      : '')
    + `</div>`;
}

/** One row inside a grouped list. */
export function listRow(title: string, meta: string): string {
  return `<div style="margin:0 0 12px">`
    + `<div style="color:${TEXT};font-size:14px;line-height:22px">${title}</div>`
    + `<div style="color:${FAINT};font-size:12px;line-height:18px">${meta}</div>`
    + `</div>`;
}

/** A group heading above its rows, with the count beside it. */
export function listGroup(label: string, count: number, rows: string): string {
  return `<div style="margin:18px 0 8px;font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${TEXT_2}">${label}`
    + ` <span style="color:${MUTED};font-weight:400;letter-spacing:0;text-transform:none">&middot; ${count}</span></div>`
    + rows;
}

/** Groups a set of lists apart from the copy around them. */
export function listPlate(groups: string): string {
  return `<div style="margin:20px 0">${groups}</div>`;
}

/** Trailing "n more" line after a list. */
export function moreRow(text: string): string {
  return `<div style="margin:0 0 12px;font-size:13px;line-height:20px;color:${MUTED}">${text}</div>`;
}

/** The "things to look at" section — amber heading, never a red block. */
export function attentionPanel(heading: string, lines: string[]): string {
  return `<div style="margin:22px 0">`
    + `<div style="margin-bottom:4px;font-size:11.5px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;line-height:18px;color:#b45309">${heading}</div>`
    + lines.map((line) =>
        `<div style="margin:0;font-size:14px;line-height:22px;color:${TEXT_2}">${line}</div>`).join('')
    + `</div>`;
}

/** A single quiet line when there is nothing to show. */
export function emptyNote(text: string): string {
  return `<div style="margin:20px 0;font-size:14px;line-height:22px;color:${MUTED}">${text}</div>`;
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
