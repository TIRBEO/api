import { randomBytes } from 'node:crypto';
import { prisma } from '@/infrastructure/db/prisma';
import { createSession, revokeSession } from '@/features/auth/session';

/* Local-only end-to-end pass over the two flows that were last rebuilt: the
   lift (reason → three agreeing rows → mail → the account's own screen) and the
   one-open-thread rule on support. Sessions are minted and revoked inside this
   process; the tokens never leave it. */

const API = process.env.SMOKE_API_ORIGIN ?? 'http://localhost:3000';
const ADMIN = process.env.SMOKE_ADMIN_ORIGIN ?? 'http://localhost:4000';

const REASON_LIFT = 'A reviewer checked the record and the report behind the suspension did not hold.';
const REASON_BACK = 'Re-suspended by the same smoke pass that lifted it, so the screen is testable again.';
const NOTE_ONE = 'Smoke test of the thread rule: this note is filed once and any repeat joins the same record.';
const NOTE_TWO = 'Smoke test after the close: this one should open a fresh reference and mail the desk once.';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

type Jar = { token: string; csrf: string };

async function call(
  origin: string, path: string, jar: Jar,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const method = init.method ?? 'GET';
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie: `__session=${jar.token}; __csrf=${jar.csrf}`,
      'x-csrf-token': jar.csrf,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

function jarFor(token: string): Jar {
  return { token, csrf: randomBytes(16).toString('hex') };
}

async function mint(userId: string, label: string): Promise<{ jar: Jar; sessionId: string }> {
  const { token, sessionId } = await createSession(userId, `Mozilla/5.0 SMOKE ${label}`, '127.0.0.1');
  return { jar: jarFor(token), sessionId };
}

async function mailsSince(since: Date) {
  return prisma.email_jobs.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { toAddress: true, toEmail: true, templateSlug: true, eventKey: true, status: true, subject: true },
  });
}

/** Delivery runs off the response path, so a check that reads the job table
    straight back from a filing sees an empty window. Wait for the pair the
    filing is supposed to produce, then count. */
