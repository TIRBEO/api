/**
 * The support thread, from the account's side of it.
 *
 * Three rules hold this feature up, and all three are quiet in the code — a
 * reader can't tell they matter until they break:
 *
 *  1. A reference is a handle, not a key. `GET /support/thread?ref=…` must only
 *     ever return rows belonging to the signed-in account, and must answer 404
 *     — not 403 — for one that isn't, because "that reference exists but
 *     belongs to somebody else" is itself a leak.
 *  2. Reading is always open to a signed-in account; *writing* after an hour
 *     idle costs an identity proof. A laptop left open in a café should not
 *     answer support on your behalf that evening.
 *  3. Status is derived from the last row, never stored. Close then write again
 *     and the thread is open — no flag to remember to clear.
 *
 * Prisma, the session store and the mail paths are stubbed; no DB, Redis or
 * network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const REF = 'a1b2-c3d4-e5f6-7a8b';

const mocks = vi.hoisted(() => ({
  session: { userId: 'u1', email: 'ada@example.com', sessionId: 's1' } as any,
  getSession: vi.fn(async () => mocks.session),
  /** What the ledger holds for the thread query. Handlers pass `userId`, so an
      absent owner is modelled by the row simply not coming back. */
  threadRows: vi.fn(async (_args: any) => [] as any[]),
  created: vi.fn(async (args: any) => ({ id: `new-${Math.random().toFixed(4)}`, ...args?.data, createdAt: new Date('2026-10-23T09:00:00.000Z') })),
  /** The session row `idleMsFor` reads; null means "unknown", which never asks. */
  sessionRow: vi.fn(async (_args: any) => null as any),
  requireReauth: vi.fn(async () => ({ ok: true, method: 'passkey' } as any)),
  windowLimit: vi.fn(async () => true),
  notifyAdmin: vi.fn(async () => {}),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: { findMany: mocks.threadRows, create: mocks.created },
    userSession: { findUnique: mocks.sessionRow },
  },
}));
vi.mock('@/features/auth/http-guards', () => ({ getSession: mocks.getSession }));
vi.mock('@/features/auth/reauth', () => ({ requireReauth: mocks.requireReauth }));
vi.mock('@/features/captcha/risk', () => ({ checkWindowLimitDB: mocks.windowLimit }));
vi.mock('@/features/notifications/notifications', () => ({
  createNotification: vi.fn(async () => {}),
  primaryEmailForUser: vi.fn(async () => 'ada@example.com'),
}));
vi.mock('@/features/security/security', () => ({ notifyAdminsOfSupportRequest: mocks.notifyAdmin }));
vi.mock('@/features/identity/tirbeo', () => ({
  fetchLoginUserById: vi.fn(async () => ({ id: 'u1', username: 'ada', email: 'ada@example.com', name: 'Ada' })),
  tirbeoEmailFor: (u: string) => `${u}@tirbeo.com`,
}));

import {
  supportThreadGetHandler,
  supportThreadReplyHandler,
  supportThreadCloseHandler,
  threadStatusOf,
  THREAD_KINDS,
  THREAD_REAUTH_IDLE_MS,
} from '@/features/support/threads';

function req(path: string, body?: unknown): NextRequest {
  const url = `http://localhost${path}`;
  return {
    json: async () => body ?? {},
    headers: new Headers(),
    url,
    nextUrl: { searchParams: new URLSearchParams(new URL(url).search) },
  } as unknown as NextRequest;
}

const row = (kind: string, at: string, extra: Record<string, unknown> = {}) => ({
  id: `${kind}-${at}`,
  userId: 'u1',
  kind,
  title: 'Paused account',
  detail: 'I did not do this.',
  metadata: { refCode: REF, message: 'I did not do this.', ...extra },
  createdAt: new Date(at),
});

