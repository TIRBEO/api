/**
 * The emailed re-auth code — the fourth proof for sensitive actions.
 *
 * `requireReauth` used to accept only a passkey JWT, a password or a TOTP code,
 * so an account that had lost its passkey and never set a password could not
 * disable 2FA, revoke sessions or delete itself at any door. The fix is a
 * 6-digit code mailed to the sign-in address, riding the OTP core that the
 * deletion code already uses — same table, same hash-with-bind, same expiry,
 * same resend cooldown, same attempt counter, and its OWN kind so a deletion
 * code can't open a reauth gate.
 *
 * Prisma and the mailer are stubbed; the OTP core (accountLifecycle), the
 * hashing shape, the attempt counting and the cooldown gate are all real, so
 * what breaks here is the logic, not the plumbing. No database, Redis, network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  /** Live rows in the `security.otps` table. */
  rows: [] as any[],
  /** What `generateOtpCode` returns — a known code so the test can present it. */
  nextCode: '424242',
  /** The resend gate's verdict, per test. */
  gate: { allowed: true, remainingMs: 0 } as { allowed: boolean; remainingMs: number },
  prismaUser: null as any,
  primaryEmail: null as string | null,
  getSession: vi.fn(async () => ({ userId: 'u1', sessionId: 's1' } as any)),
}));

vi.mock('@/features/auth/redis', () => ({ getRedis: vi.fn(() => null) }));

// The resend cooldown is Redis-only; drive it straight from the fixture.
vi.mock('@/features/auth/resend-cooldown', () => ({
  enforceResendCooldown: vi.fn(async () => mocks.gate),
}));

// Fixed-length code so a test can present the one it just had minted.
vi.mock('@/features/auth/otp', () => ({
  generateOtpCode: vi.fn(() => mocks.nextCode),
  storeOtp: vi.fn(),
  verifyOtpCode: vi.fn(),
  sendEmailOtp: vi.fn(),
}));

// Real hashing is bcrypt/scrypt — slow, and irrelevant here. These keep the
// SHAPE that matters: the stored value is a function of `code|bind`, so a code
// minted for one account can't be spent on another.
vi.mock('@/features/auth/password', () => ({
  hashOtpCode: vi.fn((plain: string) => `hash:${plain}`),
  verifyOtpCode: vi.fn(async (hash: string, plain: string) => hash === `hash:${plain}`),
  verifyPassword: vi.fn(async (_hash: string, pw: string) => pw === 'right-password'),
  hashPassword: vi.fn(async (s: string) => s),
}));

vi.mock('@/features/auth/totp', () => ({
  verifyTotp: vi.fn(async (code: string) => code === '123456'),
}));

vi.mock('@/features/auth/jwt', () => ({
  verifyReauthToken: vi.fn(async () => 'someone-else'),
}));

vi.mock('@/features/captcha/risk', () => ({ checkWindowLimitDB: vi.fn(async () => true) }));

vi.mock('@/features/auth/http-guards', () => ({ getSession: mocks.getSession }));

vi.mock('@/features/email/email', () => ({
  sendTemplateEmail: vi.fn(async () => ({ success: true })),
}));

// ─── Prisma: a tiny in-memory stand-in for `security.otps` + the account ───

const matches = (row: any, where: any) =>
  Object.entries(where || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && 'equals' in (v as any)) return row[k] === (v as any).equals;
    return row[k] === v;
  });

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    otp: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `otp-${mocks.rows.length + 1}`, attempts: 0, createdAt: new Date(), ...data };
        mocks.rows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const hits = mocks.rows.filter((r) => matches(r, where));
        hits.sort((a, b) =>
          (orderBy?.createdAt === 'desc' ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()));
        return hits[0] ?? null;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = mocks.rows.length;
        mocks.rows = mocks.rows.filter((r) => !matches(r, where));
        return { count: before - mocks.rows.length };
      }),
      delete: vi.fn(async ({ where }: any) => {
        mocks.rows = mocks.rows.filter((r) => !matches(r, where));
        return { id: where?.id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = mocks.rows.find((r) => r.id === where?.id);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    user: {
      findUnique: vi.fn(async () => {
        const u = mocks.prismaUser;
        if (!u) return null;
        const security = 'security' in u ? u.security : (u.totpSecret ? { totpSecret: u.totpSecret } : null);
        return { ...u, security };
      }),
    },
    userSecurity: {
      findUnique: vi.fn(async () =>
        mocks.prismaUser?.totpSecret ? { totpSecret: mocks.prismaUser.totpSecret } : null),
    },
    userEmail: {
      findFirst: vi.fn(async () => (mocks.primaryEmail ? { address: mocks.primaryEmail } : null)),
    },
  },
}));

