import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { requireAdmin } from '@/features/auth/http-guards';
import { eventRowRef, refCodeCandidates } from '@/features/users/refcode';

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

const THREAD_KINDS = ['support.request', 'support.reply'];
/** The mail this thread could have sent. The delivery log files a template
    under `event_key` as `legacy.<template>` — its `event` column holds the
    outcome ('sent'/'failed'), not the name, so matching on `event` would find
    nothing and read as "no mail was ever sent". */
const THREAD_EMAIL_KEYS = ['support_request_received', 'support_request_admin', 'support_reply']
  .map((t) => `legacy.${t}`);

export async function GET(request: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  try {
    const admin = await requireAdmin(request);
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
        status: replies.length ? 'answered' : 'open',
        askedAt: asked.createdAt.toISOString(),
        answeredAt: replies.length ? replies[replies.length - 1].createdAt.toISOString() : null,
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
          from: r.kind === 'support.reply' ? 'staff' : 'account',
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