const QUESTION = row('support.request', '2026-10-22T10:00:00.000Z');
const REPLY = row('support.reply', '2026-10-22T12:00:00.000Z', { message: 'We restored it.' });
const FOLLOWUP = row('support.followup', '2026-10-22T13:00:00.000Z', { message: 'Thank you.' });
const CLOSE = row('support.closed', '2026-10-22T14:00:00.000Z', { by: 'staff' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { userId: 'u1', email: 'ada@example.com', sessionId: 's1' };
  mocks.getSession.mockResolvedValue(mocks.session);
  mocks.threadRows.mockResolvedValue([QUESTION]);
  mocks.created.mockImplementation(async (args: any) => ({
    id: 'new-1', ...args?.data, createdAt: new Date('2026-10-23T09:00:00.000Z'),
  }));
  mocks.sessionRow.mockResolvedValue(null);
  mocks.requireReauth.mockResolvedValue({ ok: true, method: 'passkey' });
  mocks.windowLimit.mockResolvedValue(true);
});

describe('who may see a thread', () => {
  it('asks the ledger for the account’s own rows only', async () => {
    await supportThreadGetHandler(req('/api/support/thread?ref=' + REF));
    const where = mocks.threadRows.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.kind.in).toEqual([...THREAD_KINDS]);
  });

  it('answers 401 when there is no session at all', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await supportThreadGetHandler(req('/api/support/thread?ref=' + REF));
    expect(res.status).toBe(401);
  });

  it('says 404, never 403, for a reference that is not yours', async () => {
    // The lookup is scoped by userId, so another account's thread is simply
    // not found — and the screen must not distinguish the two.
    mocks.threadRows.mockResolvedValue([]);
    const res = await supportThreadGetHandler(req('/api/support/thread?ref=' + REF));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/No thread/);
  });

  it('keeps a reply from writing without any identity proof when the session is fresh', async () => {
    const res = await supportThreadReplyHandler(req('/api/support/thread/reply', { ref: REF, message: 'Still waiting?' }));
    expect(res.status).toBe(200);
    expect(mocks.requireReauth).not.toHaveBeenCalled();
    expect(mocks.created.mock.calls[0][0].data.kind).toBe('support.followup');
    expect(mocks.created.mock.calls[0][0].data.metadata.refCode).toBe(REF);
  });

  it('asks who you are before it lets an hour-old session answer', async () => {
    mocks.sessionRow.mockResolvedValue({
      createdAt: new Date(Date.now() - THREAD_REAUTH_IDLE_MS - 60_000),
      lastUsedAt: new Date(Date.now() - THREAD_REAUTH_IDLE_MS - 60_000),
    });
    const res = await supportThreadReplyHandler(req('/api/support/thread/reply', { ref: REF, message: 'Still waiting?' }));
    expect(mocks.requireReauth).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('writes nothing when the proof is refused', async () => {
    mocks.sessionRow.mockResolvedValue({
      createdAt: new Date(),
      lastUsedAt: new Date(Date.now() - THREAD_REAUTH_IDLE_MS - 1000),
    });
    mocks.requireReauth.mockResolvedValue({ response: NextResponse.json({ error: 'REAUTH_REQUIRED' }, { status: 428 }) });
    const res = await supportThreadReplyHandler(req('/api/support/thread/reply', { ref: REF, message: 'Still waiting?' }));
    expect(res.status).toBe(428);
    expect(mocks.created).not.toHaveBeenCalled();
  });

  it('reads a thread an hour later without asking anything', async () => {
    // The mail link is the reason this page exists. A person opening it after
    // dinner must see the conversation; only writing back is gated.
    mocks.sessionRow.mockResolvedValue({
      createdAt: new Date(Date.now() - 3 * 3600_000),
      lastUsedAt: new Date(Date.now() - 3 * 3600_000),
    });
    mocks.threadRows.mockResolvedValue([QUESTION, REPLY]);
    const res = await supportThreadGetHandler(req('/api/support/thread?ref=' + REF));
    expect(res.status).toBe(200);
    expect(mocks.requireReauth).not.toHaveBeenCalled();
    expect((await res.json()).thread.needsReauth).toBe(true);
  });
});

