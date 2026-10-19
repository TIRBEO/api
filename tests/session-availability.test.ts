/**
 * "We could not check" must never be answered as "you are not signed in".
 *
 * A session lookup that times out or throws used to return `null`, which every
 * guard renders as a 401 — and a 401 is the one reply the clients obey by
 * discarding the credential, so a 3.5-second pooler stall on Supavisor became a
 * durable sign-out of a session that had days left on it. `SessionUnavailableError`
 * carries the distinction to the response layer, where it becomes a 503.
 *
 * No database and no real Redis: the only thing under test is which of the two
 * answers a failed lookup produces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  process.env.REDIS_URL = 'redis://test';
  process.env.JWT_SECRET = 'test-secret-value-long-enough-for-hs256-keying-material';
});

const cfg = vi.hoisted(() => ({
  /** What `userSession.findUnique` does: 'throws' = pooler unreachable,
   *  'hangs' = it never answers, 'missing' = the row genuinely is not there. */
  db: 'throws' as 'throws' | 'hangs' | 'missing' | 'ok',
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => null) },
    // The lazy last-active touch fires on any row without a recent stamp; it is
    // fire-and-forget but still has to be callable.
    userDevice: { updateMany: vi.fn(async () => ({ count: 0 })) },
    userSession: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => {
        if (cfg.db === 'throws') throw new Error('connection terminated');
        if (cfg.db === 'hangs') return new Promise(() => {}); // never settles
        if (cfg.db === 'missing') return null;
        return {
          id: 's1', revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000),
          userId: 'u1',
          user: { id: 'u1', username: 'tester', status: 'active', isAdmin: false, security: { saveLoginInfo: true } },
        };
      }),
    },
  },
}));

vi.mock('@/features/auth/redis', () => ({
  hashRefreshToken: (t: string) => `h:${t}`,
  generateRefreshToken: () => 'rt',
  markRefreshSpent: vi.fn(async () => {}),
  isRefreshSpent: vi.fn(async () => false),
  saveSessionState: vi.fn(async () => {}),
  getSessionState: vi.fn(async () => null),
  revokeSessionState: vi.fn(async () => {}),
  // Cold cache: force the path under test to go to the database.
  readCachedSessionIdentity: vi.fn(async () => undefined),
  setCachedSessionIdentity: vi.fn(async () => {}),
  deleteCachedSessionIdentity: vi.fn(async () => {}),
}));

vi.mock('@/features/auth/jwt', async () => {
  const { JWT_SECRET } = process.env;
  const { SignJWT, jwtVerify } = await import('jose');
  const key = new TextEncoder().encode(JWT_SECRET);
  return {
    COOKIE_NAME: '__session',
    // Mirrors the real signature (jwt.ts:19) so the call sites below type-check
    // against the module they think they are using.
    signToken: async (userId: string, sessionId: string, adminRole?: string) => {
      const payload: Record<string, any> = { sub: userId, sid: sessionId };
      if (adminRole) payload.adminRole = adminRole;
      return new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('15m').sign(key);
    },
    verifyToken: async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, key);
        return payload;
      } catch {
        return null;
      }
    },
  };
});

import { getSessionFromToken, isSessionUnavailable, SessionUnavailableError } from '@/features/auth/session';
import { sessionHandler } from '@/features/auth/authHandlers';

// The identity cache is module state, so reusing one `sid` lets an earlier
// test's "no such session" answer be served to the next test before it ever
// reaches the database. Distinct ids per sign-in, like real sessions have.
let sidSeq = 0;

async function signedInToken() {
  const { signToken } = await import('@/features/auth/jwt');
  return signToken('u1', `s${++sidSeq}`);
}

function requestWithCookie(token: string) {
  return {
    cookies: { get: (n: string) => (n === '__session' ? { value: token } : undefined) },
    headers: new Headers(),
    nextUrl: new URL('https://api.tirbeo.com/api/auth/session'),
    url: 'https://api.tirbeo.com/api/auth/session',
  } as any;
}

describe('session lookup availability', () => {
  beforeEach(() => {
    cfg.db = 'throws';
    vi.unstubAllEnvs();
  });

  it('throws SessionUnavailableError when the query fails', async () => {
    const token = await signedInToken();
    await expect(getSessionFromToken(token)).rejects.toThrow(SessionUnavailableError);
  });

  it('throws it when the lookup never answers, instead of rejecting the session', async () => {
    cfg.db = 'hangs';
    const token = await signedInToken();
    const before = Date.now();
    await expect(getSessionFromToken(token)).rejects.toThrow(SessionUnavailableError);
    // The guard is a deadline, so "unknown" must be reached in seconds — the
    // whole point is that nobody waits a pooler timeout out.
    expect(Date.now() - before).toBeLessThan(10_000);
  });

  it('still answers null for a session that genuinely is not there (that IS a 401)', async () => {
    cfg.db = 'missing';
    const token = await signedInToken();
    await expect(getSessionFromToken(token)).resolves.toBeNull();
  });

  it('answers a live session normally', async () => {
    cfg.db = 'ok';
    const token = await signedInToken();
    const session = await getSessionFromToken(token);
    expect(session?.userId).toBe('u1');
  });

  it('reports the failure as 503 on /auth/session — the probe the dashboard obeys', async () => {
    cfg.db = 'throws';
    const token = await signedInToken();
    const res = await sessionHandler(requestWithCookie(token));
    expect(res.status).toBe(503);
    expect(isSessionUnavailable(new SessionUnavailableError())).toBe(true);
    // A 401 here is what signs the person out; the body must not read like one.
    const body = await res.json();
    expect(body.code).toBe('SESSION_LOOKUP_UNAVAILABLE');
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('still answers 401 for a session the database says does not exist', async () => {
    cfg.db = 'missing';
    const token = await signedInToken();
    const res = await sessionHandler(requestWithCookie(token));
    expect(res.status).toBe(401);
  });
});
