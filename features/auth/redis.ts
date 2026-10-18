import { getCachedRedisClient, checkRedisHealth } from '@/infrastructure/db/redis';

type SessionState = {
  userId: string;
  revoked: boolean;
  createdAt: number;
  lastSeenIp: string | null;
  deviceInfo: string | null;
  revokedAt?: number;
};

const REDIS_URL = process.env.REDIS_URL;

let _client: any = null;

/**
 * Get the auth Redis client with automatic reconnection and keep-alive.
 * Uses the shared Redis factory for connection management.
 */
export function getRedis(): any {
  if (typeof window !== 'undefined') return null;
  if (!REDIS_URL) return null;
  
  if (!_client) {
    _client = getCachedRedisClient('auth', {
      url: REDIS_URL,
      enableKeepAlive: true,
      keepAliveInterval: 25_000, // 25s — Upstash closes idle after ~30-60s
    });
  }
  return _client;
}

/** Check if auth Redis is healthy */
export async function checkAuthRedisHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const client = getRedis();
  if (!client) return { ok: false, latencyMs: 0, error: 'Redis not configured' };
  return checkRedisHealth(client);
}

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_KEY = (sid: string) => `auth:session:${sid}`;
const SPENT_KEY = (hash: string) => `auth:refresh_spent:${hash}`;
/** Set when a session is revoked, and read by anyone holding a cache entry for
    that session. Must outlive the identity cache below, or the entry it exists
    to veto could outlive it. */
const REVOKED_KEY = (sid: string) => `auth:revoked:${sid}`;
const REVOKED_MARK_TTL_MS = 15 * 60 * 1000;

export async function getSessionState(sessionId: string): Promise<SessionState | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(SESSION_KEY(sessionId));
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

export async function saveSessionState(state: SessionState & { sessionId: string }): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.setex(SESSION_KEY(state.sessionId), Math.ceil(REFRESH_TTL_MS / 1000), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export async function revokeSessionState(sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    const cache = (globalThis as any).__authSessionState as Map<string, SessionState> | undefined;
    if (cache?.has(sessionId)) cache.delete(sessionId);
    return false;
  }
  try {
    // The marker is the durable half of this call. Deleting `auth:session:*`
    // leaves nothing behind to point at, so a reader that cached the identity
    // before the revoke has no way to learn it happened if the second delete
    // (session:cache, fire-and-forget on the auth path) never lands. One
    // positive key that outlives the identity cache's TTL makes the revocation
    // readable instead of merely remembered.
    const multi = redis.multi();
    multi.del(SESSION_KEY(sessionId));
    multi.set(REVOKED_KEY(sessionId), '1', 'EX', Math.ceil(REVOKED_MARK_TTL_MS / 1000));
    await multi.exec();
  } catch {
    /* fall through to fallback */
  }
  const fallback = (globalThis as any).__authSessionState as Map<string, SessionState> | undefined;
  if (fallback?.has(sessionId)) {
    const st = fallback.get(sessionId);
    st!.revoked = true;
    st!.revokedAt = Date.now();
    fallback.set(sessionId, st as SessionState);
  }
  return true;
}

export async function markRefreshSpent(hash: string, sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    // No Redis: persist to Postgres. session.ts calls isRefreshSpent BEFORE
    // marking, so a genuine replay is caught there; this write just records the
    // spend. An existing row (same token rotated twice) is the theft signature —
    // upsert keeps it idempotent. Guarded: a missing table falls back to the
    // old silent false.
    try {
      const { prisma } = await import('@/infrastructure/db/prisma');
      await prisma.refreshTokenSpent.upsert({
        where: { tokenHash: hash },
        update: {},
        create: { tokenHash: hash, sessionId },
      });
      return true;
    } catch {
      return false;
    }
  }
  try {
    const key = SPENT_KEY(hash);
    await redis.setex(key, Math.ceil(REFRESH_TTL_MS / 1000), sessionId);
    return true;
  } catch {
    return false;
  }
}

