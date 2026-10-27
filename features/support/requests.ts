import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { clientIpOrUnknown } from '@/shared/client-ip';
import { getSupportThreadUrl } from '@/config/app-urls';
import { THREAD_KINDS, messageSafe, textOf, threadStatusOf, type ThreadRow } from '@/features/support/threads';

/* ═══════════════════════════════════════════════════════════════════
   Support — a message from the account to the people who read it

   There is no ticket system here on purpose. What a support request needs is
   three things, all of which already exist: a row in the event ledger (it is
   the only store every screen already reads), a reference code that row carries
   so a reply thread has one handle, and mail in both directions.

   POST /api/support/request { subject?, message }
     → 200 { ok, ref, subject, receivedAt, intoThread?, alreadyOnRecord? }

   The account must be signed in — the point of the message is to answer a
   person, and an anonymous one has no thread to reply into. A CLOSED account
   can still file: being shut out of the product is exactly when the message is
   needed, so this door stays open on the gate (see features/auth/blockFacts).

   One thread is open per account at a time. A second filing while one is
   waiting is the same person still waiting, so it becomes the next message on
   the thread that exists rather than a second ticket with a second subject line
   and a second mail to the same reader — which is what made an unanswered
   question possible to send, and mail, an unlimited number of times. Reclosing
   it is the account's own doing: the thread page has a Close, and closing is
   what makes the next message a new request again.

   This door does not ask for the identity proof the thread page asks for after
   an hour idle, and that is deliberate rather than a gap: the proof guards
   answering a conversation someone else started, while filing one's own message
   is the thing a locked-out account must always be able to do — and the sheet it
   comes from has no way to present a proof. A session that can file can only
   ever add the account's own words to the account's own thread.
   ═══════════════════════════════════════════════════════════════════ */

const MESSAGE_MIN = 20;
const MESSAGE_MAX = 4000;
const DEFAULT_SUBJECT = 'A question about my account';

/** A subject is typed by a person and then travels into an email header, where
    a carriage return is not a typo but a second header. Everything the reader
    might have pasted that is not printable becomes a space. */
function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** The same words, typed twice. Whitespace and case carry no meaning a reader
    would want preserved, so a note that differs only by a trailing space is the
    note that was already sent — and sending it again is the button being
    pressed a second time, not a second fact for the person on the other end. */
function sameWords(a: string, b: string): boolean {
  const flat = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
  return flat(a) === flat(b);
}

export async function supportRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? messageSafe(body.message) : '';
    const subject = (typeof body.subject === 'string' && headerSafe(body.subject))
      ? headerSafe(body.subject).slice(0, 120)
      : DEFAULT_SUBJECT;

    if (message.length < MESSAGE_MIN) {
      return NextResponse.json(
        { error: `Tell us in at least ${MESSAGE_MIN} characters — a one-line message is usually answered with a question.` },
        { status: 400 },
      );
    }
    if (message.length > MESSAGE_MAX) {
      return NextResponse.json(
        { error: `Keep it under ${MESSAGE_MAX} characters — a person reads these.` },
        { status: 400 },
      );
    }

    const ip = clientIpOrUnknown(request.headers);

    /* Before the counters: an unchanged note is neither a new request nor an
       attempt, and charging either budget for it would turn "did that send?"
       into "wait fifteen minutes to find out". */
    const open = await openThreadFor(session.userId);
    if (open && sameWords(open.lastText, message)) {
      return NextResponse.json({
        ok: true,
        ref: open.ref,
        subject: open.subject,
        receivedAt: open.at.toISOString(),
        alreadyOnRecord: true,
      });
    }
    if (open) return fileAsFollowUp({ userId: session.userId, request, open, message, ip });

    // Five filings a quarter-hour is generous for a form nobody automates and
    // cheap enough to stop a button being held down.
    const { checkWindowLimitDB } = await import('@/features/captcha/risk');
    if (!(await checkWindowLimitDB(`support:request:user:${session.userId}`, 5, 15 * 60 * 1000, ip))) {
      return NextResponse.json(
        { error: 'Too many messages just now. Give it a few minutes and send one.' },
        { status: 429 },
      );
    }

    /* The ledger row is the request. The write choke point stamps its
       metadata.refCode, and reading it back from the created row — rather than
       deriving a second code — is what lets the confirmation mail, the admin
       alert, and the account's own inbox row all quote ONE handle.

       The device and the place are written beside the message on purpose. The
       admin screen reads this row, not the mail, so a fact that only ever
       existed in one of them is a fact the panel can't show — which is how a
       ticket ends up saying "an unknown device" about a message that arrived
       from a phone in Kathmandu. */
    const { describeDevice } = await import('@/features/notifications/notifications');
    const { resolveLoginPlace } = await import('@/shared/geo');
    const device = describeDevice(request.headers.get('user-agent'));
    const place = resolveLoginPlace(request.headers);
    const row = await prisma.activityEvent.create({
      data: {
        userId: session.userId,
        kind: 'support.request',
        title: subject,
        detail: message.slice(0, 500),
        severity: 'info',
        ipAddress: ip === 'unknown' ? null : ip,
        userAgent: request.headers.get('user-agent') || null,
        metadata: {
          message, subject, channel: 'in-app',
          ...(device ? { device } : {}),
          ...(place ? { location: place } : {}),
        } as never,
      },
    });
    const { eventRowRef } = await import('@/features/users/refcode');
    const ref = eventRowRef(row);
    const receivedAt = row.createdAt ?? new Date();

    /* The answer the person is waiting for is the code, and the code exists the
       moment the row does. Everything below — the inbox row, the confirmation
       mail, the staff copy — answers to the record, not to the request, so it
       runs after the reply is on its way. The provider is free to take a second
       over a mail; the Send button is not free to wait for it. */
    void deliverSupportRequest({
      userId: session.userId,
      ref,
      subject,
      message,
      receivedAt,
      ip: ip === 'unknown' ? null : ip,
      device,
      place,
    }).catch((err: any) => console.error('[SUPPORT/DELIVER]', err?.message || err));

    return NextResponse.json({
      ok: true,
      ref,
      subject,
      receivedAt: receivedAt.toISOString(),
    });
  } catch (err: any) {
    console.error('[SUPPORT/REQUEST]', err?.message || err);
    return NextResponse.json({ error: 'Failed to send the message' }, { status: 500 });
  }
}

