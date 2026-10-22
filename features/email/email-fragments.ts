import { FAINT, LINE, MONO, MUTED, TEXT, TEXT_2 } from '@/features/email/email-theme';

/**
 * The HTML the mail's section slots are built from.
 *
 * Four senders assemble rows at runtime — the per-notification digest
 * (`features/notifications`), the account recap and the inactivity reminder
 * (`jobs/jobs.ts`), and the administrative alert (`features/security`) — and the
 * admin preview has to show what they will really produce. One module, imported
 * by all of them, so the preview cannot drift from the mail.
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
    + `<div style="color:${TEXT};font-size:15px;font-weight:600;line-height:20px">${title}</div>`
    + (body
      ? `<div style="margin-top:3px;color:${MUTED};font-size:13px;line-height:19px">${body}</div>`
      : '')
    + `</div>`;
}

/** One row inside a grouped list: the thing, and when, on the same line. */
export function listRow(title: string, meta: string): string {
  return `<div style="padding:11px 0">`
    + `<div style="color:${TEXT};font-size:15px;line-height:20px">${title}</div>`
    + `<div style="margin-top:2px;color:${FAINT};font-size:13px;line-height:17px">${meta}</div>`
    + `</div>`;
}

/** A group heading above its rows, with the count beside it. Sentence case at
    13px in the tertiary grey — an iOS section header, not a shout. */
export function listGroup(label: string, count: number, rows: string): string {
  return `<div style="margin:20px 0 6px;font-size:13px;font-weight:600;line-height:18px;color:${MUTED}">${label}`
    + ` <span style="color:${FAINT};font-weight:400">&middot; ${count}</span></div>`
    + rows;
}

/**
 * Groups a set of lists apart from the copy around them.
 *
 * No plate and no border: the hairlines between rows already say where one
 * event ends and the next begins, and a box around them is a second way of
 * saying the same thing.
 */
export function listPlate(groups: string): string {
  return `<div style="margin:24px 0">${groups}</div>`;
}

/** Trailing "n more" line after a list. */
export function moreRow(text: string): string {
  return `<div style="padding:11px 0;font-size:13px;line-height:19px;color:${MUTED}">${text}</div>`;
}

/** The "things to look at" section — a bold lead-in and plain lines, the same
    shape the rest of the mail's prose uses. */
export function attentionPanel(heading: string, lines: string[]): string {
  return `<p style="margin:0 0 8px;font-size:15px;line-height:25px;color:${TEXT}">${heading}</p>`
    + `<ul style="margin:0 0 16px;padding-left:20px">`
    + lines.map((line) =>
        `<li style="margin:0 0 6px;font-size:15px;line-height:24px;color:${TEXT_2}">${line}</li>`).join('')
    + `</ul>`;
}

/** A single quiet line when there is nothing to show. */
export function emptyNote(text: string): string {
  return `<div style="margin:20px 0;font-size:14px;line-height:21px;color:${MUTED}">${text}</div>`;
}

const REF_SHAPE = /^[0-9a-f]{4}(-[0-9a-f]{4}){1,3}$/i;

function escapeHere(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
}

/**
 * The facts of one event, a labelled row each — the shape an operator reads when
 * an alert lands in their inbox.
 *
 * Values are escaped HERE, unlike everything else in this module: an admin alert
 * carries a user-agent string, an address and free text a person typed, none of
 * which any caller sanitized. A reference-shaped value (xxxx-xxxx-…) sets in
 * mono so it can be read one group at a time.
 */
export function factPlate(rows: Array<[string, string]>): string {
  if (!rows.length) return '';
  return `<div style="margin:24px 0;border-top:1px solid ${LINE}">`
    + rows.map(([label, value]) => {
        const mono = REF_SHAPE.test(String(value).trim());
        return `<div style="padding:10px 0;border-bottom:1px solid ${LINE}">`
          + `<div style="font-size:13px;line-height:18px;font-weight:600;color:${MUTED}">${escapeHere(label)}</div>`
          + `<div style="margin-top:3px;font-size:14px;line-height:20px;color:${TEXT};word-break:break-word`
          + (mono ? `;font-family:${MONO}` : '') + `">${escapeHere(value)}</div>`
          + `</div>`;
      }).join('')
    + `</div>`;
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
