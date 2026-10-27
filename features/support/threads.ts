import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/infrastructure/db/prisma';
import { getSession } from '@/features/auth/http-guards';
import { jsonUnauthorized } from '@/shared/response';
import { clientIpOrUnknown } from '@/shared/client-ip';
import { eventRowRef, refCodeCandidates } from '@/features/users/refcode';

/* ═══════════════════════════════════════════════════════════════════════
   The thread, from the account's side of it

   A support request used to be a one-way door: the person wrote, we mailed
   back, and writing again meant starting a new request that arrived looking
   like a first one. This is the other half of the same record — the account
   reading what staff said and answering it, on the reference the whole thread
   is already filed under.

   Nothing new is stored. A thread is the `activity_events` rows that carry one
   `metadata.refCode`, and a follow-up is another row of the same shape, so the
   panel's queue, the account's request record and this screen all read one
   ledger rather than keeping a second copy of the conversation that could
   disagree with the first.

   Three doors:

     GET  /api/support/thread?ref=…      the thread, oldest first
     POST /api/support/thread/reply      write back as the account
     POST /api/support/thread/close      end it (either side may; a reply reopens)

   Who may read it: the account the request belongs to, and nobody else. A code
   is a handle, not a key — it appears in mail subjects and on screens, so the
   owner check is what stops one person's reference opening another's
   conversation. A code that is not yours answers 404, the same as a code that
   does not exist, because "that one belongs to somebody else" is itself a leak.

   How long a session is enough: an hour. Reading a thread is what the mail link
   is for, so it stays open to a signed-in account however old the sign-in is.
   Writing into it is a different act — a phone left open in a café should not
   answer support on your behalf an hour later — so a follow-up after an hour
   idle asks for the same identity proof the account service asks for before it
   deletes anything.
   ═══════════════════════════════════════════════════════════════════════ */

/** Every kind that belongs to a thread. The panel's queue reads this list too,
 *  so a follow-up that the console could not see is not possible. */
export const THREAD_KINDS = [
  'support.request',
  'support.followup',
  'support.reply',
  'support.closed',
];

/** Idle time after which writing back costs an identity proof. */
export const THREAD_REAUTH_IDLE_MS = 60 * 60 * 1000;

const MESSAGE_MIN = 2;
const MESSAGE_MAX = 4000;

/** The three fields a thread is made of. Exported because the request door
 *  groups and reads rows exactly this way when it decides whether a thread is
 *  already open — two answers to "is this conversation finished" is how a
 *  closed thread gets a message nobody will see. */
export type ThreadRow = {
  id: string;
  userId: string | null;
  kind: string;
  title: string;
  detail: string | null;
  metadata: unknown;
  createdAt: Date;
};

/** The code a row answers to — the stamped one, else the one its id derives, so
 *  a thread filed before the stamp existed still groups with itself. */
function refOf(row: { id: string; metadata: unknown }): string {
  return eventRowRef(row);
}

function metaOf(row: { metadata: unknown }): Record<string, any> {
  return (row.metadata || {}) as Record<string, any>;
}

/** What was said. `detail` is a 500-character column, so the full text lives in
 *  the metadata the write put there; the detail is only the fallback. Exported
 *  for the same reason as `ThreadRow`: the request door compares the words
 *  against the last message on the open thread, and a comparison against a
 *  truncated copy of it would let the same note file itself twice. */
export function textOf(row: ThreadRow): string {
  const meta = metaOf(row);
  return typeof meta.message === 'string' && meta.message ? meta.message : (row.detail ?? '');
}

function fromOf(kind: string): 'account' | 'staff' | 'system' {
  if (kind === 'support.reply') return 'staff';
  if (kind === 'support.closed') return 'system';
  return 'account';
}

/** Open, answered or closed — decided by the last word, not by a flag somebody
 *  had to remember to set. A closed thread with a newer follow-up is open
 *  again, which is what the account expects when it writes back. Exported
 *  because the panel's queue and the account's own record answer the same
 *  question and must not have two answers to it. */
export function threadStatusOf(rows: ThreadRow[]): { status: 'open' | 'answered' | 'closed'; waitingOn: 'you' | 'the team' | null } {
  const last = rows[rows.length - 1];
  if (!last) return { status: 'open', waitingOn: 'the team' };
  if (last.kind === 'support.closed') return { status: 'closed', waitingOn: null };
  if (last.kind === 'support.reply') return { status: 'answered', waitingOn: 'you' };
  return { status: 'open', waitingOn: 'the team' };
}

