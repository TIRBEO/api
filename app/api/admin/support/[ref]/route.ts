import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requirePermission } from '@/features/auth/http-guards';
import { eventRowRef, refCodeCandidates } from '@/features/users/refcode';
import { THREAD_KINDS as SUPPORT_THREAD_KINDS, threadStatusOf } from '@/features/support/threads';
import { getSupportThreadUrl } from '@/config/app-urls';

/* ═══════════════════════════════════════════════════════════════════
   GET /api/admin/support/[ref] — one thread, everything about it

   The whole conversation, in the order it happened, with the account's own
   facts beside it and the mail that went out underneath. A code is pasted from
   a mail or read off the account's screen, so it resolves through every shape
   the code has ever had: stamped metadata, the id-derived form, and the legacy
   widths `refCodeCandidates` covers.

   This is also the page a reply is written on, so it answers the question that
   makes a reply safe to send: is this account still here, and what is the
   address an answer would actually reach?
   ═══════════════════════════════════════════════════════════════════ */

/* The thread is one list of kinds, shared with the account's own read of it, so
   a follow-up the person wrote cannot be invisible to the queue that answers it. */
const THREAD_KINDS = SUPPORT_THREAD_KINDS;
/** The mail this thread could have sent. The delivery log files a template
    under `event_key` as `legacy.<template>` — its `event` column holds the
    outcome ('sent'/'failed'), not the name, so matching on `event` would find
    nothing and read as "no mail was ever sent". */
const THREAD_EMAIL_KEYS = ['support_request_received', 'support_request_admin', 'support_reply']
  .map((t) => `legacy.${t}`);

