/**
 * The credential-first rule for closed accounts.
 *
 * An account's status — banned, suspended, paused, scheduled for deletion — is
 * information ABOUT a person. Answering "is this address banned?" to anyone who
 * types it into a form turns every sign-in and every code-request endpoint into
 * an oracle, and hands the ban's reference code to the stranger who asked.
 *
 * These tests pin the ordering the whole design rests on: the refusal is only
 * ever produced AFTER a credential matching the account has been verified. A
 * wrong password, a wrong code and an unmatched appeal must all be refused
 * without a word about the account's state.
 *
 * The database, the mail transport and the OTP/ref-code primitives are stubbed;
 * the ordering logic under test is the real code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** userId -> user row, as the two readers below need it shaped. */
  users: new Map<string, any>(),
  /** lowercased address -> userId. */
  emails: new Map<string, string>(),
  otpRows: [] as any[],
  restrictions: [] as any[],
  deactivations: new Map<string, any>(),
  /** the row `activeDeletionFor` reports, or null. */
  deletion: null as any,
  /** reason column of `user_deletion_requests`. */
  deletionReason: null as string | null,
}));

vi.mock('@/features/auth/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('@/features/auth/resend-cooldown', () => ({
  enforceResendCooldown: vi.fn(async () => ({ allowed: true, remainingMs: 0 })),
}));
vi.mock('@/features/auth/otp', () => ({ generateOtpCode: vi.fn(() => '424242') }));

// The real hashing is irrelevant; what matters is that a MATCH is a match.
vi.mock('@/features/auth/password', () => ({
  verifyPassword: vi.fn(async (hash: string, plain: string) => hash === `pw:${plain}`),
  hashPassword: vi.fn((plain: string) => `pw:${plain}`),
  verifyOtpCode: vi.fn(async (hash: string, plain: string) => hash === `hash:${plain}`),
  hashOtpCode: vi.fn((plain: string) => `hash:${plain}`),
}));

vi.mock('@/features/auth/session', () => ({
  createSession: vi.fn(async () => ({ token: 'session-token', refreshToken: 'refresh-token' })),
}));

vi.mock('@/features/identity/tirbeo', () => ({
  fetchLoginUserByEmail: vi.fn(async (email: string) => {
    const id = mocks.emails.get(String(email).toLowerCase());
    return (id && mocks.users.get(id)) || null;
  }),
  fetchLoginUserById: vi.fn(async (id: string) => mocks.users.get(id) || null),
}));

vi.mock('@/features/users/refcode', () => ({
  ensureRefCode: vi.fn(async (_userId: string, kind: string) => `REF-${String(kind).toUpperCase()}`),
}));

vi.mock('@/features/status/accountLifecycle', () => ({
  activeDeletionFor: vi.fn(async () => mocks.deletion),
}));

vi.mock('@/features/captcha/risk', () => ({
  checkWindowLimitDB: vi.fn(async () => true),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.id) return mocks.users.get(where.id) || null;
        const id = mocks.emails.get(String(where?.email).toLowerCase());
        return (id && mocks.users.get(id)) || null;
      }),
    },
    userEmail: {
      findFirst: vi.fn(async ({ where }: any) => ({
        verifiedAt: where?.userId ? new Date('2026-01-01') : null,
      })),
    },
    otp: {
      findFirst: vi.fn(async ({ where }: any) =>
        mocks.otpRows.find((r) => r.userId === where?.userId && r.kind === where?.kind) || null),
      update: vi.fn(async ({ where, data }: any) => {
        const row = mocks.otpRows.find((r) => r.id === where?.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        mocks.otpRows = mocks.otpRows.filter((r) => r.id !== where?.id);
        return { id: where?.id };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    userRestriction: {
      findFirst: vi.fn(async ({ where }: any) =>
        mocks.restrictions.find((r) => r.userId === where?.userId) || null),
    },
    userDeactivation: {
      findUnique: vi.fn(async ({ where }: any) => mocks.deactivations.get(where?.userId) || null),
    },
    userDeletionRequest: {
      findUnique: vi.fn(async () => (mocks.deletionReason ? { reason: mocks.deletionReason } : null)),
    },
  },
}));

const CLOSED = 'closed@example.com';

function seedClosed(status: string, extra: Record<string, any> = {}) {
  mocks.users.set('u-closed', {
    id: 'u-closed',
    username: 'closed',
    status,
    passwordHash: 'pw:hunter2',
    profile: { name: 'Closed Person', photoUrl: null },
    ...extra,
  });
  mocks.emails.set(CLOSED, 'u-closed');
}

beforeEach(() => {
  mocks.users.clear();
  mocks.emails.clear();
  mocks.otpRows.length = 0;
  mocks.restrictions.length = 0;
  mocks.deactivations.clear();
  mocks.deletion = null;
  mocks.deletionReason = null;
});