/** Every row of one thread, oldest first, optionally restricted to one
 *  account. The reference reaches the database through every shape it has ever
 *  had — a code is pasted out of a mail subject or read off a screen, and a
 *  thread must resolve from either. */
async function threadRows(ref: string, userId?: string): Promise<ThreadRow[]> {
  const candidates = [...new Set([ref, ...refCodeCandidates(ref)])];
  return prisma.activityEvent.findMany({
    where: {
      kind: { in: THREAD_KINDS },
      ...(userId ? { userId } : {}),
      OR: [
        ...candidates.map((code) => ({ metadata: { path: ['refCode'], equals: code } })),
        { detail: { contains: ref } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true, userId: true, kind: true, title: true, detail: true, metadata: true, createdAt: true },
  }) as Promise<ThreadRow[]>;
}

/** The thread as either side reads it. `mine` is the caller's own permission to
 *  be looking, decided by the handler that did the lookup. */
function threadView(ref: string, rows: ThreadRow[], extra: Record<string, unknown> = {}) {
  const asked = rows.find((r) => r.kind === 'support.request') ?? rows[0];
  const meta = asked ? metaOf(asked) : {};
  const status = threadStatusOf(rows);
  return {
    ref,
    subject: asked?.title ?? meta.subject ?? 'Support',
    status: status.status,
    waitingOn: status.waitingOn,
    askedAt: asked?.createdAt.toISOString() ?? null,
    lastAt: rows.length ? rows[rows.length - 1].createdAt.toISOString() : null,
    closedAt: rows.filter((r) => r.kind === 'support.closed').pop()?.createdAt.toISOString() ?? null,
    messages: rows.map((r) => ({
      id: r.id,
      from: fromOf(r.kind),
      kind: r.kind,
      at: r.createdAt.toISOString(),
      subject: r.title,
      text: textOf(r),
    })),
    ...extra,
  };
}

/** Idle, measured the way the sessions screen measures it: the last time this
 *  session did anything anywhere in the product. A person who has been using
 *  the app for ten minutes is not "away for an hour". */
async function idleMsFor(sessionId?: string): Promise<number | null> {
  if (!sessionId || sessionId === 'cli') return null;
  const row = await prisma.userSession
    .findUnique({ where: { id: sessionId }, select: { createdAt: true, lastUsedAt: true } })
    .catch(() => null);
  if (!row) return null;
  const seen = row.lastUsedAt ?? row.createdAt;
  return Math.max(0, Date.now() - seen.getTime());
}

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

/** Either the account, or the response that says there isn't one. A session
 *  that could not be looked up is a 503, not a 401 — the difference between
 *  "sign in" and "we could not tell", which the console's own load states
 *  depend on. */
async function caller(request: NextRequest): Promise<{ session: Session } | { response: NextResponse }> {
  try {
    const session = await getSession(request);
    if (session) return { session };
    return { response: jsonUnauthorized() ?? NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  } catch (err: any) {
    console.error('[SUPPORT/THREAD] session lookup failed:', err?.message || err);
    return { response: NextResponse.json({ error: 'Could not check your session. Try again.' }, { status: 503 }) };
  }
}

/* ── GET /api/support/thread?ref=… ─────────────────────────────────────── */

export async function supportThreadGetHandler(request: NextRequest) {
  const auth = await caller(request);
  if ('response' in auth) return auth.response;

  const ref = new URL(request.url).searchParams.get('ref')?.trim() ?? '';
  if (!ref) return NextResponse.json({ error: 'No thread reference given' }, { status: 400 });

  const rows = await threadRows(ref, auth.session.userId);
  if (!rows.length) return NextResponse.json({ error: 'No thread with that reference' }, { status: 404 });

  const idle = await idleMsFor(auth.session.sessionId);
  return NextResponse.json(
    { thread: threadView(refOf(rows[0]), rows, { needsReauth: idle !== null && idle > THREAD_REAUTH_IDLE_MS }) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/* ── POST /api/support/thread/reply ────────────────────────────────────── */

export async function supportThreadReplyHandler(request: NextRequest) {
  const auth = await caller(request);
  if ('response' in auth) return auth.response;
  const session = auth.session;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  const message = typeof body.message === 'string' ? messageSafe(body.message) : '';

  if (!ref) return NextResponse.json({ error: 'No thread reference given' }, { status: 400 });
  if (message.length < MESSAGE_MIN) {
    return NextResponse.json({ error: 'Write something before sending it.' }, { status: 400 });
  }
  if (message.length > MESSAGE_MAX) {
    return NextResponse.json({ error: `Keep it under ${MESSAGE_MAX} characters — a person reads these.` }, { status: 400 });
  }

  const rows = await threadRows(ref, session.userId);
  if (!rows.length) return NextResponse.json({ error: 'No thread with that reference' }, { status: 404 });

  /* An hour away and the door is a stranger's; the proof is the same one the
     account service asks for before it deletes anything, and it rides inside
     this request rather than in a cookie that could outlive the moment. */
  const idle = await idleMsFor((session as { sessionId?: string }).sessionId);
  if (idle !== null && idle > THREAD_REAUTH_IDLE_MS) {
    const { requireReauth } = await import('@/features/auth/reauth');
    const proof = await requireReauth(request, session.userId, { body });
    if ('response' in proof) return proof.response;
  }

  const { checkWindowLimitDB } = await import('@/features/captcha/risk');
  const ip = clientIpOrUnknown(request.headers);
  if (!(await checkWindowLimitDB(`support:followup:${session.userId}`, 10, 15 * 60 * 1000, ip))) {
    return NextResponse.json({ error: 'Too many messages just now. Give it a few minutes.' }, { status: 429 });
  }

  const code = refOf(rows[0]);
  const subject = rows.find((r) => r.kind === 'support.request')?.title ?? 'Support';

  const row = await prisma.activityEvent.create({
    data: {
      userId: session.userId,
      kind: 'support.followup',
      title: subject,
      detail: message.slice(0, 500),
      severity: 'info',
      ipAddress: ip === 'unknown' ? null : ip,
      userAgent: request.headers.get('user-agent') || null,
      metadata: {
        refCode: code,
        message,
        subject,
        channel: 'in-app',
        inReplyTo: rows[rows.length - 1].id,
      } as never,
    },
  });

  /* No mail goes to staff from here. The first message of a thread told them;
     everything after this point is a conversation happening where it is
     written — in the thread. A follow-up that mailed the whole roster would
     turn a three-message exchange into three mails about the same reference,
     which is the noise that makes people stop reading the subject line. */

  const after = [...rows, { ...row, createdAt: row.createdAt ?? new Date() } as ThreadRow];
  return NextResponse.json({ ok: true, message: {
    id: row.id, from: 'account', kind: 'support.followup',
    at: (row.createdAt ?? new Date()).toISOString(), subject, text: message,
  }, thread: threadView(code, after) });
}

/** A support message is a message, not markup. Control characters go because the
 *  row is rendered as one block of text — in the thread and in the mail — where
 *  a stray escape is a broken screen. Newlines and tabs stay: the account's
 *  sheet files the record's facts under the note, and a mail needs to show them
 *  on separate lines. Exported because both doors write the same kind of row. */
export function messageSafe(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '').trim();
}

/* ── POST /api/support/thread/close ────────────────────────────────────── */

export async function supportThreadCloseHandler(request: NextRequest) {
  const auth = await caller(request);
  if ('response' in auth) return auth.response;
  const session = auth.session;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const ref = typeof body.ref === 'string' ? body.ref.trim() : '';
  if (!ref) return NextResponse.json({ error: 'No thread reference given' }, { status: 400 });

  const rows = await threadRows(ref, session.userId);
  if (!rows.length) return NextResponse.json({ error: 'No thread with that reference' }, { status: 404 });
  const status = threadStatusOf(rows);
  if (status.status === 'closed') {
    return NextResponse.json({ ok: true, alreadyClosed: true, thread: threadView(refOf(rows[0]), rows) });
  }

  const code = refOf(rows[0]);
  const subject = rows.find((r) => r.kind === 'support.request')?.title ?? 'Support';
  const ip = clientIpOrUnknown(request.headers);
  const row = await prisma.activityEvent.create({
    data: {
      userId: session.userId,
      kind: 'support.closed',
      title: subject,
      detail: `Closed by the account on the thread ${code}.`,
      severity: 'info',
      ipAddress: ip === 'unknown' ? null : ip,
      metadata: { refCode: code, subject, by: 'account' } as never,
    },
  });

  const after = [...rows, { ...row, createdAt: row.createdAt ?? new Date() } as ThreadRow];
  return NextResponse.json({ ok: true, thread: threadView(code, after) });
}
