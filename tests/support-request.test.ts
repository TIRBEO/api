/**
 * A support request is one incident with one handle.
 *
 * There is deliberately no ticket table: the request is an event-ledger row,
 * because that is the only store the admin console, the account's own history
 * and the reference-code search all already read. What the handler has to get
 * right is that the code quoted back to the account, the code in the
 * confirmation mail, and the code on the admin alert are the SAME code — three
 * copies of one handle, or nothing joins the thread later.
 *
 * Prisma, the session, the mailer, notifications, the limiter and the admin
 * alert are stubbed; the ref helpers are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { userId: 'u1', email: 'ada@example.com', sessionId: 's1' } as any,
  getSession: vi.fn(async () => mocks.session),
  activityCreate: vi.fn(async (args: any) => ({
    id: '3e22a407-a8f9-4476-b83a-bf438da758f0',
    createdAt: new Date('2026-10-22T08:55:15.120Z'),
    ...args?.data,
  })),
  // The open-thread lookup. Empty by default: an account with nothing waiting
  // is the case every existing test below is already about.
  activityFindMany: vi.fn(async (_args: any) => [] as any[]),
  checkWindowLimitDB: vi.fn(async (..._args: unknown[]) => true),
  sendTemplateEmailAfter: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  createNotification: vi.fn(async (_args: any) => {}),
  primaryEmailForUser: vi.fn(async () => 'ada@example.com'),
  describeDevice: vi.fn((ua?: string | null) => (ua ? `device<${ua}>` : 'an unrecognized device')),
  // The account as the identity registry knows it: the address it signs in with
  // and the name a person reads.
  fetchLoginUserById: vi.fn(async (_userId?: string) => ({
    email: 'ada@gmail.com', username: 'ada', name: 'Ada L',
  }) as any),
  tirbeoEmailFor: vi.fn((username: string) => `${username}@tirbeo.com`),
  resolveLoginPlace: vi.fn((_headers?: Headers) => 'Kathmandu, Nepal' as string | null),
  notifyAdminsOfSupportRequest: vi.fn(async (_args: any) => {}),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: { activityEvent: { create: mocks.activityCreate, findMany: mocks.activityFindMany } },
}));
vi.mock('@/features/auth/http-guards', () => ({ getSession: mocks.getSession }));
vi.mock('@/features/captcha/risk', () => ({ checkWindowLimitDB: mocks.checkWindowLimitDB }));
vi.mock('@/features/email/email', () => ({ sendTemplateEmailAfter: mocks.sendTemplateEmailAfter }));
vi.mock('@/features/notifications/notifications', () => ({
  createNotification: mocks.createNotification,
  primaryEmailForUser: mocks.primaryEmailForUser,
  describeDevice: mocks.describeDevice,
}));
vi.mock('@/features/identity/tirbeo', () => ({
  fetchLoginUserById: mocks.fetchLoginUserById,
  tirbeoEmailFor: mocks.tirbeoEmailFor,
}));
vi.mock('@/shared/geo', () => ({ resolveLoginPlace: mocks.resolveLoginPlace }));
vi.mock('@/features/security/security', () => ({
  notifyAdminsOfSupportRequest: mocks.notifyAdminsOfSupportRequest,
}));

import { supportRequestHandler } from '@/features/support/requests';

const LONG = 'I cannot sign in from my laptop since this morning and the recovery link never arrives.';

/* The reply goes out the moment the row exists; the in-app copy, the
   confirmation mail and the staff copy travel after it. A test that reads
   those three has to let the delivery chain land first — waiting on the last
   hop waits on all of them. */
async function delivered() {
  await vi.waitFor(() => {
    expect(mocks.notifyAdminsOfSupportRequest).toHaveBeenCalled();
  }, { timeout: 2000 });
}

async function file(body: unknown) {
  const res = await supportRequestHandler(req(body));
  await delivered();
  return res;
}