import { requireReauth, reauthSendCodeHandler, reauthVerifyHandler, availableReauthMethods } from '@/features/auth/reauth';
import { consumeReauthCode, issueReauthCode } from '@/features/auth/reauthCode';
import { sendTemplateEmail } from '@/features/email/email';
import type { NextRequest } from 'next/server';

// Minimal fake request — the guard only touches .json() and .nextUrl.
function fakeRequest(body?: unknown, queryCode?: string): NextRequest {
  const searchParams = new URLSearchParams();
  if (queryCode) searchParams.set('code', queryCode);
  return { json: async () => body, nextUrl: { searchParams } } as unknown as NextRequest;
}

const lastEmail = () => (sendTemplateEmail as any).mock.calls.slice(-1)[0];
const otpRows = (kind = 'reauth') => mocks.rows.filter((r) => r.kind === kind);

/** A password account that also has a sign-in address — the demanding case. */
function passwordAccount() {
  mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, email: 'alice@gmail.com', _count: { passkeys: 0 } };
  mocks.primaryEmail = 'alice@gmail.com';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.nextCode = '424242';
  mocks.gate = { allowed: true, remainingMs: 0 };
  mocks.prismaUser = null;
  mocks.primaryEmail = null;
  mocks.getSession.mockImplementation(async () => ({ userId: 'u1', sessionId: 's1' }));
});

// ─── Issuing ────────────────────────────────────────────────────────

describe('issueReauthCode — the shared OTP core under its own kind', () => {
  it('stores a code bound to the user, lowercased by address', async () => {
    const issued = await issueReauthCode('u1', 'Alice@Gmail.com');
    expect(issued.ok).toBe(true);
    const row = otpRows()[0];
    expect(row.userId).toBe('u1');
    expect(row.kind).toBe('reauth');
    expect(row.address).toBe('alice@gmail.com');
    // Bound: the hash covers the code AND the user id it was minted for.
    expect(row.otpHash).toBe('hash:424242|u1');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a new code replaces the live one — never two valid at once', async () => {
    await issueReauthCode('u1', 'alice@gmail.com');
    mocks.nextCode = '999999';
    await issueReauthCode('u1', 'alice@gmail.com');
    expect(otpRows()).toHaveLength(1);
    expect(otpRows()[0].otpHash).toBe('hash:999999|u1');
  });

  it('refuses to mint inside the resend cooldown', async () => {
    mocks.gate = { allowed: false, remainingMs: 21_000 };
    const issued = await issueReauthCode('u1', 'alice@gmail.com');
    expect(issued).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(otpRows()).toHaveLength(0);
  });
});

describe('POST /api/auth/reauth/send-code', () => {
  it('mails the code to the sign-in address and reports only a mask', async () => {
    passwordAccount();
    const res = await reauthSendCodeHandler(fakeRequest({}));
    expect(res.status).toBe(200);
    const payload: any = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.email).toBe('al***@gmail.com');

    const [to, template, vars] = lastEmail();
    expect(to).toBe('alice@gmail.com');
    expect(template).toBe('reauth_otp');
    expect(vars.otp).toBe('424242');
    expect(otpRows()).toHaveLength(1);
  });

  it('never echoes the code in the response', async () => {
    passwordAccount();
    const res = await reauthSendCodeHandler(fakeRequest({}));
    expect(JSON.stringify(await res.json())).not.toContain('424242');
  });

  it('429s a too-soon resend with the remaining seconds in the message', async () => {
    passwordAccount();
    mocks.gate = { allowed: false, remainingMs: 12_400 };
    const res = await reauthSendCodeHandler(fakeRequest({}));
    expect(res.status).toBe(429);
    const payload: any = await res.json();
    expect(payload.message).toContain('13s');
    expect(lastEmail()).toBeUndefined(); // nothing mailed while gated
  });

  it('needs a session', async () => {
    mocks.getSession.mockImplementation(async () => null);
    const res = await reauthSendCodeHandler(fakeRequest({}));
    expect(res.status).toBe(401);
  });

  it('says so when the account has no sign-in email at all', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, email: null, _count: { passkeys: 0 } };
    const res = await reauthSendCodeHandler(fakeRequest({}));
    expect(res.status).toBe(400);
    expect(lastEmail()).toBeUndefined();
  });
});