describe('what the thread says about itself', () => {
  it('lists the messages in the order they happened', async () => {
    mocks.threadRows.mockResolvedValue([QUESTION, REPLY, FOLLOWUP]);
    const body = await (await supportThreadGetHandler(req('/api/support/thread?ref=' + REF))).json();
    expect(body.thread.messages.map((m: any) => m.from)).toEqual(['account', 'staff', 'account']);
    expect(body.thread.status).toBe('open');
    expect(body.thread.waitingOn).toBe('the team');
  });

  it('marks the close as a fact rather than a voice', async () => {
    mocks.threadRows.mockResolvedValue([QUESTION, REPLY, CLOSE]);
    const body = await (await supportThreadGetHandler(req('/api/support/thread?ref=' + REF))).json();
    expect(body.thread.status).toBe('closed');
    expect(body.thread.messages.at(-1).from).toBe('system');
    expect(body.thread.closedAt).toBe(CLOSE.createdAt.toISOString());
  });
});

describe('closing, and reopening', () => {
  it('writes one close row under the same reference', async () => {
    mocks.threadRows.mockResolvedValue([QUESTION, REPLY]);
    const res = await supportThreadCloseHandler(req('/api/support/thread/close', { ref: REF }));
    expect(res.status).toBe(200);
    const data = mocks.created.mock.calls[0][0].data;
    expect(data.kind).toBe('support.closed');
    expect(data.metadata).toMatchObject({ refCode: REF, by: 'account' });
    expect((await res.json()).thread.status).toBe('closed');
  });

  it('does not stack a second close on a closed thread', async () => {
    mocks.threadRows.mockResolvedValue([QUESTION, CLOSE]);
    const res = await supportThreadCloseHandler(req('/api/support/thread/close', { ref: REF }));
    expect((await res.json()).alreadyClosed).toBe(true);
    expect(mocks.created).not.toHaveBeenCalled();
  });

  it('is open again the moment either side writes', () => {
    // The rule the whole model rests on: no stored flag, so nothing to clear.
    const rows = [QUESTION, REPLY, CLOSE, row('support.followup', '2026-10-22T15:00:00.000Z')];
    expect(threadStatusOf(rows as any)).toEqual({ status: 'open', waitingOn: 'the team' });
    expect(threadStatusOf([QUESTION] as any)).toEqual({ status: 'open', waitingOn: 'the team' });
    expect(threadStatusOf([QUESTION, REPLY] as any)).toEqual({ status: 'answered', waitingOn: 'you' });
  });

  it('refuses an empty message and a fourteen-thousand-word one', async () => {
    expect((await supportThreadReplyHandler(req('/api/support/thread/reply', { ref: REF, message: '  ' }))).status).toBe(400);
    expect((await supportThreadReplyHandler(req('/api/support/thread/reply', { ref: REF, message: 'a'.repeat(4001) }))).status).toBe(400);
    expect(mocks.created).not.toHaveBeenCalled();
  });

  /* The one mail rule of a thread: staff hear about it when it starts, and
     never again. A follow-up that mailed the roster turned a three-message
     conversation into three mails about one reference. */
  it('sends staff no mail for a follow-up: the thread is where it is read', async () => {
    mocks.threadRows.mockResolvedValue([QUESTION, REPLY]);
    const res = await supportThreadReplyHandler(req('/api/support/thread/reply', { ref: REF, message: 'thanks' }));
    expect(res.status).toBe(200);
    expect(mocks.created).toHaveBeenCalled();
    expect(mocks.created.mock.calls[0][0].data.kind).toBe('support.followup');
    expect(mocks.notifyAdmin).not.toHaveBeenCalled();
  });
});
