/**
 * The duplicate-account line, on both paths that create a user.
 *
 * Every lookup these handlers make answers one question: does somebody already
 * own this identity? Two things must therefore never happen. A read that fails
 * must never be taken for "nobody owns it" — that is how an existing person gets
 * routed into the create path — and a create that loses the race against a
 * concurrent one must come back as something the person can act on, because the
 * UNIQUE columns are what actually stop a second account for the same person.
 *
 * No database here: `prisma` is a small world of rows that refuses duplicates
 * the way Postgres does (P2002), so the assertions are about the answer each
 * failure produces and about nothing being written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'dup-guard-test-secret';
});

const state = vi.hoisted(() => ({
  users: [] as any[],
  emails: [] as any[],
  prefs: [] as any[],
  /** When set, every read throws it — the network blip that used to read as "no account". */
  readFailure: null as any,
  creates: [] as any[],
  linked: [] as any[],
}));

function p2002(target: string) {
  const err: any = new Error(`Unique constraint failed on the fields: (\`${target}\`)`);
  err.code = 'P2002';
  err.meta = { target: [target] };
  return err;
}

function unreachable() {
  const err: any = new Error('connect ENETUNREACH 2406:da14:1772:ea02:dd23:b339:ba7e:757f:5432');
  err.code = 'ENETUNREACH';
  return err;
}

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    userEmail: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (state.readFailure) throw state.readFailure;
        const hit = state.emails.find((e) => e.address.toLowerCase() === String(where.address).toLowerCase());
        return hit ? { userId: hit.userId } : null;
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (state.readFailure) throw state.readFailure;
        const wanted = String(where.email?.equals ?? where.email).toLowerCase();
        const hit = state.users.find((u) => String(u.email).toLowerCase() === wanted);
        return hit ? { id: hit.id } : null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (state.readFailure) throw state.readFailure;
        const hit = state.users.find((u) =>
          (where.id !== undefined && u.id === where.id) ||
          (where.username !== undefined && u.username === String(where.username).toLowerCase()) ||
          (where.email !== undefined && String(u.email).toLowerCase() === String(where.email).toLowerCase()));
        return hit ? { id: hit.id, email: hit.email, username: hit.username, status: hit.status } : null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const email = String(data.email).toLowerCase();
        const username = String(data.username).toLowerCase();
        if (state.users.some((u) => String(u.email).toLowerCase() === email)) throw p2002('users_email_key');
        if (state.users.some((u) => u.username === username)) throw p2002('users_username_key');
        const user = { id: `u-${state.users.length + 1}`, email, username, status: 'active' };
        state.users.push(user);
        state.creates.push(data);
        return { id: user.id };
      }),
    },
    userPreferences: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (state.readFailure) throw state.readFailure;
        const path = where?.misc?.path;
        const hit = state.prefs.find((p) => {
          const misc = p.misc || {};
          if (!path) return true;
          return misc.oauth?.[path[1]] === where.misc.equals;
        });
        return hit ? { userId: hit.userId } : null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const hit = state.prefs.find((p) => p.userId === where.userId);
        return hit ? { misc: hit.misc } : null;
      }),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const existing = state.prefs.find((p) => p.userId === where.userId);
        if (existing) {
          existing.misc = update.misc;
          state.linked.push({ userId: existing.userId, oauth: existing.misc?.oauth });
          return existing;
        }
        state.prefs.push({ userId: create.userId, misc: create.misc });
        state.linked.push({ userId: create.userId, oauth: create.misc?.oauth });
        return create;
      }),
    },
    userProfile: { update: vi.fn(async () => null) },
    activityEvent: { create: vi.fn(async () => null) },
    otp: { deleteMany: vi.fn(async () => ({})), create: vi.fn(async () => null) },
  },
}));

vi.mock('@/features/identity/tirbeo', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    fetchLoginUserById: vi.fn(async (userId: string) => {
      if (state.readFailure) throw state.readFailure;
      const u = state.users.find((x) => x.id === userId);
      return u ? { id: u.id, email: u.email, username: u.username, status: u.status, name: null, photoUrl: null } : null;
    }),
    setRecoveryContact: vi.fn(async () => {}),
    upsertMailAccount: vi.fn(async () => {}),
    recordProvisioning: vi.fn(() => {}),
  };
});

