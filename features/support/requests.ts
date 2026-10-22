import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';

/* ═══════════════════════════════════════════════════════════════════
   Support — a message from the account to the people who read it

   There is no ticket system here on purpose. What a support request needs is
   three things, all of which already exist: a row in the event ledger (it is
   the only store every screen already reads), a reference code that row carries
   so a reply thread has one handle, and mail in both directions.

   POST /api/support/request { subject?, message }
     → 200 { ok, ref, receivedAt, subject }

   The account must be signed in — the point of the message is to answer a
   person, and an anonymous one has no thread to reply into. A CLOSED account
   can still file: being shut out of the product is exactly when the message is
   needed, so this door stays open on the gate (see features/auth/blockFacts).
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

export async function supportRequestHandler(request: NextRequest) {
  try {
    const session = await getSession(request);
    if (!session) return jsonUnauthorized();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message.trim() : '';
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

    // Five filings a quarter-hour is generous for a form nobody automates and
    // cheap enough to stop a button being held down.
    const { checkWindowLimitDB } = await import('@/features/captcha/risk');
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
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
