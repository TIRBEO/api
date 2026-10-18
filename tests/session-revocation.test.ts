/**
 * Revoking a session has to survive the cache it just invalidated.
 *
 * `getSessionFromToken` answers an authenticated request from a Redis copy of
 * the session identity so a cold serverless instance doesn't open a database
 * connection — and revocation clears that copy with a fire-and-forget delete.
 * A delete that never lands (the function froze first, Redis blinked) left the
 * cached identity answering for its whole TTL with nothing consulted, so a
 * logged-out, banned or password-changed session kept full access for up to a
 * minute. The fix is a second key that outlives the first: revoke writes a
 * marker, and the cache read carries it in the same round trip.
 *
 * No database, no real Redis: the store is a Map, and the delete that this test
 * cares about is sabotaged on purpose — that is the failure being guarded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// features/auth/redis.ts reads REDIS_URL once, at import, so it has to be set
// before this file's imports run — a plain vi.stubEnv here would land after.
vi.hoisted(() => { process.env.REDIS_URL = 'redis://test'; });

const store = vi.hoisted(() => new Map<string, string>());
const cfg = vi.hoisted(() => ({
  /** When true, dropping `session:cache:*` silently does nothing — the lost
   *  invalidation this test exists for. */
  sabotageDelete: false,
  sid: 's1',
  finds: 0,
  session: null as any,
}));

/** The identity warm-up is fire-and-forget on purpose; let it land. */
const settled = () => new Promise((tick) => setTimeout(tick, 0));

function makeFakeRedis() {
  const ttl = new Map<string, number>();
  const alive = (key: string) => {
    const at = ttl.get(key);
    if (at && at <= Date.now()) { store.delete(key); ttl.delete(key); }
    return store.has(key);
  };
  const set = async (key: string, value: string, expireMode?: string, seconds?: number) => {
    store.set(key, value);
    if (String(expireMode).toUpperCase() === 'EX' && seconds) ttl.set(key, Date.now() + seconds * 1000);
    return 'OK';
  };
  const del = async (...keys: string[]) => {
    let n = 0;
    for (const key of keys) {
      if (cfg.sabotageDelete && key.startsWith('session:cache:')) continue;
      if (store.delete(key)) n++;
      ttl.delete(key);
    }
    return n;
  };
  return {
    get: async (key: string) => (alive(key) ? store.get(key)! : null),
    set,
    setex: async (key: string, seconds: number, value: string) => {
      store.set(key, value);
      ttl.set(key, Date.now() + Number(seconds) * 1000);
      return 'OK';
    },
    del,
    mget: async (...keys: string[]) => keys.map((key) => (alive(key) ? store.get(key)! : null)),
    multi: () => {
      const queue: Array<() => Promise<unknown>> = [];
      const tx = {
        del: (...keys: string[]) => { queue.push(() => del(...keys)); return tx; },
        set: (key: string, value: string, expireMode?: string, seconds?: number) => { queue.push(() => set(key, value, expireMode, seconds)); return tx; },
        exec: async () => { const out = []; for (const run of queue) out.push(await run()); return out; },
      };
      return tx;
    },
  };
}

vi.mock('@/infrastructure/db/redis', () => ({
  getCachedRedisClient: () => makeFakeRedis(),
  checkRedisHealth: async () => ({ ok: true }),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    userSession: {
      findUnique: vi.fn(async ({ where }: any) => {
        cfg.finds++;
        if (!cfg.session || cfg.session.id !== where?.id) return null;
        return cfg.session;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    userEmail: { findFirst: vi.fn(async () => ({ address: 'alice@gmail.com' })) },
    rateLimitWindow: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

// A token whose payload names the session; signature verification is not what
// this test is about.
vi.mock('@/features/auth/jwt', () => ({
  verifyToken: vi.fn(async () => ({ sub: 'u1', sid: cfg.sid })),
  signToken: vi.fn(async () => 'token'),
  COOKIE_NAME: '__session',
}));

import { getSessionFromToken, revokeSession, bustSessionCache } from '@/features/auth/session';

let seq = 0;

beforeEach(() => {
  store.clear();
  cfg.sabotageDelete = false;
  cfg.finds = 0;
  // A fresh id per test: session.ts keeps a 45s in-memory copy of every
  // identity it has answered with, and that layer must not leak between cases.
  cfg.sid = `s${++seq}`;
  cfg.session = {
    id: cfg.sid, userId: 'u1', status: 'active', revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000), lastUsedAt: new Date(), deviceName: null,
    user: { id: 'u1', username: 'alice', status: 'active', isAdmin: false, security: { saveLoginInfo: true } },
  };
});

describe('a revoked session whose cache clear was lost', () => {
  it('is rejected anyway, and without going back to the database', async () => {
    const first = await getSessionFromToken('t');
    await settled();
    expect(first).toMatchObject({ userId: 'u1', sessionId: cfg.sid });
    expect(store.get(`session:cache:${cfg.sid}`)).toContain('alice@');

    // The revoke lands in the database and marks the session, then the
    // fire-and-forget cache delete vanishes.
    cfg.sabotageDelete = true;
    await revokeSession(cfg.sid);
    await settled();
    cfg.session.revokedAt = new Date();
    cfg.session.status = 'revoked';
    expect(store.get(`auth:revoked:${cfg.sid}`)).toBe('1');
    expect(store.get(`session:cache:${cfg.sid}`)).toBeTruthy(); // the stale copy survived

    cfg.sabotageDelete = false;
    // A second serverless instance: no copy in its 45s memory layer, so the
    // Redis entry is what answers. This is the reader the marker exists for.
    bustSessionCache(cfg.sid);
    const findsBefore = cfg.finds;
    expect(await getSessionFromToken('t')).toBeNull();
    expect(cfg.finds).toBe(findsBefore); // vetoed at the cache, not re-read
  });

  it('still serves a live session from memory when nothing revoked it', async () => {
    await getSessionFromToken('t');
    await settled();
    const findsBefore = cfg.finds;
    expect(await getSessionFromToken('t')).toMatchObject({ userId: 'u1', sessionId: cfg.sid });
    expect(store.get(`session:cache:${cfg.sid}`)).toContain('alice@');
    // the in-memory layer answering first is the point of the whole cache
    expect(cfg.finds).toBe(findsBefore);
  });
});
