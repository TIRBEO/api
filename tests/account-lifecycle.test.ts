/**
 * Account lifecycle recovery + welcome back.
 *
 * Two halves of the account-lifecycle status feature, driven as pure unit
 * tests over an in-memory stand-in for the tables the lifecycle writes touch
 * (`otps`, `users`, `user_deletion_requests`, `user_deactivations`,
 * `user_status_events`, `user_preferences`):
 *
 *   1. The email-code restoration door. `requestReactivationByEmail` used to
 *      accept only a `deactivated` account; an account sitting in
 *      `deletion_pending` had no way back once its session died — the screen
 *      told them "not deactivated" and the sign-in itself was refused. It now
 *      accepts both, spending the code either cancels the scheduled deletion
 *      (`restoredAs:'deletion_cancelled'`) or lifts the pause
 *      (`restoredAs:'reactivated'`).
 *   2. `getWelcomeBack` — the one-shot card computed from the status-event
 *      ledger after a restoration, suppressed once acknowledged into
 *      `preferences.misc.welcomeBackSeenAt`.
 *
 * The OTP core (issue/consume, hashing shape, attempt counter, cooldown gate)
 * is real; only the mail transport, Redis and the database are stubbed —
 * same fixture style as tests/reauth-code.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  otpRows: [] as any[],
  /** id -> { status } rows of `users`. */
  users: new Map<string, any>(),
  /** lowercased address -> userId (`user_email`). */
  emails: new Map<string, string>(),
  /** userId -> deletion request row. */
  deletionRequests: new Map<string, any>(),
  /** userId -> deactivation row. */
  deactivations: new Map<string, any>(),
  /** `user_status_events` rows, oldest first. */
  statusEvents: [] as any[],
  activityEvents: [] as any[],
  /** `user_preferences` rows. */
  prefs: new Map<string, any>(),
  gate: { allowed: true, remainingMs: 0 } as { allowed: boolean; remainingMs: number },
  nextCode: '424242',
  getSession: vi.fn(async () => ({ userId: 'u1', email: 'e@u.dev' } as any)),
}));

vi.mock('@/features/auth/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('@/features/auth/resend-cooldown', () => ({
  enforceResendCooldown: vi.fn(async () => mocks.gate),
}));
vi.mock('@/features/auth/otp', () => ({
  generateOtpCode: vi.fn(() => mocks.nextCode),
}));
// Keep the SHAPE: the stored hash is a function of `code|bind`, so a code
// minted for one context can't be spent on another.
vi.mock('@/features/auth/password', () => ({
  hashOtpCode: vi.fn((plain: string) => `hash:${plain}`),
  verifyOtpCode: vi.fn(async (hash: string, plain: string) => hash === `hash:${plain}`),
}));
vi.mock('@/features/auth/http-guards', () => ({
  getSession: mocks.getSession,
  requireSession: mocks.getSession,
}));

/** Match a row against a where clause supporting the few operators these
    paths actually use ({ in }, { lt }, { gte }). */
const matches = (row: any, where: any) =>
  Object.entries(where || {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('lt' in v) return row[k] < v.lt;
      if ('lte' in v) return row[k] <= v.lte;
      if ('gt' in v) return row[k] > v.gt;
      if ('gte' in v) return row[k] >= v.gte;
      if ('equals' in v) return row[k] === v.equals;
    }
    return row[k] === v;
  });