function req(body: unknown) {
  return new Request('http://localhost/api/support/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla Chrome' },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { userId: 'u1', email: 'ada@example.com', sessionId: 's1' };
  mocks.activityCreate.mockImplementation(async (args: any) => ({
    id: '3e22a407-a8f9-4476-b83a-bf438da758f0',
    createdAt: new Date('2026-10-22T08:55:15.120Z'),
    ...args?.data,
  }));
  mocks.checkWindowLimitDB.mockResolvedValue(true as any);
  mocks.activityFindMany.mockResolvedValue([] as any);
  mocks.primaryEmailForUser.mockResolvedValue('ada@example.com' as any);
  mocks.fetchLoginUserById.mockResolvedValue({ email: 'ada@gmail.com', username: 'ada', name: 'Ada L' } as any);
  mocks.resolveLoginPlace.mockReturnValue('Kathmandu, Nepal' as any);
});

describe('the request', () => {
  it('files a ledger row and answers with its code', async () => {
    const res = await file({ subject: 'Cannot sign in', message: LONG });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'support.request', title: 'Cannot sign in', userId: 'u1' }),
    }));
    // Derived from the row's own id: the write stamped nothing extra.
    expect(body.ref).toBe('3e22-a407-a8f9-4476');
    expect(body.subject).toBe('Cannot sign in');
  });

  it('quotes the code the row itself carries, not a second one', async () => {
    mocks.activityCreate.mockImplementation(async (args: any) => ({
      id: 'r1',
      createdAt: new Date('2026-10-22T08:55:15.120Z'),
      ...args?.data,
      metadata: { ...args?.data?.metadata, refCode: 'a1b2-c3d4-e5f6-7a8b' },
    }));
    await file({ message: LONG });
    const vars = mocks.sendTemplateEmailAfter.mock.calls[0][2] as Record<string, string>;
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(vars.refCode).toBe('a1b2-c3d4-e5f6-7a8b');
    expect(staff.refCode).toBe(vars.refCode);
  });

  it('sends the account a confirmation that names the code and the subject', async () => {
    await file({ subject: 'Billing', message: LONG });
    expect(mocks.sendTemplateEmailAfter).toHaveBeenCalledTimes(1);
    const [to, template, vars] = mocks.sendTemplateEmailAfter.mock.calls[0] as unknown as [string, string, Record<string, string>];
    expect(to).toBe('ada@example.com');
    expect(template).toBe('support_request_received');
    expect(vars).toMatchObject({ ticketSubject: 'Billing', message: LONG });
  });

  it('keeps the in-app copy and the staff copy under the same handle', async () => {
    const res = await file({ subject: 'Cannot sign in', message: LONG });
    const body = await res.json();
    const note = mocks.createNotification.mock.calls[0][0] as any;
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(note.metadata.ref).toBe(body.ref);
    expect(staff.refCode).toBe(body.ref);
    expect(staff.subject).toBe('Cannot sign in');
    expect(staff.message).toBe(LONG);
  });

  /* The reader on the other end has to answer without leaving the inbox, and an
     answer has to reach a mailbox — which for most accounts is not the address
     they sign in with. */
  it('hands staff the mailbox to answer into and the identity it came from', async () => {
    await file({ subject: 'Cannot sign in', message: LONG });
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(staff.replyTo).toBe('ada@example.com');
    expect(staff.identity).toBe('ada@tirbeo.com');
    expect(staff.senderName).toBe('Ada L');
  });

  it('greets staff by the name on the account, not the address prefix', async () => {
    mocks.fetchLoginUserById.mockResolvedValueOnce({ email: 'ada@gmail.com', username: 'ada', name: null } as any);
    await file({ message: LONG });
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(staff.senderName).toBe('ada');
  });

  /* An admin reading `someone@gmail.com` learns nothing about the account; the
     handle is the name it goes by here, and the two are not the same row. */
  it('names the account by its handle, and the answer by its mailbox', async () => {
    await file({ message: LONG });
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(staff.identity).toBe('ada@tirbeo.com');
    expect(staff.replyTo).toBe('ada@example.com');
  });

  it('carries what the request arrived on, so a suspicious one can be read', async () => {
    await file({ message: LONG });
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(staff.device).toBe('device<Mozilla Chrome>');
    expect(staff.location).toBe('Kathmandu, Nepal');
    expect(staff.ip).toBe('203.0.113.9');
    expect(staff.receivedAt).toBeInstanceOf(Date);
  });

  it('will not let a pasted newline turn the subject into a second header', async () => {
    await file({ subject: 'Help\r\nBcc: everyone@example.com', message: LONG });
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(staff.subject).toBe('Help Bcc: everyone@example.com');
    expect(staff.subject).not.toMatch(/[\r\n]/);
  });

  it('defaults the subject when the message arrives without one', async () => {
    await file({ message: LONG });
    const vars = mocks.sendTemplateEmailAfter.mock.calls[0][2] as Record<string, string>;
    expect(vars.ticketSubject).toBe('A question about my account');
  });

  it('still files when the account has no reachable address', async () => {
    mocks.primaryEmailForUser.mockResolvedValue(null as any);
    mocks.fetchLoginUserById.mockResolvedValueOnce(null as any);
    const res = await file({ message: LONG });
    expect(res.status).toBe(200);
    expect(mocks.sendTemplateEmailAfter).not.toHaveBeenCalled();
    expect(mocks.notifyAdminsOfSupportRequest).toHaveBeenCalledTimes(1);
    const staff = mocks.notifyAdminsOfSupportRequest.mock.calls[0][0] as any;
    expect(staff.replyTo).toBe('');
    expect(staff.senderName).toBe('An account');
  });
});