export async function isRefreshSpent(hash: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) {
    try {
      const { prisma } = await import('@/infrastructure/db/prisma');
      const row = await prisma.refreshTokenSpent.findUnique({ where: { tokenHash: hash }, select: { sessionId: true } });
      return row?.sessionId ?? null;
    } catch {
      return null;
    }
  }
  try {
    return await redis.get(SPENT_KEY(hash));
  } catch {
    return null;
  }
}

// ─── Session identity cache (survives serverless cold starts) ───
// The in-memory sessionCache in auth/session.ts is lost whenever a serverless
// function spins up a fresh instance, which means every cold request falls
// through to the DB and saturates the connection pool (observed 3–11s
// latencies on /api/users/me and the /api/security/* endpoints). This Redis
// cache is the shared, cross-instance layer so getSession is a ~1–3ms hit
// after the first lookup per session, instead of a pooled DB round-trip.
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_CACHE_KEY = (sid: string) => `session:cache:${sid}`;

type SessionIdentity = { userId: string; email: string; sessionId: string; adminRole: string | null };

/** The identity cache plus the revocation veto, in one round trip.
 *
 *  Returning `null` means "learn nothing here, ask the database", which is what
 *  every failure mode wants: no Redis, a stalled Redis, an expired entry, a
 *  malformed value. Only a `{ identity, revoked: false }` is an answer. */
export async function readCachedSessionIdentity(sid: string):
  Promise<{ identity: SessionIdentity; revoked: boolean } | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const [cached, mark] = await redis.mget(SESSION_CACHE_KEY(sid), REVOKED_KEY(sid));
    if (!cached) return null;
    return { identity: JSON.parse(cached) as SessionIdentity, revoked: mark === '1' };
  } catch {
    return null;
  }
}

export async function setCachedSessionIdentity(sid: string, identity: SessionIdentity): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.setex(SESSION_CACHE_KEY(sid), Math.ceil(SESSION_CACHE_TTL_MS / 1000), JSON.stringify(identity));
  } catch {
    /* ignore cache write failures */
  }
}

export async function deleteCachedSessionIdentity(sid: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(SESSION_CACHE_KEY(sid));
  } catch {
    /* ignore */
  }
}

// ─── Profile read cache (shared with the myprofile service) ───
// apps/myprofile answers a profile read from Redis before it pays an HTTP hop
// or a pooled DB read — it only ever *reads* `profile:cache:<userId>`. The
// main API is the brain and the sole writer of that key, so every place the
// in-memory profileCache is populated must also warm Redis, and bustProfileCache
// must clear it. The stored shape is buildProfilePayload()'s result, a superset
// of the wire row myprofile normalises. Short TTL keeps a lost invalidation
// bounded; a miss simply falls through to the DB/HTTP path.
const PROFILE_CACHE_TTL_MS = 30_000;
const PROFILE_CACHE_KEY = (userId: string) => `profile:cache:${userId}`;

export async function setCachedProfile(userId: string, data: unknown): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.setex(PROFILE_CACHE_KEY(userId), Math.ceil(PROFILE_CACHE_TTL_MS / 1000), JSON.stringify(data));
  } catch {
    /* ignore cache write failures */
  }
}

export async function deleteCachedProfile(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(PROFILE_CACHE_KEY(userId));
    // Tell any subscriber the row changed, so a warm copy is dropped now, not at TTL.
    await redis.publish('profile:changed', userId);
  } catch {
    /* ignore */
  }
}

export const REFRESH_TOKEN_BYTES = 32;

export function generateRefreshToken(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(REFRESH_TOKEN_BYTES);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }
  const nodeCrypto = require('crypto');
  return nodeCrypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export async function hashRefreshToken(token: string): Promise<string> {
  const nodeCrypto = require('crypto');
  return nodeCrypto.createHash('sha256').update(token).digest('hex');
}

function base64url(bytes: Uint8Array): string {
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return Buffer.from(bin, 'binary').toString('base64url');
}