vi.mock('@/features/captcha/risk', () => ({
  checkWindowLimit: vi.fn(async () => true),
  checkWindowLimitDB: vi.fn(async () => true),
  computeRiskScore: vi.fn(async () => ({ requireCaptcha: false })),
  recordDeviceSeen: vi.fn(async () => {}),
  hasRecentLoginSuccess: vi.fn(async () => false),
}));
vi.mock('@/features/captcha/gate', () => ({
  requireCaptchaGate: vi.fn(async () => ({ ok: true })),
  getUserWarningCount: vi.fn(async () => 0),
}));
vi.mock('@/features/auth/session', () => ({
  createSession: vi.fn(async (userId: string) => ({ token: `token-${userId}`, refreshToken: 'refresh' })),
  setSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  revokeSession: vi.fn(),
  rotateRefreshToken: vi.fn(),
  REFRESH_COOKIE_NAME: '__refresh',
  COOKIE_DOMAIN: undefined,
}));
vi.mock('@/features/auth/password', () => ({
  hashPassword: vi.fn(async () => 'hashed'),
  verifyPassword: vi.fn(async () => true),
  hashOtpCode: vi.fn(() => 'otp-hash'),
  hashRecoveryCode: vi.fn(() => 'recovery-hash'),
}));
vi.mock('@/features/auth/breach', () => ({ checkPasswordBreach: vi.fn(async () => ({ breached: false })) }));
vi.mock('@/features/auth/signup-otp', () => ({
  generateOtpCode: vi.fn(() => '123456'),
  storeSignupOtp: vi.fn(async () => {}),
  verifySignupOtp: vi.fn(async () => true),
  sendSignupOtpEmail: vi.fn(async () => {}),
  checkSignupOtp: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/features/email/email', () => ({
  sendTemplateEmail: vi.fn(async () => ({ success: true })),
  // Signup mails the welcome note and the verification code through the
  // deferred helper; nothing here asserts on them, it only has to exist.
  sendTemplateEmailAfter: vi.fn(),
  logEmail: vi.fn(async () => {}),
}));
vi.mock('@/features/notifications/notifications', () => ({
  createNotification: vi.fn(async () => ({})),
  describeDevice: vi.fn(() => 'a browser'),
  NEW_ACCOUNT_PREFS: { email: true },
}));
vi.mock('@/features/auth/supabase-admin', () => ({
  createSupabaseAuthUser: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/features/auth/redis', () => ({
  getRedis: vi.fn(() => null),
  setCachedProfile: vi.fn(async () => {}),
  deleteCachedProfile: vi.fn(async () => {}),
}));
vi.mock('@/features/auth/auth-log', () => ({ logAuthJson: vi.fn(async () => {}) }));
vi.mock('@/features/security/security', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, logSecurityEvent: vi.fn(async () => {}), recordLoginHistory: vi.fn(async () => {}) };
});

import { oauthSignupCompleteHandler, oauthPendingHandler, signupHandler } from '@/features/auth/authHandlers';
import { signPendingSignupToken, verifyMergeToken } from '@/features/auth/jwt';

