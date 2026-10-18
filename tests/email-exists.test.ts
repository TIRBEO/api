/**
 * `POST /api/auth/email-exists` — the sign-in/forgot-password pre-flight.
 *
 * The accounts app asks this before walking a user into a password reset, so
 * the answer has to be exact on two points: a registered address reports
 * `exists: true` no matter how the caller capitalized it, and a deleted
 * account reports `exists: false` — the address must stop leaking that it was
 * ever registered. Beyond the answer itself, the endpoint is an enumeration
 * oracle, so it carries a hard per-IP budget (10 / 10 min) and must say a
 * clear 429 when that budget runs out.
 *
 * No database: `prisma` is a small world of rows, and the window limiter is a
 * boolean switch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.hoisted(() => {
  process.env.JWT_SECRET = 'email-exists-test-secret';
});

const state = vi.hoisted(() => ({
  users: [] as any[],
  emails: [] as any[],
  /** The per-IP window limiter's answer for every call. */
  windowLimitAllows: true,
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    userEmail: {
      findFirst: vi.fn(async ({ where }: any) => {
        const hit = state.emails.find((e) => e.address.toLowerCase() === String(where.address).toLowerCase());
        return hit ? { userId: hit.userId } : null;
      }),
    },
    user: {
      findFirst: vi.fn(async ({ where }: any) => {
        const wanted = String(where.email?.equals ?? where.email).toLowerCase();
        const hit = state.users.find((u) => String(u.email).toLowerCase() === wanted);
        return hit ? { id: hit.id } : null;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const hit = state.users.find((u) => u.id === where.id);
        return hit
          ? {
              status: hit.status,
              passwordHash: hit.passwordHash ?? 'hashed',
              profile: hit.profile ?? { name: 'Smoke Check', photoUrl: null },
              emails: hit.emails ?? [{ address: hit.email, kind: 'primary', isDefault: true, verifiedAt: new Date() }],
            }
          : null;
      }),
    },
    activityEvent: { create: vi.fn(async () => null) },
  },
}));

vi.mock('@/features/captcha/risk', () => ({
  checkWindowLimit: vi.fn(async () => true),
  checkWindowLimitDB: vi.fn(async () => state.windowLimitAllows),
  computeRiskScore: vi.fn(async () => ({ requireCaptcha: false })),
  recordDeviceSeen: vi.fn(async () => {}),
  hasRecentLoginSuccess: vi.fn(async () => false),
}));
vi.mock('@/features/captcha/gate', () => ({
  requireCaptchaGate: vi.fn(async () => ({ ok: true })),
  getUserWarningCount: vi.fn(async () => ({ count: 0, recentBlocks: 0 })),
}));
vi.mock('@/features/auth/redis', () => ({
  getRedis: vi.fn(() => null),
  setCachedProfile: vi.fn(async () => {}),
  deleteCachedProfile: vi.fn(async () => {}),
}));
vi.mock('@/features/auth/auth-log', () => ({
  logAuthJson: vi.fn(async () => {}),
  logOtpJson: vi.fn(async () => {}),
  logLinkJson: vi.fn(async () => {}),
}));
vi.mock('@/features/security/security', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    logSecurityEvent: vi.fn(async () => null),
    recordLoginHistory: vi.fn(async () => {}),
    // The 429 path still has to produce its reference id without a DB.
    logRateLimited: vi.fn(async () => 'rl-event-1'),
  };
});

import { emailExistsHandler } from '@/features/auth/authHandlers';

// Distinct addresses per case: the handler memoizes results for 30s, and the
// cases below must each hit the lookup path, not a previous case's cache.
const OWNER = { id: 'u-owner', email: 'preflight.check@gmail.com', status: 'active' };

function post(email: string, ip = '203.0.113.7') {
  return new NextRequest('http://localhost:3000/api/auth/email-exists', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email }),
  });
}

beforeEach(async () => {
  state.users = [];
  state.emails = [];
  state.windowLimitAllows = true;
  // The prisma mocks are module singletons — clear recorded calls between
  // cases so "did not touch the database" means "in THIS case".
  const prisma: any = (await import('@/infrastructure/db/prisma')).prisma;
  prisma.userEmail.findFirst.mockClear();
  prisma.user.findFirst.mockClear();
  prisma.user.findUnique.mockClear();
});

describe('POST /api/auth/email-exists', () => {
  it('answers exists for a registered address, with the identity card', async () => {
    state.users = [OWNER];
    state.emails = [{ userId: OWNER.id, address: OWNER.email }];
    const res = await emailExistsHandler(post(OWNER.email));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.exists).toBe(true);
    expect(body.hasPassword).toBe(true);
    expect(body.name).toBe('Smoke Check');
  });

  it('normalizes case — the same address asked with capitals is still registered', async () => {
    state.users = [OWNER];
    state.emails = [{ userId: OWNER.id, address: OWNER.email }];
    const res = await emailExistsHandler(post('Preflight.Check@GMAIL.com'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).exists).toBe(true);
  });

  it('answers exists:false for an address nobody owns', async () => {
    const res = await emailExistsHandler(post('nobody.here@outlook.com'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any)).toEqual({ exists: false });
  });

  it('refuses a deleted account — the address no longer leaks that it was registered', async () => {
    const gone = { ...OWNER, id: 'u-gone', email: 'deleted.guy@icloud.com', status: 'deleted' };
    state.users = [gone];
    state.emails = [{ userId: gone.id, address: gone.email }];
    const res = await emailExistsHandler(post(gone.email));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any)).toEqual({ exists: false });
  });

  it('rejects a malformed address without touching the database', async () => {
    const res = await emailExistsHandler(post('not-an-email'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).exists).toBe(false);
    const prisma: any = (await import('@/infrastructure/db/prisma')).prisma;
    expect(prisma.userEmail.findFirst).not.toHaveBeenCalled();
  });

  it('says a clear 429 once the per-IP budget is spent', async () => {
    state.windowLimitAllows = false;
    const res = await emailExistsHandler(post('over.the.limit@yahoo.com', '198.51.100.9'));
    expect(res.status).toBe(429);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/too many checks/i);
    expect(body.eventId).toBe('rl-event-1');
    // The budget tripped before any lookup was attempted.
    const prisma: any = (await import('@/infrastructure/db/prisma')).prisma;
    expect(prisma.userEmail.findFirst).not.toHaveBeenCalled();
  });
});