describe('what it refuses', () => {
  it('needs a session — an anonymous message has no thread to reply into', async () => {
    mocks.getSession.mockResolvedValueOnce(null as any);
    const res = await supportRequestHandler(req({ message: LONG }));
    expect(res.status).toBe(401);
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it('refuses a message too short to answer', async () => {
    const res = await supportRequestHandler(req({ message: 'help' }));
    expect(res.status).toBe(400);
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  it('refuses an essay nobody will read', async () => {
    const res = await supportRequestHandler(req({ message: 'x'.repeat(4001) }));
    expect(res.status).toBe(400);
  });

  it('holds the door when the account is already filing in bulk', async () => {
    mocks.checkWindowLimitDB.mockResolvedValueOnce(false as any);
    const res = await supportRequestHandler(req({ message: LONG }));
    expect(res.status).toBe(429);
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });
});

/* ═══ one open thread per account ═════════════════════════════════════════
   The bug these tests are written against: every press of Send minted a new
   reference and a new mail to the same reader, so an unanswered question could
   be asked an unlimited number of times — and an account that filed twelve got
   twelve tickets that each needed closing. A filing now lands on the thread
   that is already open, and the words that are already on it land nowhere. */
describe('a filing while a thread is open', () => {
  const OPEN_REF = 'a1b2-c3d4-e5f6-7a8b';

  /** One ledger row as the thread lookup reads it. `metadata` stays open on
      purpose: a `support.closed` row carries no message, and every other kind
      does. */
  type LedgerRow = {
    id: string;
    userId: string;
    kind: string;
    title: string;
    detail: string;
    metadata: Record<string, any>;
    createdAt: Date;
  };
  function ledgerRow(kind: string, message: string, at: string): LedgerRow {
    return {
      id: `row-${at}`,
      userId: 'u1',
      kind,
      title: 'Cannot sign in',
      detail: message.slice(0, 500),
      metadata: { refCode: OPEN_REF, message, subject: 'Cannot sign in' },
      createdAt: new Date(at),
    };
  }
  const openWith = (...rows: LedgerRow[]) => {
    mocks.activityFindMany.mockResolvedValue(rows as any);
    return rows;
  };

  it('writes onto the open thread instead of opening a second one', async () => {
    openWith(ledgerRow('support.request', 'The account locked itself this morning.', '2026-10-22T08:00:00.000Z'));
    const res = await supportRequestHandler(req({ subject: 'Still locked', message: LONG }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.intoThread).toBe(true);
    expect(body.ref).toBe(OPEN_REF);
    const data = mocks.activityCreate.mock.calls[0][0].data;
    expect(data.kind).toBe('support.followup');
    expect(data.metadata.refCode).toBe(OPEN_REF);
    expect(data.metadata.inReplyTo).toBe('row-2026-10-22T08:00:00.000Z');
    expect(data.title).toBe('Cannot sign in');
  });

  /* The whole point of the thread: the reader gets one mail about one problem,
     however many messages the account sends into it. */
  it('mails nobody — not the account, not staff', async () => {
    openWith(ledgerRow('support.request', 'The account locked itself this morning.', '2026-10-22T08:00:00.000Z'));
    await supportRequestHandler(req({ message: LONG }));
    expect(mocks.sendTemplateEmailAfter).not.toHaveBeenCalled();
    expect(mocks.notifyAdminsOfSupportRequest).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('does not spend the filing budget it would have taken to start a thread', async () => {
    openWith(ledgerRow('support.request', 'The account locked itself this morning.', '2026-10-22T08:00:00.000Z'));
    await supportRequestHandler(req({ message: LONG }));
    const keys = mocks.checkWindowLimitDB.mock.calls.map((call) => call[0]);
    expect(keys).toEqual(['support:followup:u1']);
  });

  it('stops a flood of follow-ups on its own budget', async () => {
    openWith(ledgerRow('support.request', 'The account locked itself this morning.', '2026-10-22T08:00:00.000Z'));
    mocks.checkWindowLimitDB.mockResolvedValueOnce(false as any);
    const res = await supportRequestHandler(req({ message: LONG }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain(OPEN_REF);
    expect(mocks.activityCreate).not.toHaveBeenCalled();
  });

  /* The literal complaint: the same note, sent again and again. Nothing is
     written and no counter moves, because the record already holds those words
     and the person is waiting on an answer, not on a second copy. */
  it('will not file the same words twice', async () => {
    openWith(ledgerRow('support.request', LONG, '2026-10-22T08:00:00.000Z'));
    const res = await supportRequestHandler(req({ message: `${LONG}  ` }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyOnRecord).toBe(true);
    expect(body.ref).toBe(OPEN_REF);
    expect(mocks.activityCreate).not.toHaveBeenCalled();
    expect(mocks.checkWindowLimitDB).not.toHaveBeenCalled();
  });

  it('still takes a note that repeats the first one, when staff answered between them', async () => {
    openWith(
      ledgerRow('support.request', 'The account locked itself this morning.', '2026-10-22T08:00:00.000Z'),
      { ...ledgerRow('support.reply', 'Please try the recovery link again.', '2026-10-22T09:00:00.000Z'), title: 'Re: Cannot sign in' },
    );
    const res = await supportRequestHandler(req({ message: 'The account locked itself this morning.' }));
    const data = mocks.activityCreate.mock.calls[0][0].data;
    // The thread is waiting on the account, so the same words mean "still broken".
    expect(data.kind).toBe('support.followup');
    expect((await res.json()).intoThread).toBe(true);
  });

  it('opens a fresh request once the thread is closed', async () => {
    openWith(
      ledgerRow('support.request', 'The account locked itself this morning.', '2026-10-22T08:00:00.000Z'),
      ledgerRow('support.followup', 'The account locked itself this morning.', '2026-10-22T09:00:00.000Z'),
      { ...ledgerRow('support.closed', 'Closed by the account.', '2026-10-22T10:00:00.000Z'), metadata: { refCode: OPEN_REF } },
    );
    const res = await supportRequestHandler(req({ subject: 'Cannot sign in', message: LONG }));
    await delivered();
    expect(mocks.activityCreate.mock.calls[0][0].data.kind).toBe('support.request');
    expect(mocks.notifyAdminsOfSupportRequest).toHaveBeenCalledTimes(1);
    expect((await res.json()).intoThread).toBeUndefined();
  });

  it('answers on the newest open thread when there are two', async () => {
    const older = ledgerRow('support.request', 'First thing.', '2026-10-20T08:00:00.000Z');
    const newer = { ...ledgerRow('support.request', 'Second thing.', '2026-10-22T08:00:00.000Z'), metadata: { refCode: 'ffff-cccc-eeee-dddd', message: 'Second thing.' } };
    openWith(older, newer);
    const res = await supportRequestHandler(req({ message: LONG }));
    expect((await res.json()).ref).toBe('ffff-cccc-eeee-dddd');
  });

  /* This is the door a locked-out account knocks on. A read that fails is not a
     reason to refuse somebody their message — the limiter is the backstop, not
     the thread lookup. */
  it('files the message when the thread cannot be read', async () => {
    mocks.activityFindMany.mockRejectedValueOnce(new Error('db down') as any);
    const res = await supportRequestHandler(req({ message: LONG }));
    await delivered();
    expect(res.status).toBe(200);
    expect(mocks.activityCreate.mock.calls[0][0].data.kind).toBe('support.request');
  });

  it('rejects a short note before reading anything', async () => {
    const res = await supportRequestHandler(req({ message: 'help' }));
    expect(res.status).toBe(400);
    expect(mocks.activityFindMany).not.toHaveBeenCalled();
  });
});