function post(body: unknown) {
  return new NextRequest('http://localhost:3000/api/auth/any-route', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'vitest', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

const OWNER = { id: 'u-owner', email: 'smoke.check@gmail.com', username: 'smokecheck', status: 'active' };

function seedOwner(overrides: Record<string, unknown> = {}) {
  state.users = [{ ...OWNER, ...overrides }];
  state.emails = [{ userId: OWNER.id, address: OWNER.email }];
}

function signupBody(over: Record<string, unknown> = {}) {
  return {
    email: 'brand.new@gmail.com',
    password: 'a-long-enough-password',
    firstName: 'Brand',
    lastName: 'New',
    username: 'brandnew',
    policyAccepted: true,
    otpCode: '123456',
    ...over,
  };
}

/** `email`/`providerId`/`name` travel inside the signed token (what the provider
 *  vouched for); `username` is what the screen posted. */
async function completeBody(over: { email?: string; providerId?: string; name?: string; username?: string } = {}) {
  const token = await signPendingSignupToken({
    provider: 'google',
    providerId: over.providerId ?? 'google-1',
    email: over.email ?? 'brand.new@gmail.com',
    name: over.name ?? 'Brand New',
  });
  return { token, policyAccepted: true, username: over.username ?? 'brandnew' };
}

beforeEach(() => {
  state.users = [];
  state.emails = [];
  state.prefs = [];
  state.readFailure = null;
  state.creates = [];
  state.linked = [];
});

describe('password signup', () => {
  it('creates the account when nothing owns the email or username', async () => {
    const res = await signupHandler(post(signupBody()));
    expect(res.status).toBe(201);
    expect(state.creates).toHaveLength(1);
  });

  it('refuses an email that an account already owns, and creates nothing', async () => {
    seedOwner();
    const res = await signupHandler(post(signupBody({ email: OWNER.email, username: 'someothername' })));
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.accountExists).toBe(true);
    expect(body.error).toMatch(/already exists/i);
    expect(state.creates).toHaveLength(0);
  });

  it('refuses an email only the users.email column knows about', async () => {
    // The legacy shape: a row in users with no user_email twin. Asking
    // user_email alone answered "free" and the INSERT took the blame.
    state.users = [OWNER];
    state.emails = [];
    const res = await signupHandler(post(signupBody({ email: OWNER.email.toUpperCase(), username: 'someothername' })));
    expect(res.status).toBe(409);
    expect((await res.json() as any).accountExists).toBe(true);
    expect(state.creates).toHaveLength(0);
  });

  it('refuses a taken username with the flag the form puts on the field', async () => {
    seedOwner();
    const res = await signupHandler(post(signupBody({ username: OWNER.username })));
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.usernameTaken).toBe(true);
    expect(state.creates).toHaveLength(0);
  });

  it('turns a lost race into 409 rather than a generic failure', async () => {
    // The row exists but every read says "free" — a concurrent signup won the
    // gap. Only the INSERT sees it, so this is the P2002 path.
    state.users = [OWNER];
    const prisma: any = (await import('@/infrastructure/db/prisma')).prisma;
    prisma.userEmail.findFirst.mockResolvedValueOnce(null);
    prisma.user.findFirst.mockResolvedValueOnce(null);
    const res = await signupHandler(post(signupBody({ email: OWNER.email, username: 'someothername' })));
    expect(res.status).toBe(409);
    expect((await res.json() as any).accountExists).toBe(true);
    expect(state.creates).toHaveLength(0);
  });

  it('names the username when the race is lost on the username', async () => {
    state.users = [OWNER];
    const prisma: any = (await import('@/infrastructure/db/prisma')).prisma;
    prisma.userEmail.findFirst.mockResolvedValueOnce(null);
    prisma.user.findFirst.mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const res = await signupHandler(post(signupBody({ username: OWNER.username })));
    expect(res.status).toBe(409);
    expect((await res.json() as any).usernameTaken).toBe(true);
    expect(state.creates).toHaveLength(0);
  });

  it('says retry, not "signup failed", when the database is unreachable — and creates nothing', async () => {
    state.readFailure = unreachable();
    const res = await signupHandler(post(signupBody()));
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.retryable).toBe(true);
    expect(state.creates).toHaveLength(0);
  });
});

describe('oauth account creation', () => {
  it('signs the person into the account that owns the email instead of creating one', async () => {
    seedOwner();
    const res = await oauthSignupCompleteHandler(post(await completeBody({ email: OWNER.email })));
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
    expect(state.creates).toHaveLength(0);
    // …and the provider identity ends up linked to that account.
    expect(state.linked.at(-1)?.oauth).toEqual({ google: 'google-1' });
  });

  it('a banned or suspended account is let in on the closure screen — nothing created or linked', async () => {
    for (const status of ['banned', 'suspended']) {
      seedOwner({ status });
      state.linked = [];
      const res = await oauthSignupCompleteHandler(post(await completeBody({ email: OWNER.email })));
      // The provider assertion is a matched credential: the person gets the
      // decision of record plus a session that only opens the settings closure
      // screen (blockedAccountResponse) — never the account's own data.
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.blocked).toBe(true);
      expect(body.kind).toBe(status);
      expect(body.ok).toBeUndefined();
      expect(state.creates).toHaveLength(0);
      expect(state.linked).toHaveLength(0);
    }
  });

  it('never hijacks a provider identity somebody else already claimed', async () => {
    seedOwner();
    state.prefs = [{ userId: OWNER.id, misc: { oauth: { google: 'google-1' } } }];
    const res = await oauthSignupCompleteHandler(post(await completeBody({ email: 'brand.new@gmail.com' })));
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toMatch(/already linked/i);
    expect(state.creates).toHaveLength(0);
  });

  it('answers the taken email before the taken username, so the person is signed in rather than dead-ended', async () => {
    seedOwner();
    const res = await oauthSignupCompleteHandler(post(await completeBody({ email: OWNER.email, username: OWNER.username })));
    expect(res.status).toBe(200);
    expect(state.creates).toHaveLength(0);
  });

  it('refuses a taken username for a genuinely new email', async () => {
    seedOwner();
    const res = await oauthSignupCompleteHandler(post(await completeBody({ username: OWNER.username })));
    expect(res.status).toBe(409);
    expect((await res.json() as any).usernameTaken).toBe(true);
    expect(state.creates).toHaveLength(0);
  });

  it('says retry when the database is unreachable — and creates nothing', async () => {
    state.readFailure = unreachable();
    const res = await oauthSignupCompleteHandler(post(await completeBody()));
    expect(res.status).toBe(503);
    expect(state.creates).toHaveLength(0);
  });

  it('creates the account when the email, the username and the provider are all free', async () => {
    const res = await oauthSignupCompleteHandler(post(await completeBody()));
    expect(res.status).toBe(200);
    expect(state.creates).toHaveLength(1);
  });
});

