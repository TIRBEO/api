/**
 * Feedback persistence + staff read-back (features/feedback/feedbackHandlers).
 *
 * The endpoint is public, so these tests are mostly about the bounds: what gets
 * stored, what gets refused, and — the part that used to be a lie — that a POST
 * actually writes a row. Prisma is a small in-memory table of activity_events;
 * the auth guards are stubbed, so no DB, Redis or network.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const state = vi.hoisted(() => ({
  rows: [] as any[],
  session: null as null | { userId: string; email: string },
  role: null as null | string,
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `evt-${state.rows.length + 1}`, createdAt: new Date('2026-01-02T03:04:05.000Z'), ...data };
        state.rows.push(row);
        return row;
      }),
      findMany: vi.fn(async ({ where, skip, take }: any) => {
        let rows = state.rows.filter((r) => (typeof where?.kind === 'string' ? r.kind === where.kind : r.kind.startsWith('feedback.')));
        if (where?.userId) rows = rows.filter((r) => r.userId === where.userId);
        return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? 50));
      }),
      count: vi.fn(async () => state.rows.length),
    },
  },
}));

vi.mock('@/features/auth/http-guards', () => ({
  getSession: vi.fn(async () => state.session),
  requirePermission: vi.fn(async () => {
    if (!state.role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return { userId: 'staff-1', email: 'staff@tirbeo.com', adminRole: state.role };
  }),
}));

vi.mock('@/features/security/security', () => ({
  getClientIp: () => '203.0.113.9',
  getUserAgent: () => 'TestUA/1.0',
}));

vi.mock('@/features/security/audit', () => ({
  humanTitle: (action: string) => action,
}));

import { adminFeedbackHandler, feedbackHandler } from '@/features/feedback/feedbackHandlers';

function post(body: unknown, path = '/api/feedback') {
  return new NextRequest(`https://api.tirbeo.com${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function get(query = '', path = '/api/admin/feedback') {
  return new NextRequest(`https://api.tirbeo.com${path}${query ? `?${query}` : ''}`, { method: 'GET' });
}

/** Response bodies here are the contract under test — read them loosely. */
async function jsonOf(res: Response): Promise<any> {
  return await res.json() as any;
}

beforeEach(() => {
  state.rows.length = 0;
  state.session = null;
  state.role = null;
});