/* ── the thread this message belongs to, if there is one ───────────────── */

type OpenThread = {
  ref: string;
  subject: string;
  /** The row to answer, so the panel can tell whose turn it is from the same
      rows the account's sheet just wrote. */
  lastId: string;
  lastText: string;
  at: Date;
};

/** The newest thread this account has that is not closed, or none.

    Threads are grouped from the ledger rows rather than from a ticket table,
    because there is no ticket table — and the grouping is done here in memory
    rather than by a second query per candidate, since an account with twelve
    follow-ups on one reference must not cost twelve reads to answer one
    question. `threadStatusOf` is imported, not re-derived: the panel's queue,
    the thread page and this decision all read "closed" off the last word, and
    a fourth opinion on it is a bug report waiting to be filed.

    A lookup that cannot be answered returns null and the message files as a
    fresh request. That is the deliberate direction to fail: this is the door a
    locked-out account knocks on, and a read error on our side is not a reason
    to refuse someone their message. The window limiter still backstops a flood. */
async function openThreadFor(userId: string): Promise<OpenThread | null> {
  try {
    const rows = await prisma.activityEvent.findMany({
      where: { userId, kind: { in: THREAD_KINDS } },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: { id: true, userId: true, kind: true, title: true, detail: true, metadata: true, createdAt: true },
    }) as ThreadRow[];
    if (!rows.length) return null;

    const { eventRowRef } = await import('@/features/users/refcode');
    const threads = new Map<string, ThreadRow[]>();
    for (const row of rows) {
      const code = eventRowRef(row);
      const group = threads.get(code);
      if (group) group.push(row);
      else threads.set(code, [row]);
    }

    let open: ThreadRow[] | null = null;
    for (const group of threads.values()) {
      if (threadStatusOf(group).status === 'closed') continue;
      const last = group[group.length - 1];
      if (!open || last.createdAt >= open[open.length - 1].createdAt) open = group;
    }
    if (!open) return null;

    const asked = open.find((r) => r.kind === 'support.request') ?? open[0];
    const last = open[open.length - 1];
    /* The words to compare against are the last message, and only when the
       account wrote it: with the thread waiting on the team, the same note sent
       again is the button pressed twice. Once staff or a close has spoken,
       those same words are a new fact — "still not fixed" — and it goes on the
       thread. An empty `lastText` matches nothing, which is the point. */
    const waiting = last.kind === 'support.request' || last.kind === 'support.followup';
    return {
      ref: eventRowRef(asked),
      subject: asked?.title || DEFAULT_SUBJECT,
      lastId: last.id,
      lastText: waiting ? textOf(last) : '',
      at: asked?.createdAt ?? last.createdAt ?? new Date(),
    };
  } catch (err: any) {
    console.error('[SUPPORT/THREAD-LOOKUP]', err?.message || err);
    return null;
  }
}