// ─── Spending it through the guard ──────────────────────────────────

describe('requireReauth — the emailed code proof', () => {
  it('accepts the right code as method "code" and hands the body back', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const body = { reauthCode: '424242', keep: 'me' };
    const r = await requireReauth(fakeRequest(body), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.method).toBe('code');
      expect(r.body).toEqual(body);
    }
    expect(mocks.rows).toHaveLength(0); // spent codes are gone, not marked used
  });

  it('rejects a wrong code with 400 INVALID_CODE and burns an attempt', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const r = await requireReauth(fakeRequest({ reauthCode: '111111' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(400);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('INVALID_CODE');
      expect(payload.message).toBe('That code is wrong or has been used. Ask for a new one.');
    }
    expect(otpRows()[0].attempts).toBe(1);
  });

  it('a spent code cannot be replayed', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const first = await requireReauth(fakeRequest({ reauthCode: '424242' }), 'u1');
    expect(first.ok).toBe(true);
    const second = await requireReauth(fakeRequest({ reauthCode: '424242' }), 'u1');
    expect(second.ok).toBe(false);
    if ('response' in second) expect(second.response.status).toBe(400);
  });

  it('rejects an expired code', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    otpRows()[0].expiresAt = new Date(Date.now() - 1000);
    const r = await requireReauth(fakeRequest({ reauthCode: '424242' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
    expect(otpRows()).toHaveLength(0); // expired rows self-destruct
  });

  it('rejects a code once the attempt counter is spent', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    otpRows()[0].attempts = 5;
    const r = await requireReauth(fakeRequest({ reauthCode: '424242' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
  });

  it('rejects a malformed code without touching the live one', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const r = await requireReauth(fakeRequest({ reauthCode: '42' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
    expect(otpRows()[0].attempts).toBe(0);
  });

  it('does not accept another account\'s code (bound to userId)', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const ok = await consumeReauthCode('u2', '424242');
    expect(ok).toBe(false);
  });

  it('does not accept a DELETION code on the reauth gate (kinds are isolated)', async () => {
    passwordAccount();
    const { issueDeletionCode } = await import('@/features/status/accountLifecycle');
    await issueDeletionCode('u1', 'alice@gmail.com');
    const r = await requireReauth(fakeRequest({ reauthCode: '424242' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
    expect(otpRows('account_delete')).toHaveLength(1); // untouched
  });

  it('works for an account with no password and no passkey — the case that was locked out', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: null, email: 'bob@gmail.com', _count: { passkeys: 1 } };
    mocks.primaryEmail = 'bob@gmail.com';
    await issueReauthCode('u1', 'bob@gmail.com');
    const r = await requireReauth(fakeRequest({ reauthCode: '424242' }), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('code');
  });
});

// ─── No regression on the door the TOTP path already used ───────────

describe('requireReauth — body.code still means TOTP', () => {
  it('a 6-digit body.code goes to the TOTP path, not the emailed-code path', async () => {
    passwordAccount();
    mocks.prismaUser.totpSecret = 'totp-secret';
    await issueReauthCode('u1', 'alice@gmail.com');
    const r = await requireReauth(fakeRequest({ code: '123456' }), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('totp');
    // The live emailed code was never presented, so it is still live.
    expect(otpRows()).toHaveLength(1);
  });

  it('a valid emailed code posted as body.code is NOT taken as the email proof', async () => {
    passwordAccount();
    mocks.prismaUser.totpSecret = 'totp-secret';
    await issueReauthCode('u1', 'alice@gmail.com');
    const r = await requireReauth(fakeRequest({ code: '424242' }), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) expect(r.response.status).toBe(400);
    expect(otpRows()).toHaveLength(1);
  });

  it('body.totpCode still verifies a TOTP', async () => {
    passwordAccount();
    mocks.prismaUser.totpSecret = 'totp-secret';
    const r = await requireReauth(fakeRequest({ totpCode: '123456' }), 'u1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe('totp');
  });

  it('the ?code= legacy query still works and skips allowTotp=false', async () => {
    passwordAccount();
    mocks.prismaUser.totpSecret = 'totp-secret';
    const ok = await requireReauth(fakeRequest(undefined, '123456'), 'u1');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.method).toBe('totp');
    const off = await requireReauth(fakeRequest(undefined, '123456'), 'u1', { allowTotp: false });
    expect(off.ok).toBe(false);
    if ('response' in off) expect(off.response.status).toBe(403);
  });
});

// ─── The 403 must offer only doors that exist ────────────────────────

describe('REAUTH_REQUIRED lists the methods the account can actually use', () => {
  it('password + email, nothing else', async () => {
    passwordAccount();
    const r = await requireReauth(fakeRequest({}), 'u1');
    expect(r.ok).toBe(false);
    if ('response' in r) {
      expect(r.response.status).toBe(403);
      const payload: any = await r.response.json();
      expect(payload.error).toBe('REAUTH_REQUIRED');
      expect(payload.methods).toEqual(['password', 'code']);
    }
  });

  it('passkey + password + totp + email — the whole menu', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: 'secret', email: 'carol@gmail.com', _count: { passkeys: 2 } };
    mocks.primaryEmail = 'carol@gmail.com';
    const r = await requireReauth(fakeRequest({}), 'u1');
    if ('response' in r) {
      const payload: any = await r.response.json();
      expect(payload.methods).toEqual(['passkey', 'password', 'totp', 'code']);
    }
  });

  it('an OAuth account with a lost passkey gets passkey + code — and code is its only real door', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: null, email: 'dave@gmail.com', _count: { passkeys: 1 } };
    mocks.primaryEmail = 'dave@gmail.com';
    expect(await availableReauthMethods('u1')).toEqual(['passkey', 'code']);
    const r = await requireReauth(fakeRequest({}), 'u1');
    if ('response' in r) {
      const payload: any = await r.response.json();
      expect(payload.methods).toEqual(['passkey', 'code']);
    }
  });

  it('no code, no email: code is not offered', async () => {
    mocks.prismaUser = { passwordHash: null, totpSecret: 'secret', email: null, _count: { passkeys: 0 } };
    expect(await availableReauthMethods('u1')).toEqual(['totp']);
    const r = await requireReauth(fakeRequest({}), 'u1');
    if ('response' in r) {
      const payload: any = await r.response.json();
      expect(payload.methods).not.toContain('code');
    }
  });

  it('falls back to the legacy address column when there is no primary email row', async () => {
    mocks.prismaUser = { passwordHash: 'hash', totpSecret: null, email: 'eve@gmail.com', _count: { passkeys: 0 } };
    mocks.primaryEmail = null;
    expect(await availableReauthMethods('u1')).toEqual(['password', 'code']);
  });
});

// ─── Pre-validating a proof without performing the action ───────────

describe('reauthVerifyHandler with an emailed code', () => {
  it('returns ok:true, method "code"', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const res = await reauthVerifyHandler(fakeRequest({ reauthCode: '424242' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, method: 'code' });
  });

  it('passes a wrong code straight through as 400', async () => {
    passwordAccount();
    await issueReauthCode('u1', 'alice@gmail.com');
    const res = await reauthVerifyHandler(fakeRequest({ reauthCode: '000000' }));
    expect(res.status).toBe(400);
    const payload: any = await res.json();
    expect(payload.error).toBe('INVALID_CODE');
  });

  it('needs a session', async () => {
    mocks.getSession.mockImplementation(async () => null);
    const res = await reauthVerifyHandler(fakeRequest({ reauthCode: '424242' }));
    expect(res.status).toBe(401);
  });
});