describe('POST /api/feedback', () => {
  it('stores the vote, the comment and where it came from instead of echoing a stub', async () => {
    state.session = { userId: 'u1', email: 'a@b.dev' };
    const res = await feedbackHandler(post({
      kind: 'document', source: 'myprofile', page: '/help/wallet', articleId: 'wallet-setup',
      vote: 'no', comment: 'The steps skip the confirmation screen.',
    }));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(body.message).toBe('Feedback received');
    expect(typeof body.id).toBe('string');

    expect(state.rows).toHaveLength(1);
    const row = state.rows[0];
    expect(row.kind).toBe('feedback.document');
    expect(row.userId).toBe('u1');
    expect(row.title).toMatch(/document feedback no/i);
    expect(row.detail).toBe('The steps skip the confirmation screen.');
    expect(row.metadata).toMatchObject({
      vote: 'no', page: '/help/wallet', articleId: 'wallet-setup', source: 'myprofile', comment: 'The steps skip the confirmation screen.',
    });
  });

  it('accepts an anonymous answer and records that it was anonymous', async () => {
    const res = await feedbackHandler(post({ kind: 'document', articleId: 'wallet-setup', vote: 'yes' }));
    expect(res.status).toBe(200);
    expect(state.rows[0].userId).toBeNull();
    expect(state.rows[0].metadata.anonymous).toBe(true);
    // Still searchable by what it is: the title is a summary, never the key.
    expect(state.rows[0].title).not.toBe(state.rows[0].kind);
  });

  it('normalises a boolean vote and drops one that is not on the list', async () => {
    await feedbackHandler(post({ vote: true, page: '/x' }));
    expect(state.rows[0].metadata.vote).toBe('yes');
    await feedbackHandler(post({ vote: 'spam'.repeat(20), page: '/x', comment: 'other' }));
    expect(state.rows[1].metadata.vote).toBeUndefined();
    expect(state.rows[1].detail).toBe('other');
  });

  it('refuses a body that is not a plain object', async () => {
    for (const body of [['a'], '"just a string"', '42', 'null']) {
      const res = await feedbackHandler(post(body));
      expect(res.status, String(body)).toBe(400);
      expect((await jsonOf(res)).code).toBe('INVALID_FEEDBACK_BODY');
    }
    expect(state.rows).toHaveLength(0);
  });

  it('refuses metadata that is not a plain object, and bounds it when it is', async () => {
    const bad = await feedbackHandler(post({ comment: 'x', metadata: [1, 2, 3] }));
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).code).toBe('INVALID_FEEDBACK_METADATA');

    const big = await feedbackHandler(post({ comment: 'x', metadata: { blob: 'y'.repeat(5000) } }));
    expect(big.status).toBe(413);
    expect((await jsonOf(big)).code).toBe('FEEDBACK_METADATA_TOO_LARGE');
    expect(state.rows).toHaveLength(0);
  });

  it('stores nothing when there is nothing sayable', async () => {
    const res = await feedbackHandler(post({ kind: 'document' }));
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).code).toBe('EMPTY_FEEDBACK');
    expect(state.rows).toHaveLength(0);
  });

  it('never lets the payload name its own user', async () => {
    state.session = { userId: 'real-user', email: 'a@b.dev' };
    await feedbackHandler(post({ vote: 'yes', userId: 'someone-elses-id', email: 'spoof@x.dev' }));
    const row = state.rows[0];
    expect(row.userId).toBe('real-user');
    // The claimed id survives only as what it is — text somebody sent.
    expect(row.metadata.extras).toMatchObject({ userId: 'someone-elses-id', email: 'spoof@x.dev' });
  });

  it('caps an over-long comment instead of storing an unbounded blob', async () => {
    await feedbackHandler(post({ comment: 'q'.repeat(5000), page: '/p' }));
    expect(state.rows[0].detail!.length).toBeLessThanOrEqual(2000);
    expect(state.rows[0].detail!.endsWith('…')).toBe(true);
  });
});

describe('GET /api/admin/feedback', () => {
  it('refuses a caller who is not staff', async () => {
    const res = await adminFeedbackHandler(get());
    expect(res.status).toBe(403);
  });

  it('reads the stored rows back for staff, newest first and paged', async () => {
    state.role = 'manager';
    state.session = { userId: 'u1', email: 'a@b.dev' };
    await feedbackHandler(post({ kind: 'document', articleId: 'a', vote: 'yes' }));
    await feedbackHandler(post({ kind: 'document', articleId: 'b', vote: 'no', comment: 'slow' }));

    const res = await adminFeedbackHandler(get('page=1&limit=1'));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(1);
    expect(body.feedback).toHaveLength(1);
    const row = body.feedback[0];
    expect(row.id).toBeTruthy();
    expect(row.kind).toBe('feedback.document');
    expect(row.vote).toBe('yes');
    expect(row.articleId).toBe('a');
    expect(row.userId).toBe('u1');
    expect(row.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('does not let the limit be used as a memory leak', async () => {
    state.role = 'admin';
    const res = await adminFeedbackHandler(get('limit=100000'));
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).limit).toBe(100);
  });
});

describe('GET /api/feedback', () => {
  it('answers the caller’s own rows and refuses an anonymous caller', async () => {
    const anonymous = await feedbackHandler(get('', '/api/feedback'));
    expect(anonymous.status).toBe(401);

    state.session = { userId: 'u1', email: 'a@b.dev' };
    await feedbackHandler(post({ kind: 'document', articleId: 'a', vote: 'yes' }));
    const res = await feedbackHandler(get('', '/api/feedback'));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.feedback).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});