/**
 * The second look the create screen takes before it shows its form. The token
 * was minted when nobody owned the address; anything that changed since then
 * has to arrive as a way to merge, never as an invitation to make a second
 * account for the same person.
 */
describe('pending signup preview', () => {
  function getWithToken(token: string) {
    return new NextRequest(
      `http://localhost:3000/api/auth/oauth/pending?token=${encodeURIComponent(token)}`,
      { method: 'GET', headers: { 'user-agent': 'vitest' } });
  }

  async function pending(over: { email?: string; providerId?: string; provider?: string } = {}) {
    const token = await signPendingSignupToken({
      provider: over.provider ?? 'google',
      providerId: over.providerId ?? 'google-9',
      email: over.email ?? OWNER.email,
      name: 'Smoke Check' });
    const res = await oauthPendingHandler(getWithToken(token));
    return { res, body: (await res.json()) as any };
  }

  it('offers the merge and the account to merge into when the email is owned', async () => {
    seedOwner();
    const { res, body } = await pending();
    expect(res.status).toBe(200);
    expect(body.existingAccount).toBe(true);
    expect(body.existing).toMatchObject({ username: 'smokecheck' });
    expect(body.mergeUrl).toContain('oauth=merge');
    const payload = await verifyMergeToken(new URL(body.mergeUrl).searchParams.get('token')!);
    expect(payload).toMatchObject({ provider: 'google', providerId: 'google-9', existingUserId: OWNER.id });
  });

  it('offers nothing to merge for an address nobody owns — that is the create form', async () => {
    seedOwner();
    const { body } = await pending({ email: 'brand.new@gmail.com' });
    expect(body.existingAccount).toBe(false);
    expect(body.existingLink).toBe(false);
    expect(body.existing).toBeNull();
    expect(body.mergeUrl).toBeNull();
  });

  it('does not offer a merge for an identity another account already claimed', async () => {
    // Transferring a connected identity is a decision made with a session on
    // the connected-apps screen, not from a create screen.
    seedOwner();
    state.prefs = [{ userId: OWNER.id, misc: { oauth: { google: 'google-9' } } }];
    const { body } = await pending();
    expect(body.existingLink).toBe(true);
    expect(body.mergeUrl).toBeNull();
    expect(body.existing).toMatchObject({ username: 'smokecheck' });
  });

  it('does not offer a merge into a deleted account', async () => {
    seedOwner({ status: 'deleted' });
    const { body } = await pending();
    expect(body.existingAccount).toBe(true);
    expect(body.mergeUrl).toBeNull();
  });

  it('does not mint a merge link for a provider it does not support', async () => {
    seedOwner();
    const { body } = await pending({ provider: 'notaprovider' });
    expect(body.existingAccount).toBe(true);
    expect(body.mergeUrl).toBeNull();
  });

  it('says retry when the database is unreachable, instead of "nobody owns it"', async () => {
    state.readFailure = unreachable();
    const { res, body } = await pending();
    expect(res.status).toBe(503);
    expect(body.retryable).toBe(true);
    expect(body.existingAccount).toBeUndefined();
  });
});