/** A filing that joins the open thread instead of opening a second one: the
    same row the thread page writes, the same reference, and no mail — the first
    message already told staff about this one. */
async function fileAsFollowUp(opts: {
  userId: string;
  request: NextRequest;
  open: OpenThread;
  message: string;
  ip: string;
}): Promise<NextResponse> {
  const { userId, request, open, message, ip } = opts;
  const { checkWindowLimitDB } = await import('@/features/captcha/risk');
  // One budget with the thread page: writing from the sheet and writing from
  // the record screen are the same act and must not have separate allowances.
  if (!(await checkWindowLimitDB(`support:followup:${userId}`, 10, 15 * 60 * 1000, ip))) {
    return NextResponse.json(
      { error: `Too many messages just now — your record ${open.ref} is still open and your last one is on it.` },
      { status: 429 },
    );
  }

  const row = await prisma.activityEvent.create({
    data: {
      userId,
      kind: 'support.followup',
      title: open.subject,
      detail: message.slice(0, 500),
      severity: 'info',
      ipAddress: ip === 'unknown' ? null : ip,
      userAgent: request.headers.get('user-agent') || null,
      metadata: {
        refCode: open.ref,
        message,
        subject: open.subject,
        channel: 'in-app',
        inReplyTo: open.lastId,
      } as never,
    },
  });
  const at = row.createdAt ?? new Date();

  /* Nothing is mailed from here, to the account or to staff. Both already have
     a thread that quotes this reference and a screen that shows it; a third
     copy of the same conversation is the noise that makes people stop reading
     the subject line. The link below is the door back to it. */
  return NextResponse.json({
    ok: true,
    ref: open.ref,
    subject: open.subject,
    receivedAt: at.toISOString(),
    intoThread: true,
    threadUrl: getSupportThreadUrl(open.ref),
  });
}

/** The three copies one filing lives in, all off the response path. A failure
    here loses a mail, never the record — the ledger row is already on file. */
async function deliverSupportRequest(filing: {
  userId: string;
  ref: string;
  subject: string;
  message: string;
  receivedAt: Date;
  ip: string | null;
  /** The two facts the row was written with, handed over rather than
      re-derived: the mail and the ledger record must never disagree. */
  device: string | null;
  place: string | null;
}) {
  const { ref, subject, message, userId } = filing;
  const receivedLabel = filing.receivedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  // The account's copy: an in-app row, and the mail that carries the code.
  const { createNotification, primaryEmailForUser } = await import('@/features/notifications/notifications');
  createNotification({
    userId,
    type: 'support',
    title: subject,
    body: message.slice(0, 180),
    link: '/support',
    skipEmail: true,
    metadata: { ref, subject, channel: 'in-app' },
  }).catch(() => {});

  const [{ email }, who] = await Promise.all([
    primaryEmailForUser(userId).then((e) => ({ email: e })).catch(() => ({ email: null as string | null })),
    import('@/features/identity/tirbeo').then((m) => m.fetchLoginUserById(userId).catch(() => null)),
  ]);
  if (email) {
    const { sendTemplateEmailAfter } = await import('@/features/email/email');
    sendTemplateEmailAfter(email, 'support_request_received', {
      primaryEmail: email,
      refCode: ref,
      // The thread, not the mailbox: this link is what lets the person answer
      // the same request instead of filing a second one.
      threadUrl: getSupportThreadUrl(ref),
      message,
      ticketSubject: subject,
      receivedAt: receivedLabel,
    });
  }

  /* And the people on the other end of it — the same code the account was
     just given, so one quote opens both sides. Staff read the account's own
     identity as the sender and reply into the mailbox the person checks,
     which for most accounts are two different addresses. */
  const { notifyAdminsOfSupportRequest } = await import('@/features/security/security');
  const { tirbeoEmailFor } = await import('@/features/identity/tirbeo');
  // The handle is the account's name here — an admin reading `gmail-address`
  // has to open the record to find out who it belongs to.
  const identity = who?.username ? tirbeoEmailFor(who.username) : (who?.email || null);
  await notifyAdminsOfSupportRequest({
    refCode: ref,
    subject,
    message,
    replyTo: email || who?.email || '',
    identity,
    senderName: (who?.name || '').trim() || (who?.username || email || 'An account').split('@')[0],
    receivedAt: filing.receivedAt,
    device: filing.device,
    location: filing.place,
    ip: filing.ip,
  });
}
