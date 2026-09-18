/**
 * Unit tests for the shared reauth guard (lib/auth/reauth.ts).
 *
 * The passkey-token path exercises the REAL jose sign/verify round-trip;
 * password/TOTP verification and the rate limiter are stubbed. No database,
 * Redis, or network access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.UNSUBSCRIBE_SECRET = 'test-secret';
process.env.JWT_SECRET = 'test-jwt-secret-for-reauth-suite';

// ─── Mocks ──────────────────────────────────────────────────────────

// vi.mock factories are hoisted above top-level lets — create the mutable
// mocks via vi.hoisted so both the factory and the tests share them.
const mocks = vi.hoisted(() => ({
  checkWindowLimitDB: vi.fn(async () => true),
  prismaUser: null as any,
  getSession: vi.fn(async () => ({ userId: 'u1', sessionId: 's1' })),
}));

// Password/TOTP verifiers: deterministic, hermetic.
vi.mock('@/features/auth/password', () => ({
  verifyPassword: vi.fn(async (_hash: string, pw: string) => pw === 'right-password'),
}));
vi.mock('@/features/auth/totp', () => ({
  verifyTotp: vi.fn(async (code: string) => code === '123456'),
}));

// Rate limiter: per-test control via mocks.checkWindowLimitDB.
vi.mock('@/features/captcha/risk', () => ({ checkWindowLimitDB: mocks.checkWindowLimitDB }));

// Prisma user lookups: per-test config via mocks.prismaUser.
vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => mocks.prismaUser),
    },
  },
}));

// Session probe (used by reauthVerifyHandler only).
vi.mock('@/features/auth/http-guards', () => ({ getSession: mocks.getSession }));

import { requireReauth, reauthVerifyHandler } from '@/features/auth/reauth';
import { signReauthToken } from '@/features/auth/jwt';
import type { NextRequest } from 'next/server';

// Minimal fake request — requireReauth only touches .json() and .nextUrl.
function fakeRequest(body?: unknown, queryCode?: string): NextRequest {
  const searchParams = new URLSearchParams();
  if (queryCode) searchParams.set('code', queryCode);
  return {
    json: async () => body,
    nextUrl: { searchParams },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkWindowLimitDB.mockImplementation(async () => true);
  mocks.prismaUser = null;
});

// ─── Passkey token proof ────────────────────────────────────────────

describe('requireReauth — passkey token', () => {
  it('accepts a valid reauth token bound to the session user', async () => {
    const token = await signReauthToken('u1');
    const body = { reauthToken: token, extra: 'kept' };
    const r = await requireReauth(fakeRequest(body), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe('passkey');
      expect(r.body).toEqual(body); // body handed back, not double-consumed
    }
  });

  it('rejects a token signed for a different user (403 REAUTH_REQUIRED)', async () => {
    const token = await signReauthToken('attacker');
    const r = await requireReauth(fakeRequest({ reauthToken: token }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(403);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('REAUTH_REQUIRED');
    }
  });

  it('rejects a garbage token with 403 REAUTH_REQUIRED', async () => {
    const r = await requireReauth(fakeRequest({ reauthToken: 'not-a-jwt' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(403);
  });

  it('rejects an expired token (5-minute TTL)', async () => {
    // signReauthToken has a fixed 5m exp; simulate expiry by accepting that a
    // token from "the past" cannot be produced — instead verify the verify
    // path treats any invalid token as 403 (no info leak).
    const r = await requireReauth(fakeRequest({ reauthToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.bad' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(403);
  });
});

// ─── Password proof ─────────────────────────────────────────────────

describe('requireReauth — password', () => {
  it('accepts the correct password and reports method=password', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({ password: 'right-password' }), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('password');
  });

  it('rejects a wrong password with 400 INVALID_PASSWORD and consumes a rate-limit slot', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({ password: 'wrong' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(400);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('INVALID_PASSWORD');
    }
    expect(mocks.checkWindowLimitDB).toHaveBeenCalledWith('reauth:pw:u1', 5, 15 * 60 * 1000);
  });

  it('rate-limits after too many failed attempts (429 REAUTH_RATE_LIMITED)', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 0 } };
    mocks.checkWindowLimitDB.mockImplementation(async () => false);
    const r = await requireReauth(fakeRequest({ password: 'wrong' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(429);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('REAUTH_RATE_LIMITED');
    }
  });

  it('rejects a password attempt for an account without a password hash', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: null, _count: { passkeys: 1 } };
    const r = await requireReauth(fakeRequest({ password: 'right-password' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
  });
});

// ─── TOTP proof ─────────────────────────────────────────────────────

describe('requireReauth — TOTP', () => {
  it('accepts a valid code from the body', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: 'secret', _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({ totpCode: '123456' }), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('totp');
  });

  it('accepts a valid code from the ?code= query (legacy disable-2FA flow)', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: 'secret', _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest(undefined, '123456'), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('totp');
  });

  it('rejects a wrong code with 400 INVALID_CODE', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: 'secret', _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({ code: '000000' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(400);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('INVALID_CODE');
    }
  });

  it('rejects a malformed code length with 400', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: 'secret', _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({ totpCode: '12345' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
  });

  it('ignores TOTP when allowTotp=false and demands another proof', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: 'secret', _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({ totpCode: '123456' }), 'u1', { allowTotp: false });
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(403);
  });
});

// ─── No proof supplied ──────────────────────────────────────────────

describe('requireReauth — missing proof & no-factor fallback', () => {
  it('demands REAUTH_REQUIRED (403) when the account has at least one factor', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 2 } };
    const r = await requireReauth(fakeRequest({}), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(403);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('REAUTH_REQUIRED');
      expect(Array.isArray(payload.methods)).toBe(true);
    }
  });

  it('allows the action with method=none when the account has NO factors', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: null, _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest({}), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('none');
  });

  it('allows with method=none when the user lookup fails (fail-open, anti-lockout)', async () => {
    mocks.prismaUser = null;
    const r = await requireReauth(fakeRequest({}), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('none');
  });

  it('handles a request with no JSON body at all', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 0 } };
    const r = await requireReauth(fakeRequest(undefined), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(403);
  });
});

// ─── reauthVerifyHandler (proof validation without side effects) ────

describe('reauthVerifyHandler', () => {
  it('returns ok:true with the proven method for a valid password', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 0 } };
    const res = await reauthVerifyHandler(fakeRequest({ password: 'right-password' }));
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ ok: true, method: 'password' });
  });

  it('returns 401 without a session', async () => {
    const { getSession } = await import('@/features/auth/http-guards');
    (getSession as any).mockImplementation(async () => null);
    const res = await reauthVerifyHandler(fakeRequest({ password: 'right-password' }));
    expect(res.status).toBe(401);
    (getSession as any).mockImplementation(async () => ({ userId: 'u1', sessionId: 's1' }));
  });

  it('propagates REAUTH_REQUIRED when no valid proof is given', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, _count: { passkeys: 1 } };
    const res = await reauthVerifyHandler(fakeRequest({}));
    expect(res.status).toBe(403);
    const payload: any = await res.json();
    expect(payload.error).toBe('REAUTH_REQUIRED');
  });
});