const sorted = (rows: any[], orderBy: any) =>
  rows.slice().sort((a, b) =>
    (orderBy?.createdAt === 'desc' ? -1 : 1) * (a.createdAt.getTime() - b.createdAt.getTime()));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    otp: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `otp-${mocks.otpRows.length + 1}`, attempts: 0, createdAt: new Date(), ...data };
        mocks.otpRows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where, orderBy }: any) => sorted(mocks.otpRows.filter((r) => matches(r, where)), orderBy)[0] ?? null),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = mocks.otpRows.length;
        mocks.otpRows = mocks.otpRows.filter((r) => !matches(r, where));
        return { count: before - mocks.otpRows.length };
      }),
      delete: vi.fn(async ({ where }: any) => {
        mocks.otpRows = mocks.otpRows.filter((r) => !matches(r, where));
        return { id: where?.id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = mocks.otpRows.find((r) => r.id === where?.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: any) => mocks.users.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = mocks.users.get(where.id);
        if (!row) throw new Error('no such user');
        Object.assign(row, data);
        return row;
      }),
    },
    userEmail: {
      findFirst: vi.fn(async ({ where }: any) => {
        const id = mocks.emails.get(where.address);
        return id ? { userId: id } : null;
      }),
    },
    userDeletionRequest: {
      findUnique: vi.fn(async ({ where }: any) => mocks.deletionRequests.get(where.userId) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = mocks.deletionRequests.get(where.userId);
        if (row) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const next = mocks.deletionRequests.has(where.userId)
          ? Object.assign(mocks.deletionRequests.get(where.userId), update)
          : { ...create };
        mocks.deletionRequests.set(where.userId, next);
        return next;
      }),
    },
    userDeactivation: {
      findUnique: vi.fn(async ({ where }: any) => mocks.deactivations.get(where.userId) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = mocks.deactivations.get(where.userId);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    userStatusEvent: {
      findFirst: vi.fn(async ({ where, orderBy }: any) =>
        sorted(mocks.statusEvents.filter((r) => matches(r, where)), orderBy)[0] ?? null),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `ev-${mocks.statusEvents.length + 1}`, createdAt: new Date(), metadata: {}, ...data };
        mocks.statusEvents.push(row);
        return row;
      }),
    },
    activityEvent: {
      create: vi.fn(async ({ data }: any) => {
        mocks.activityEvents.push(data);
        return data;
      }),
    },
    userPreferences: {
      findUnique: vi.fn(async ({ where }: any) => mocks.prefs.get(where.userId) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const next = mocks.prefs.has(where.userId)
          ? { ...mocks.prefs.get(where.userId), ...update }
          : { ...create };
        mocks.prefs.set(where.userId, next);
        return next;
      }),
    },
  },
}));

import {
  requestReactivationByEmail, reactivateByEmailCode,
  REACTIVATE_OTP_KIND,
} from '@/features/status/accountLifecycle';
import { getWelcomeBack, welcomeBackHandler, welcomeBackAckHandler } from '@/features/status/welcomeBack';

// ─── Fixtures ───────────────────────────────────────────────────────

const D = (iso: string) => new Date(iso);

function reset() {
  mocks.otpRows = [];
  mocks.users = new Map();
  mocks.emails = new Map();
  mocks.deletionRequests = new Map();
  mocks.deactivations = new Map();
  mocks.statusEvents = [];
  mocks.activityEvents = [];
  mocks.prefs = new Map();
  mocks.gate = { allowed: true, remainingMs: 0 };
  mocks.nextCode = '424242';
  mocks.getSession.mockImplementation(async () => ({ userId: 'u1', email: 'e@u.dev' }));
}
beforeEach(reset);

/** An account that signs in with `email`, sitting in `status`. */
function account(userId: string, email: string, status: string) {
  mocks.users.set(userId, { id: userId, status });
  mocks.emails.set(email.toLowerCase(), userId);
  return userId;
}

function deletionPendingAccount(userId = 'u1', email = 'alice@gmail.com') {
  account(userId, email, 'deletion_pending');
  mocks.deletionRequests.set(userId, {
    userId, reason: 'too expensive', finalAt: D('2026-11-01T00:00:00Z'), cancelledAt: null, executedAt: null,
  });
}

function deactivatedAccount(userId = 'u1', email = 'alice@gmail.com') {
  account(userId, email, 'deactivated');
  mocks.deactivations.set(userId, { userId, reason: 'taking a break', pausedAt: D('2026-10-01T00:00:00Z'), resumedAt: null });
}