/** An OTP row the reset/quick-login path will find and spend. */
function seedOtp(code: string) {
  mocks.otpRows.push({
    id: 'otp-1',
    userId: 'u-closed',
    kind: 'email',
    otpHash: `hash:${code}`,
    attempts: 0,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
}

describe('quick login with a reset code', () => {
  it('says nothing about a ban until the code has been verified', async () => {
    const { quickLoginWithOtp } = await import('@/features/auth/password-reset');
    seedClosed('banned');
    seedOtp('424242');

    const wrong = await quickLoginWithOtp(CLOSED, '000000');
    expect(wrong.success).toBe(false);
    expect((wrong as any).block).toBeUndefined();
    expect(wrong.error).toBe('Invalid or expired code');

    const right = await quickLoginWithOtp(CLOSED, '424242');
    expect(right.success).toBe(false);
    expect((right as any).block?.kind).toBe('banned');
    expect((right as any).block?.eventId).toBe('REF-BAN');
  });

  it('issues the session for an account that is not closed', async () => {
    const { quickLoginWithOtp } = await import('@/features/auth/password-reset');
    seedClosed('active');
    seedOtp('424242');

    const res = await quickLoginWithOtp(CLOSED, '424242');
    expect(res.success).toBe(true);
    expect(res.sessionToken).toBe('session-token');
  });
});

describe('blockFacts: the one description of a closure', () => {
  it('names every closed status with its own door, not a generic dead end', async () => {
    const { blockFactsFor } = await import('@/features/auth/blockFacts');
    const cases = ['banned', 'suspended', 'deletion_pending', 'deactivated', 'deleted'] as const;
    for (const status of cases) {
      const facts = await blockFactsFor('u-x', status);
      expect(facts?.kind).toBe(status);
      expect(facts?.message).toMatch(/./);
    }
    expect(await blockFactsFor('u-x', 'active')).toBeNull();
    expect(await blockFactsFor('u-x', null)).toBeNull();
  });

  it('carries the deletion date and the reason the person gave for it', async () => {
    const { blockFactsFor } = await import('@/features/auth/blockFacts');
    mocks.deletion = { finalAt: new Date('2026-11-05') };
    mocks.deletionReason = 'Taking a break from the internet';

    const facts = await blockFactsFor('u-x', 'deletion_pending');
    expect(facts).toMatchObject({
      kind: 'deletion_pending',
      until: '2026-11-05T00:00:00.000Z',
      reason: 'Taking a break from the internet',
    });
  });
});

/* The signed-in closed account gets a session, so the session is what asks the
   next question: which doors does it open? One answer, in one function, asked
   by the edge and the dispatcher alike. Pinned here because a policy that lives
   only in prose drifts — and because "the undo door" is the difference between
   a pause the person can reverse and a dead end. */
describe('closed-account door policy', () => {
  it('keeps the read and the appeal open for every closure', async () => {
    const { isClosedAccountDoor } = await import('@/features/auth/blockFacts');
    for (const kind of ['banned', 'suspended', 'deletion_pending', 'deactivated', 'deleted'] as const) {
      expect(isClosedAccountDoor(kind, '/api/user/account-state', 'GET')).toBe(true);
      expect(isClosedAccountDoor(kind, '/api/support/appeal', 'POST')).toBe(true);
    }
  });

  it('keeps only the undo that fits the closure', async () => {
    const { isClosedAccountDoor } = await import('@/features/auth/blockFacts');
    expect(isClosedAccountDoor('deactivated', '/api/user/reactivate', 'POST')).toBe(true);
    expect(isClosedAccountDoor('deletion_pending', '/api/user/delete-account', 'DELETE')).toBe(true);
    // Neither undo leaks into the other kind, nor into a decision's.
    expect(isClosedAccountDoor('deactivated', '/api/user/delete-account', 'DELETE')).toBe(false);
    expect(isClosedAccountDoor('deletion_pending', '/api/user/reactivate', 'POST')).toBe(false);
    expect(isClosedAccountDoor('banned', '/api/user/reactivate', 'POST')).toBe(false);
    expect(isClosedAccountDoor('banned', '/api/user/delete-account', 'DELETE')).toBe(false);
    // Right door, wrong verb is still a closed door (a GET is not a reactivation).
    expect(isClosedAccountDoor('deactivated', '/api/user/reactivate', 'DELETE')).toBe(false);
  });

  it('holds a closure the person did not choose to a ban without reads', async () => {
    const { isClosedAccountDoor } = await import('@/features/auth/blockFacts');
    // A pause and a scheduled deletion stay read-only: the shell can render.
    expect(isClosedAccountDoor('deactivated', '/api/notifications', 'GET')).toBe(true);
    expect(isClosedAccountDoor('deletion_pending', '/api/profile', 'HEAD')).toBe(true);
    // A ban, a suspension and a deletion that already ran open nothing else.
    expect(isClosedAccountDoor('banned', '/api/notifications', 'GET')).toBe(false);
    expect(isClosedAccountDoor('suspended', '/api/profile', 'GET')).toBe(false);
    expect(isClosedAccountDoor('deleted', '/api/profile', 'GET')).toBe(false);
    expect(isClosedAccountDoor('banned', '/api/profile', 'PATCH')).toBe(false);
  });
});