export async function GET(request: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const admin = await requirePermission(request, 'tickets.read');
    if (admin instanceof NextResponse) return admin;

    const { ref: raw } = await params;
    const ref = decodeURIComponent(raw ?? '').trim();
    if (!ref) return NextResponse.json({ error: 'No reference given' }, { status: 400 });

    /* Every code this thread might be filed under. A pasted code that is one
       digit short of a uuid's worth still resolves, because both sides quote
       the code they were shown, not the id behind it. Prisma matches one JSON
       path at a time, so the candidates are ORed rather than handed to `in`. */
    const candidates = [...new Set([ref, ...refCodeCandidates(ref)])];

    const rows = await prisma.activityEvent.findMany({
      where: {
        kind: { in: THREAD_KINDS },
        OR: [
          ...candidates.map((code) => ({ metadata: { path: ['refCode'], equals: code } })),
          { detail: { contains: ref } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true, userId: true, kind: true, title: true, detail: true, metadata: true,
        ipAddress: true, userAgent: true, createdAt: true,
        user: {
          select: {
            id: true, email: true, username: true, status: true,
            profile: { select: { name: true } },
          },
        },
      },
    });

    if (!rows.length) return NextResponse.json({ error: 'No thread with that reference' }, { status: 404 });

    const asked = rows.find((r) => r.kind === 'support.request') ?? rows[0];
    const meta = (asked.metadata || {}) as Record<string, any>;
    const replies = rows.filter((r) => r.kind === 'support.reply');
    const userId = asked.userId ?? rows.find((r) => r.userId)?.userId ?? null;

    const [emails, primary] = await Promise.all([
      /* The send log for this thread. Two doors reach the same rows: a job
         stamped with this reference as its thread id (which is how the staff
         copy is filed, whatever mailbox it went to), and any support mail
         addressed to one of this account's own addresses (the confirmation and
         the answer). A delivery row that cannot be read is not a reason to
         lose the thread, so the whole read falls back to nothing. */
      userId
        ? (async () => {
            const [jobs, mailboxRows] = await Promise.all([
              prisma.email_jobs.findMany({
                where: { payload: { path: ['threadId'], equals: ref } },
                select: { id: true },
                take: 40,
              }),
              prisma.userEmail.findMany({ where: { userId }, select: { address: true } }),
            ]);
            const recipients = [...new Set([
              ...(asked.user?.email ? [asked.user.email.toLowerCase()] : []),
              ...mailboxRows.map((m) => m.address.toLowerCase()),
            ])];
            return prisma.email_deliveries.findMany({
              where: {
                eventKey: { in: THREAD_EMAIL_KEYS },
                OR: [
                  ...(jobs.length ? [{ jobId: { in: jobs.map((j) => j.id) } }] : []),
                  ...(recipients.length ? [{ toEmail: { in: recipients } }] : []),
                ],
              },
              orderBy: { createdAt: 'desc' },
              take: 12,
              select: { toEmail: true, eventKey: true, subject: true, status: true, createdAt: true, openedAt: true },
            });
          })().catch(() => [])
        : Promise.resolve([]),
      // The address an answer reaches is the account service's decision, not
      // this screen's guess — so it is read through the same function the
      // confirmation mail used.
      userId
        ? import('@/features/notifications/notifications')
            .then(({ primaryEmailForUser }) => primaryEmailForUser(userId))
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      thread: {
        ref: eventRowRef(asked),
        subject: asked.title,
        // The 500-character column is a preview; the message the person wrote
        // is in metadata and is what an answer has to be written against.
        message: typeof meta.message === 'string' && meta.message ? meta.message : (asked.detail ?? ''),
        status: threadStatusOf(rows as never[]).status,
        askedAt: asked.createdAt.toISOString(),
        answeredAt: replies.length ? replies[replies.length - 1].createdAt.toISOString() : null,
        closedAt: rows.filter((r) => r.kind === 'support.closed').pop()?.createdAt.toISOString() ?? null,
        /** The account's own side of this thread — the address the reply mail
            links to, and the one place a follow-up can be written. */
        threadUrl: getSupportThreadUrl(eventRowRef(asked)),
        account: asked.user ? {
          id: asked.user.id,
          email: asked.user.email,
          username: asked.user.username,
          name: asked.user.profile?.name ?? null,
          status: asked.user.status,
          // Where an answer lands — the address the account marks primary, not
          // necessarily the login address this row happens to hold.
          replyTo: primary ?? asked.user.email,
        } : null,
        device: typeof meta.device === 'string' ? meta.device : null,
        location: typeof meta.location === 'string' ? meta.location : null,
        ip: asked.ipAddress,
        messages: rows.map((r) => ({
          id: r.id,
          ref: eventRowRef(r),
          from: r.kind === 'support.reply' ? 'staff' : r.kind === 'support.closed' ? 'system' : 'account',
          at: r.createdAt.toISOString(),
          subject: r.title,
          text: (() => {
            const m = (r.metadata || {}) as Record<string, any>;
            return typeof m.message === 'string' && m.message ? m.message : (r.detail ?? '');
          })(),
        })),
        emails: emails.map((e) => ({
          to: e.toEmail,
          event: e.eventKey.replace(/^legacy\./, ''),
          subject: e.subject,
          status: e.status,
          at: e.createdAt.toISOString(),
          openedAt: e.openedAt ? e.openedAt.toISOString() : null,
        })),
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT THREAD]', err?.message || err);
    return NextResponse.json({ error: 'Failed to read the thread' }, { status: 500 });
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   POST /api/admin/support/[ref] — answer it, or end it

   Two actions on one door, because both are a staff member acting on a thread
   they have just read, and the record they leave has to be the same shape.

     { action: 'reply', text, sendEmail? }  — answer. Always writes the row;
       mails it only when asked.
     { action: 'close' }                    — end the thread. The account is
       told either way, in the app it is already signed into.

   An answer without the mail is the point of `sendEmail`: most threads are
   answered in the app the person is already reading this one in, and a mail for
   every keystroke is how a support address becomes noise. The ledger row and
   the account's notification are never optional — an answer that exists only in
   one place is an answer nobody can find afterwards.

   The mail, when it goes, carries the thread's own URL. That is what turns a
   one-way reply into a conversation: the person can write back into the same
   reference instead of filing a new request that looks like a first one.
   ═══════════════════════════════════════════════════════════════════════ */

const REPLY_MAX = 4000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const staff = await requirePermission(request, 'tickets.answer');
    if (staff instanceof NextResponse) return staff;

    const { ref: raw } = await params;
    const ref = decodeURIComponent(raw ?? '').trim();
    if (!ref) return NextResponse.json({ error: 'No reference given' }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action === 'close' ? 'close' : body.action === 'reply' ? 'reply' : null;
    if (!action) return NextResponse.json({ error: 'Nothing to do — reply or close.' }, { status: 400 });

    const candidates = [...new Set([ref, ...refCodeCandidates(ref)])];
    const rows = await prisma.activityEvent.findMany({
      where: {
        kind: { in: THREAD_KINDS },
        OR: [
          ...candidates.map((code) => ({ metadata: { path: ['refCode'], equals: code } })),
          { detail: { contains: ref } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, userId: true, kind: true, title: true, detail: true, metadata: true, createdAt: true },
    });
    if (!rows.length) return NextResponse.json({ error: 'No thread with that reference' }, { status: 404 });

    const asked = rows.find((r) => r.kind === 'support.request') ?? rows[0];
    const code = eventRowRef(asked);
    const subject = asked.title;
    const userId = asked.userId ?? rows.find((r) => r.userId)?.userId ?? null;
    const now = new Date();

    const [{ primaryEmailForUser }, { createNotification }] = await Promise.all([
      import('@/features/notifications/notifications'),
      import('@/features/notifications/notifications'),
    ]);
    const to = userId ? await primaryEmailForUser(userId).catch(() => null) : null;
    const threadUrl = getSupportThreadUrl(code);

    if (action === 'close') {
      const row = await prisma.activityEvent.create({
        data: {
          userId,
          kind: 'support.closed',
          title: subject,
          detail: `Closed ${code} from the panel.`,
          severity: 'info',
          metadata: { refCode: code, subject, byAdmin: staff.userId, by: 'staff' } as never,
        },
      });
      if (userId) {
        createNotification({
          userId,
          type: 'support',
          title: 'Your request was closed',
          body: `The thread on "${subject}" is closed. Writing to it again opens it, and the same person sees it.`,
          link: `/support/thread/${encodeURIComponent(code)}`,
          skipEmail: true,
          metadata: { refCode: code, subject } as never,
        }).catch(() => {});
      }
      return NextResponse.json({ ok: true, closedAt: row.createdAt ?? now, ref: code });
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length < 2) return NextResponse.json({ error: 'Write something before sending it.' }, { status: 400 });
    if (text.length > REPLY_MAX) {
      return NextResponse.json({ error: `Keep it under ${REPLY_MAX} characters — a person reads these.` }, { status: 400 });
    }
    const sendEmail = body.sendEmail !== false;

    const row = await prisma.activityEvent.create({
      data: {
        userId,
        kind: 'support.reply',
        title: `Re: ${subject}`,
        detail: `Answered ${code} from the panel${sendEmail ? ' and by mail.' : '.'}`,
        severity: 'info',
        metadata: {
          refCode: code,
          message: text.slice(0, 2000),
          subject,
          byAdmin: staff.userId,
          to,
          emailed: sendEmail,
          threadUrl,
        } as never,
      },
    });

    /* The mail is the only part allowed to fail quietly. The answer is already
       on the record and the account is already being told; a provider that
       takes a moment over a copy must not put the operator back at the top of
       the form with an answer already sent. */
    let emailed = false;
    if (sendEmail && to) {
      const { sendTemplateEmail } = await import('@/features/email/email');
      const result = await sendTemplateEmail(to, 'support_reply', {
        subject: `Re: ${subject}`,
        refCode: code,
        replyHtml: paragraphs(text),
        threadUrl,
        receivedAt: (asked.createdAt ?? now).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      }, { replyTo: to, threadId: code, fromName: 'Tirbeo Support' }).catch(() => null);
      emailed = !!result?.success;
    }

    if (userId) {
      createNotification({
        userId,
        type: 'support',
        title: 'The team replied to your request',
        body: text.slice(0, 180),
        link: `/support/thread/${encodeURIComponent(code)}`,
        // The mail above already said this, in the same words. An account that
        // asked to be emailed should not be emailed and pinged for one answer.
        skipEmail: true,
        metadata: { refCode: code, subject, threadUrl } as never,
      }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      ref: code,
      messageId: row.id,
      emailed,
      // A thread answered here and nowhere else still reaches the person; say
      // which of the two happened so the panel does not claim a mail it did not
      // send (or hide one that failed).
      ...(sendEmail && to && !emailed ? { warning: `Written down, but the mail to ${to} did not go.` } : {}),
    });
  } catch (err: any) {
    console.error('[ADMIN SUPPORT ACTION]', err?.message || err);
    return NextResponse.json({ error: 'Failed to act on the thread' }, { status: 500 });
  }
}

/** Plain text from a textarea into mail-safe HTML — escaped first, so a reply
 *  that quotes somebody's angle brackets cannot become markup in the mail. */
function paragraphs(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 12px;font-size:15px;line-height:25px;color:#344054">${escape(block).replace(/\n/g, '<br />')}</p>`)
    .join('');
}