function req(path: string, method = 'POST', body?: unknown) {
  return new NextRequest(`https://api.tirbeo.com${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
}

// ─── The restoration door accepts both recoverable states ───────────

describe('requestReactivationByEmail — deactivated AND deletion_pending', () => {
  it('issues a code for a deactivated account (unchanged behaviour)', async () => {
    deactivatedAccount();
    const issued = await requestReactivationByEmail('alice@gmail.com');
    expect(issued.ok).toBe(true);
    const row = mocks.otpRows[0];
    expect(row.kind).toBe(REACTIVATE_OTP_KIND);
    // Bound to the address, exactly as before.
    expect(row.otpHash).toBe('hash:424242|alice@gmail.com');
  });

  it('issues the same code door for a scheduled deletion', async () => {
    deletionPendingAccount();
    const issued = await requestReactivationByEmail('alice@gmail.com');
    expect(issued.ok).toBe(true);
    expect(mocks.otpRows[0].kind).toBe(REACTIVATE_OTP_KIND);
  });

  it('refuses an account in neither recoverable state with not_restorable', async () => {
    account('u1', 'alice@gmail.com', 'active');
    const issued = await requestReactivationByEmail('alice@gmail.com');
    expect(issued).toEqual({ ok: false, reason: 'not_restorable' });
    expect(mocks.otpRows).toHaveLength(0);
  });

  it('refuses a banned account — restoration is not an appeal door', async () => {
    account('u1', 'alice@gmail.com', 'banned');
    expect(await requestReactivationByEmail('alice@gmail.com')).toEqual({ ok: false, reason: 'not_restorable' });
  });

  it('unknown address: no_account, and nothing minted', async () => {
    expect(await requestReactivationByEmail('nobody@gmail.com')).toEqual({ ok: false, reason: 'no_account' });
    expect(mocks.otpRows).toHaveLength(0);
  });

  it('resend cooldown still gates the second request', async () => {
    deactivatedAccount();
    expect((await requestReactivationByEmail('alice@gmail.com')).ok).toBe(true);
    mocks.gate = { allowed: false, remainingMs: 30_000 };
    expect(await requestReactivationByEmail('alice@gmail.com')).toEqual({ ok: false, reason: 'cooldown' });
  });
});

describe('reactivateByEmailCode — restores as the right kind of thing', () => {
  it('a deletion_pending account CANCELS the deletion and comes back active', async () => {
    deletionPendingAccount();
    await requestReactivationByEmail('alice@gmail.com');

    const done = await reactivateByEmailCode('alice@gmail.com', '424242');
    expect(done).toEqual({ ok: true, restoredAs: 'deletion_cancelled' });

    expect(mocks.users.get('u1')!.status).toBe('active');
    expect(mocks.deletionRequests.get('u1')!.cancelledAt).toBeInstanceOf(Date);
    // The ledger recorded the reinstatement the welcome-back card reads.
    const ev = mocks.statusEvents.find((e) => e.toStatus === 'active');
    expect(ev).toMatchObject({ fromStatus: 'deletion_pending', reason: 'user_cancelled_deletion', actor: 'user' });
    expect(mocks.otpRows).toHaveLength(0); // spent, not marked used
  });

  it('a deactivated account REACTIVATES and stamps resumedAt', async () => {
    deactivatedAccount();
    await requestReactivationByEmail('alice@gmail.com');

    const done = await reactivateByEmailCode('alice@gmail.com', '424242');
    expect(done).toEqual({ ok: true, restoredAs: 'reactivated' });

    expect(mocks.users.get('u1')!.status).toBe('active');
    expect(mocks.deactivations.get('u1')!.resumedAt).toBeInstanceOf(Date);
  });

  it('a wrong code restores nothing and costs an attempt', async () => {
    deletionPendingAccount();
    await requestReactivationByEmail('alice@gmail.com');

    const done = await reactivateByEmailCode('alice@gmail.com', '111111');
    expect(done).toEqual({ ok: false, reason: 'invalid_code' });
    expect(mocks.users.get('u1')!.status).toBe('deletion_pending');
    expect(mocks.deletionRequests.get('u1')!.cancelledAt).toBe(null);
  });

  it('an already-restored account refuses with not_restorable', async () => {
    deletionPendingAccount();
    await requestReactivationByEmail('alice@gmail.com');
    expect((await reactivateByEmailCode('alice@gmail.com', '424242')).ok).toBe(true);

    const again = await reactivateByEmailCode('alice@gmail.com', '424242');
    expect(again).toEqual({ ok: false, reason: 'not_restorable' });
  });

  it('a spent (expired) code cannot cancel the deletion', async () => {
    deletionPendingAccount();
    await requestReactivationByEmail('alice@gmail.com');
    mocks.otpRows[0].expiresAt = new Date(Date.now() - 1000);

    expect(await reactivateByEmailCode('alice@gmail.com', '424242')).toEqual({ ok: false, reason: 'invalid_code' });
    expect(mocks.users.get('u1')!.status).toBe('deletion_pending');
  });
});

// ─── Welcome back, computed from the status ledger ──────────────────

function seedSuspendedThenAdminRestored() {
  account('u1', 'alice@gmail.com', 'active');
  mocks.statusEvents.push(
    { userId: 'u1', fromStatus: 'active', toStatus: 'suspended', reason: 'spam reports', actor: 'admin', metadata: {}, createdAt: D('2026-09-20T00:00:00Z') },
    { userId: 'u1', fromStatus: 'suspended', toStatus: 'active', reason: 'appeal upheld', actor: 'admin', metadata: {}, createdAt: D('2026-09-29T06:00:00Z') },
  );
}

describe('getWelcomeBack — the reinstatement card', () => {
  it('computes pausedAt / restoredAt / daysOff / actor / reason from the events', async () => {
    seedSuspendedThenAdminRestored();
    const info = await getWelcomeBack('u1');
    expect(info).toEqual({
      from: 'suspended',
      pausedAt: '2026-09-20T00:00:00.000Z',
      restoredAt: '2026-09-29T06:00:00.000Z',
      // 222 hours off → 10 whole days rounded up.
      daysOff: 10,
      actor: 'admin',
      reason: 'appeal upheld',
    });
  });

  it('a self-service deletion cancel reads as the person doing it themselves', async () => {
    account('u1', 'alice@gmail.com', 'active');
    mocks.statusEvents.push(
      { userId: 'u1', fromStatus: 'active', toStatus: 'deletion_pending', reason: 'user_requested', actor: 'user', metadata: {}, createdAt: D('2026-10-01T00:00:00Z') },
      { userId: 'u1', fromStatus: 'deletion_pending', toStatus: 'active', reason: 'user_cancelled_deletion', actor: 'user', metadata: {}, createdAt: D('2026-10-02T00:00:00Z') },
    );
    const info = await getWelcomeBack('u1');
    expect(info).toMatchObject({ from: 'deletion_pending', daysOff: 1, actor: 'user', reason: 'user_cancelled_deletion' });
  });

  it('null for an account that was never blocked-and-restored', async () => {
    account('u1', 'alice@gmail.com', 'active');
    mocks.statusEvents.push(
      { userId: 'u1', fromStatus: 'active', toStatus: 'deactivated', reason: 'user_deactivated', actor: 'user', metadata: {}, createdAt: D('2026-09-01T00:00:00Z') },
      // A restore whose fromStatus is not a blocked state (a no-op row).
      { userId: 'u1', fromStatus: 'active', toStatus: 'active', reason: 'noise', actor: 'system', metadata: {}, createdAt: D('2026-09-02T00:00:00Z') },
    );
    expect(await getWelcomeBack('u1')).toBe(null);
  });

  it('null once acknowledged after the restoration', async () => {
    seedSuspendedThenAdminRestored();
    mocks.prefs.set('u1', { userId: 'u1', misc: { welcomeBackSeenAt: '2026-09-30T00:00:00.000Z' } });
    expect(await getWelcomeBack('u1')).toBe(null);
  });

  it('an ack from BEFORE the restoration does not swallow the new card', async () => {
    seedSuspendedThenAdminRestored();
    mocks.prefs.set('u1', { userId: 'u1', misc: { welcomeBackSeenAt: '2026-09-21T00:00:00.000Z' } });
    expect(await getWelcomeBack('u1')).not.toBe(null);
  });

  it('the most recent restoration wins when the account has been blocked twice', async () => {
    account('u1', 'alice@gmail.com', 'active');
    mocks.statusEvents.push(
      { userId: 'u1', fromStatus: 'active', toStatus: 'banned', reason: 'x', actor: 'admin', metadata: {}, createdAt: D('2026-08-01T00:00:00Z') },
      { userId: 'u1', fromStatus: 'banned', toStatus: 'active', reason: 'first lift', actor: 'admin', metadata: {}, createdAt: D('2026-08-10T00:00:00Z') },
      { userId: 'u1', fromStatus: 'active', toStatus: 'banned', reason: 'again', actor: 'admin', metadata: {}, createdAt: D('2026-09-01T00:00:00Z') },
      { userId: 'u1', fromStatus: 'banned', toStatus: 'active', reason: 'second lift', actor: 'admin', metadata: {}, createdAt: D('2026-09-05T00:00:00Z') },
    );
    expect((await getWelcomeBack('u1'))!.reason).toBe('second lift');
  });

  it('falls back to metadata.pausedAt, then to the restore instant, when the entry event is missing', async () => {
    account('u1', 'alice@gmail.com', 'active');
    mocks.statusEvents.push(
      { userId: 'u1', fromStatus: 'deactivated', toStatus: 'active', reason: 'user_reactivated', actor: 'user', metadata: { pausedAt: '2026-09-25T00:00:00Z' }, createdAt: D('2026-09-28T00:00:00Z') },
    );
    const info = await getWelcomeBack('u1');
    expect(info).toMatchObject({ pausedAt: '2026-09-25T00:00:00.000Z', daysOff: 3 });
  });
});

describe('GET /api/users/welcome-back and POST .../ack', () => {
  it('answers { welcomeBack: null } for an account with nothing to show', async () => {
    account('u1', 'alice@gmail.com', 'active');
    const res = await welcomeBackHandler(req('/api/users/welcome-back', 'GET'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ welcomeBack: null });
  });

  it('surfaces the card, and the ack stamps misc.welcomeBackSeenAt so it never returns', async () => {
    seedSuspendedThenAdminRestored();
    const before = await welcomeBackHandler(req('/api/users/welcome-back', 'GET'));
    expect(((await before.json()) as any).welcomeBack).not.toBe(null);

    const ack = await welcomeBackAckHandler(req('/api/users/welcome-back/ack', 'POST'));
    expect(ack.status).toBe(200);

    const after = await welcomeBackHandler(req('/api/users/welcome-back', 'GET'));
    expect(await after.json()).toEqual({ welcomeBack: null });
  });

  it('the ack merge-writes the misc bag without disturbing its neighbours', async () => {
    mocks.prefs.set('u1', { userId: 'u1', misc: { settings: { 'tirbeo:language': 'ne' }, oauth: { google: 'g-1' } } });
    const res = await welcomeBackAckHandler(req('/api/users/welcome-back/ack', 'POST'));
    expect(res.status).toBe(200);

    const misc = mocks.prefs.get('u1').misc;
    expect(typeof misc.welcomeBackSeenAt).toBe('string');
    expect(misc.settings['tirbeo:language']).toBe('ne');
    expect(misc.oauth.google).toBe('g-1');
  });

  it('both doors need a session', async () => {
    mocks.getSession.mockImplementation(async () => null);
    expect((await welcomeBackHandler(req('/api/users/welcome-back', 'GET'))).status).toBe(401);
    expect((await welcomeBackAckHandler(req('/api/users/welcome-back/ack', 'POST'))).status).toBe(401);
  });
});