async function awaitMails(since: Date, want: string[], limitMs = 15_000) {
  const deadline = Date.now() + limitMs;
  let rows: Awaited<ReturnType<typeof mailsSince>> = [];
  for (;;) {
    rows = await mailsSince(since);
    const keys = rows.map((r: any) => (r.templateSlug || r.eventKey || '').replace(/^legacy\./, ''));
    if (want.every((w) => keys.includes(w)) || Date.now() > deadline) return { rows, keys };
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

async function main() {
  const target = await prisma.user.findFirst({
    where: { status: { in: ['suspended', 'banned'] } },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, email: true, username: true, status: true },
  });
  if (!target) throw new Error('no suspended or banned account to exercise the lift on');
  const operator = await prisma.user.findFirst({
    where: { isAdmin: true, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, username: true },
  });
  if (!operator) throw new Error('no staff account to act as');
  console.log(`account under test: ${target.username ?? target.email} (${target.status})`);
  console.log(`operator:           ${operator.username ?? operator.email}\n`);

  const staff = await mint(operator.id, 'staff');
  const self = await mint(target.id, 'self');
  const asStaff = staff.jar;
  const asSelf = self.jar;
  const started = new Date();

  try {
    /* ── 1. the lift ─────────────────────────────────────────────────────── */
    console.log('1 — lifting the sanction through the console’s own door');
    const action = target.status === 'banned' ? 'unban' : 'unsuspend';
    const noReason = await call(ADMIN, '/api/people/action', asStaff, {
      method: 'POST', body: { id: target.id, action, reason: '   ' },
    });
    check('a lift with no reason is refused', noReason.status === 400, `${noReason.status} ${JSON.stringify(noReason.json).slice(0, 160)}`);

    const lifted = await call(ADMIN, '/api/people/action', asStaff, {
      method: 'POST', body: { id: target.id, action, reason: REASON_LIFT },
    });
    check('the lift answers 200 with a reference', lifted.status === 200 && !!lifted.json?.reference,
      JSON.stringify(lifted.json).slice(0, 200));

    const after = await prisma.user.findUnique({
      where: { id: target.id }, select: { status: true },
    });
    check('the account is active', after?.status === 'active', `status=${after?.status}`);

    const openRestriction = await prisma.userRestriction.findFirst({
      where: { userId: target.id, guideline: 'admin-enforcement', OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
      select: { id: true, endsAt: true },
    });
    check('no enforcement restriction is left open', !openRestriction, JSON.stringify(openRestriction));

    const event = await prisma.userStatusEvent.findFirst({
      where: { userId: target.id, toStatus: 'active' as any },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, metadata: true, createdAt: true },
    });
    const meta = (event?.metadata ?? {}) as Record<string, any>;
    check('the status event carries the reason and the reference',
      event?.reason === REASON_LIFT && meta.refCode === lifted.json?.reference,
      `reason=${String(event?.reason).slice(0, 40)} ref=${meta.refCode}`);

    /* A template mail is queued under `legacy.<template>` and carries no user
       id — the address is what links it to the account. */
    const { primaryEmailForUser } = await import('@/features/notifications/notifications');
    const mailbox = await primaryEmailForUser(target.id).catch(() => null);
    const { rows: liftMails } = await awaitMails(started, ['account_reinstated']);
    const reinstated = liftMails.filter((row: any) => row.eventKey === 'legacy.account_reinstated');
    const to = (row: any) => row.toAddress || row.toEmail;
    check('the account is mailed the lift, once, to its own address',
      reinstated.length === 1 && (!mailbox || to(reinstated[0]) === mailbox),
      JSON.stringify(reinstated));

    /* ── 2. the account’s own screen ─────────────────────────────────────── */
    console.log('\n2 — what the account’s own status screen now says');
    const checks = await call(API, '/api/user/account-checks', asSelf);
    const body = JSON.stringify(checks.json ?? {});
    check('the lifted decision is on the account’s screen',
      checks.status === 200 && body.includes('lifted') && body.includes(REASON_LIFT.slice(0, 40)),
      body.includes('lifted') ? 'the line is there' : `status=${checks.status} ${body.slice(0, 160)}`);

    /* ── 3. one open thread ──────────────────────────────────────────────── */
    console.log('\n3 — support: a filing while a thread is open, and the same words twice');
    const first = await call(API, '/api/support/request', asSelf, {
      method: 'POST', body: { subject: 'Smoke test', message: NOTE_ONE },
    });
    check('the note joins an open thread instead of opening one',
      first.status === 200 && first.json?.intoThread === true,
      JSON.stringify(first.json).slice(0, 200));
    const threadRef = first.json?.ref as string;

    const again = await call(API, '/api/support/request', asSelf, {
      method: 'POST', body: { subject: 'Smoke test', message: `${NOTE_ONE}  ` },
    });
    check('the same words are not filed twice',
      again.status === 200 && again.json?.alreadyOnRecord === true && again.json?.ref === threadRef,
      JSON.stringify(again.json).slice(0, 200));

    const rowsOnThread = await prisma.activityEvent.count({
      where: { userId: target.id, kind: 'support.followup', metadata: { path: ['refCode'], equals: threadRef }, createdAt: { gte: started } },
    });
    const newRequests = await prisma.activityEvent.count({
      where: { userId: target.id, kind: 'support.request', createdAt: { gte: started } },
    });
    check('one follow-up written, no new request row', rowsOnThread === 1 && newRequests === 0,
      `followups=${rowsOnThread} requests=${newRequests}`);

    /* ── 4. closing resolves it, and a filing after that opens a new one ──── */
    console.log('\n4 — closing every open thread, then filing again');
    const closedOne = await call(API, '/api/support/thread/close', asSelf, {
      method: 'POST', body: { ref: threadRef },
    });
    check('the account can close its own thread', closedOne.status === 200, JSON.stringify(closedOne.json).slice(0, 120));

    /* The old door left this account with more than one open thread, and the
       rule is "any open thread takes the message" — so a filing only opens a
       new reference once there is nothing open to join. Closing the leftovers
       through the account’s own door is also the check that they can. */
    const { THREAD_KINDS } = await import('@/features/support/threads');
    const { eventRowRef } = await import('@/features/users/refcode');
    const askedRows = await prisma.activityEvent.findMany({
      where: { userId: target.id, kind: 'support.request' },
      select: { id: true, metadata: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const asked of askedRows) {
      const code = eventRowRef(asked as any);
      const rows = await prisma.activityEvent.findMany({
        where: { kind: { in: THREAD_KINDS }, metadata: { path: ['refCode'], equals: code } },
        orderBy: { createdAt: 'asc' }, select: { kind: true },
      });
      if (!rows.length || rows[rows.length - 1].kind === 'support.closed') continue;
      const shut = await call(API, '/api/support/thread/close', asSelf, { method: 'POST', body: { ref: code } });
      console.log(`       closed the leftover thread ${code} -> ${shut.status}`);
      check(`the leftover thread ${code} closes`, shut.status === 200);
    }

    const fresh = await call(API, '/api/support/request', asSelf, {
      method: 'POST', body: { subject: 'Smoke test after close', message: NOTE_TWO },
    });
    check('with nothing open, a filing opens a new reference',
      fresh.status === 200 && fresh.json?.intoThread === undefined && fresh.json?.ref !== threadRef,
      JSON.stringify(fresh.json).slice(0, 200));

    const { rows: mails, keys } = await awaitMails(started, ['support_request_received', 'support_request_admin']);
    const receivedMails = keys.filter((k) => k === 'support_request_received');
    const staffMails = keys.filter((k) => k === 'support_request_admin');
    /* Three sends, one thread: the repeat and the follow-up are silent, and only
       the filing that came after the close reaches a mailbox — once to the
       account, once to the desk. */
    check('one new thread mailed, the two sends onto the open thread mailed nobody',
      receivedMails.length === 1 && staffMails.length === 1,
      `received=${receivedMails.length} staff=${staffMails.length} of ${mails.length} jobs ` +
        JSON.stringify(keys));

    /* ── 5. put the sanction back the way it was ─────────────────────────── */
    console.log('\n5 — restoring the state the screen was tested in');
    const reApplied = await call(ADMIN, '/api/people/action', asStaff, {
      method: 'POST', body: { id: target.id, action: target.status === 'banned' ? 'ban' : 'suspend', reason: REASON_BACK, days: 1 },
    });
    check('the sanction is re-applied', reApplied.status === 200, JSON.stringify(reApplied.json).slice(0, 160));
    const restored = await prisma.user.findUnique({ where: { id: target.id }, select: { status: true } });
    check(`the account is ${target.status} again`, restored?.status === target.status, `status=${restored?.status}`);
  } finally {
    await Promise.all([
      revokeSession(staff.sessionId).catch(() => {}),
      revokeSession(self.sessionId).catch(() => {}),
    ]);
    console.log('\n(both smoke sessions revoked)');
  }
}

main().finally(() => process.exit(0));
