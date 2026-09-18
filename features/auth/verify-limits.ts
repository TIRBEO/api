// ═══ AUTH VERIFY LIMITS (Redis-first, in-memory mirror, DB-configured maxes) ═══
// The auth hot path used to run 4 serial checkWindowLimitDB() calls per request:
// each did a VerificationLimit lookup (30s cache), a blocklist findUnique, an
// in-memory INCR, then a fire-and-forget securityEvent.create → a JSONB insert
// per attempt, and /api/auth/remaining counted those rows back with
// securityEvent.count (JSONB path scans, hundreds of ms each).
//
// This module replaces that with:
//   1. Redis fixed-window counters (single round-trip, atomic Lua INCR+EXPIRE)
//      — shared across all instances, so limits hold in incognito/any browser.
//   2. An in-memory mirror of the same counters: when a window is ALREADY
//      exhausted, rejected requests are answered from process memory without
//      touching Redis at all (the "hot reject" path).
//   3. Memory-only fallback when Redis is unavailable. Maxes always come from
//      the VerificationLimit table (30s cache) so admins can tune limits
//      without a deploy.
//
// Window shape is fixed (15 min, matching the previous behavior) so the
// remaining endpoint and the send handlers agree on one source of truth.

import { prisma } from '@/infrastructure/db/prisma';
import { getRedis } from '@/features/auth/redis';

export const VERIFY_WINDOW_MS = 15 * 60 * 1000;

/** DB-configurable maxes (VerificationLimit table) — cached 30s. */
const DEFAULT_MAXES: Record<string, number> = {
  'login-otp': 5,
  'magic-link': 3,
  'otp': 5,
  'recovery': 5,
  'signup-otp': 5,
  'global-email': 5,
  'global-ip': 20,
};

const g = globalThis as any;

// ─── VerificationLimit cache (30s) ───
if (!g.__verifyLimitConfigCache) g.__verifyLimitConfigCache = new Map<string, { max: number; exp: number }>();
const limitCache: Map<string, { max: number; exp: number }> = g.__verifyLimitConfigCache;

export async function getVerifyMax(method: string): Promise<number> {
  const fallback = DEFAULT_MAXES[method] ?? 3;
  const cached = limitCache.get(method);
  if (cached && cached.exp > Date.now()) return cached.max;
  try {
    const row = await (prisma as any).verificationLimit.findUnique({ where: { method } }).catch(() => null);
    const max = row && typeof row.max === 'number' && row.max > 0 ? row.max : fallback;
    limitCache.set(method, { max, exp: Date.now() + 30_000 });
    return max;
  } catch {
    return fallback;
  }
}

export async function getAllVerifyMaxes(): Promise<Record<string, number>> {
  const methods = Object.keys(DEFAULT_MAXES);
  const maxes = await Promise.all(methods.map((m) => getVerifyMax(m)));
  return Object.fromEntries(methods.map((m, i) => [m, maxes[i]]));
}

// ─── In-memory mirror (hot-reject fast path + Redis outage fallback) ───
// Keyed identically to Redis (including the window bucket), so a mirror entry
// always corresponds to the same Redis counter.
if (!g.__verifyLimitMemory) g.__verifyLimitMemory = new Map<string, { count: number; reset: number }>();
const memory: Map<string, { count: number; reset: number }> = g.__verifyLimitMemory;

function pruneMemory(now: number) {
  if (memory.size < 4000) return;
  for (const [k, v] of memory) if (now > v.reset) memory.delete(k);
}

// ─── Redis client (shared auth connection; ioredis) ───
function redisClient(): any {
  try {
    return getRedis() || null;
  } catch {
    return null;
  }
}

// Single round-trip fixed window: INCR, PEXPIRE on first hit, re-arm if a TTL
// went missing. Returns [count, pttlMs].
const CONSUME_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}
`;

// Read-only variant for status checks (no counter bump).
const PEEK_LUA = `
local c = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {tonumber(c or '0'), ttl}
`;

/**
 * Bucket key: fixed window anchored to epoch, so all instances agree on the
 * same bucket boundaries without coordination.
 */
function bucketKey(method: string, scope: 'email' | 'ip' | 'global', id: string): string {
  const bucket = Math.floor(Date.now() / VERIFY_WINDOW_MS);
  return `vl:${method}:${scope}:${id}:${bucket}`;
}

function resetFromTtl(now: number, ttlMs: number): number {
  return now + (ttlMs > 0 ? ttlMs : VERIFY_WINDOW_MS);
}

/** Epoch ms when the current fixed window of `windowMs` resets. */
export function windowResetAt(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs + windowMs;
}

export interface VerifyLimitResult {
  ok: boolean;
  /** Which constraint was exceeded: the method itself or 'global-email'. */
  exceeded?: string;
  used: number;
  remaining: number;
  max: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/** Resolve ok/remaining/exceeded from the method + global-email counters. */
function buildResult(
  method: string,
  max: number,
  globalMax: number,
  mCount: number,
  gCount: number,
  mReset: number,
  gReset: number,
): VerifyLimitResult {
  if (mCount > max) {
    return { ok: false, exceeded: method, used: mCount, remaining: 0, max, resetAt: mReset };
  }
  if (gCount > globalMax) {
    return { ok: false, exceeded: 'global-email', used: gCount, remaining: 0, max: globalMax, resetAt: gReset };
  }
  return {
    ok: true,
    used: mCount,
    remaining: Math.max(0, Math.min(max - mCount, globalMax - gCount)),
    max,
    resetAt: mReset,
  };
}

/**
 * Consume one attempt for `method` against BOTH its per-email counter and the
 * global-email counter. Returns the first exceeded constraint (most specific
 * first), or ok when both have capacity.
 *
 * Hot path: when the in-memory mirror already shows the window exhausted, the
 * result is returned WITHOUT touching Redis.
 */
export async function consumeVerifyAttempt(
  method: string,
  email: string,
  _ip?: string,
): Promise<VerifyLimitResult> {
  const now = Date.now();
  pruneMemory(now);

  const [max, globalMax] = await Promise.all([getVerifyMax(method), getVerifyMax('global-email')]);
  const mKey = bucketKey(method, 'email', email);
  const gKey = bucketKey('global-email', 'email', email);

  // 1. Fast reject from the in-memory mirror — no Redis round-trip.
  const mMem = memory.get(mKey);
  const gMem = memory.get(gKey);
  const mMemExceeded = !!mMem && mMem.count > max && now < mMem.reset;
  const gMemExceeded = !!gMem && gMem.count > globalMax && now < gMem.reset;
  if (mMemExceeded || gMemExceeded) {
    if (mMemExceeded && mMem) {
      return { ok: false, exceeded: method, used: mMem.count, remaining: 0, max, resetAt: mMem.reset };
    }
    return {
      ok: false,
      exceeded: 'global-email',
      used: gMem!.count,
      remaining: 0,
      max: globalMax,
      resetAt: gMem!.reset,
    };
  }

  // 2. Redis authoritative consume (two atomic Lua calls in parallel).
  const redis = redisClient();
  if (redis) {
    try {
      const [[mCount, mTtl], [gCount, gTtl]] = (await Promise.all([
        redis.eval(CONSUME_LUA, 1, mKey, VERIFY_WINDOW_MS),
        redis.eval(CONSUME_LUA, 1, gKey, VERIFY_WINDOW_MS),
      ])) as [[number, number], [number, number]];

      const mReset = resetFromTtl(now, mTtl);
      const gReset = resetFromTtl(now, gTtl);
      memory.set(mKey, { count: mCount, reset: mReset });
      memory.set(gKey, { count: gCount, reset: gReset });
      return buildResult(method, max, globalMax, Number(mCount), Number(gCount), mReset, gReset);
    } catch {
      // Redis error → fall through to memory-only mode.
    }
  }

  // 3. Redis unavailable → per-instance memory counters.
  const m2 = memory.get(mKey) || { count: 0, reset: now + VERIFY_WINDOW_MS };
  const g2 = memory.get(gKey) || { count: 0, reset: now + VERIFY_WINDOW_MS };
  if (now > m2.reset) { m2.count = 0; m2.reset = now + VERIFY_WINDOW_MS; }
  if (now > g2.reset) { g2.count = 0; g2.reset = now + VERIFY_WINDOW_MS; }
  m2.count += 1;
  g2.count += 1;
  memory.set(mKey, m2);
  memory.set(gKey, g2);
  return buildResult(method, max, globalMax, m2.count, g2.count, m2.reset, g2.reset);
}

/**
 * Read-only status for a method + email (no consume). Mirror first — but when
 * the mirror has no live entry (fresh process / expired bucket) peek Redis and
 * repopulate the mirror, so status polls after a cold start are correct.
 */
export async function getVerifyStatus(
  method: string,
  email: string,
): Promise<VerifyLimitResult> {
  const now = Date.now();
  const [max, globalMax] = await Promise.all([getVerifyMax(method), getVerifyMax('global-email')]);
  const mKey = bucketKey(method, 'email', email);
  const gKey = bucketKey('global-email', 'email', email);

  const mMem = memory.get(mKey);
  const gMem = memory.get(gKey);
  const mirrorLive = !!mMem && now <= mMem.reset && !!gMem && now <= gMem.reset;

  if (!mirrorLive) {
    const redis = redisClient();
    if (redis) {
      try {
        const [[mCount, mTtl], [gCount, gTtl]] = (await Promise.all([
          redis.eval(PEEK_LUA, 1, mKey, VERIFY_WINDOW_MS),
          redis.eval(PEEK_LUA, 1, gKey, VERIFY_WINDOW_MS),
        ])) as [[number, number], [number, number]];

        const mReset = resetFromTtl(now, mTtl);
        const gReset = resetFromTtl(now, gTtl);
        memory.set(mKey, { count: Number(mCount), reset: mReset });
        memory.set(gKey, { count: Number(gCount), reset: gReset });
        return buildResult(method, max, globalMax, Number(mCount), Number(gCount), mReset, gReset);
      } catch {
        // Redis error → fall through to mirror-only.
      }
    }
  }

  const mCount = mMem && now <= mMem.reset ? mMem.count : 0;
  const gCount = gMem && now <= gMem.reset ? gMem.count : 0;
  const mReset = mMem && now <= mMem.reset ? mMem.reset : now + VERIFY_WINDOW_MS;
  const gReset = gMem && now <= gMem.reset ? gMem.reset : now + VERIFY_WINDOW_MS;
  return buildResult(method, max, globalMax, mCount, gCount, mReset, gReset);
}

/** Read-only status for the global-email counter alone. */
export async function getGlobalEmailStatus(email: string): Promise<VerifyLimitResult> {
  const now = Date.now();
  const globalMax = await getVerifyMax('global-email');
  const gKey = bucketKey('global-email', 'email', email);
  const gMem = memory.get(gKey);
  if (gMem && now <= gMem.reset) {
    return buildResult('global-email', globalMax, globalMax, gMem.count, gMem.count, gMem.reset, gMem.reset);
  }
  const redis = redisClient();
  if (redis) {
    try {
      const [gCount, gTtl] = (await redis.eval(PEEK_LUA, 1, gKey, VERIFY_WINDOW_MS)) as [number, number];
      const gReset = resetFromTtl(now, gTtl);
      memory.set(gKey, { count: Number(gCount), reset: gReset });
      return buildResult('global-email', globalMax, globalMax, Number(gCount), Number(gCount), gReset, gReset);
    } catch {
      // fall through
    }
  }
  return buildResult('global-email', globalMax, globalMax, 0, 0, now + VERIFY_WINDOW_MS, now + VERIFY_WINDOW_MS);
}

// ─── Generic keyed windows (for checkWindowLimitDB delegation) ───
// Same machinery, arbitrary key + window. Used by callers that enforce keyed
// limits (ip:, user:, oauth-cb:, …) outside the method+email model.

export interface GenericWindowResult {
  ok: boolean;
  used: number;
  remaining: number;
  max: number;
  resetAt: number;
}

function genericKey(key: string, windowMs: number): string {
  const bucket = Math.floor(Date.now() / windowMs);
  return `vlw:${key}:${bucket}`;
}

function buildGeneric(key: string, max: number, count: number, resetAt: number): GenericWindowResult {
  return {
    ok: count <= max,
    used: count,
    remaining: Math.max(0, max - count),
    max,
    resetAt,
  };
}

/**
 * Consume one hit on an arbitrary window key. In-memory mirror answers
 * already-exhausted windows without touching Redis; Redis is authoritative
 * otherwise; memory-only when Redis is unavailable.
 */
export async function consumeGenericWindow(
  key: string,
  max: number,
  windowMs: number,
): Promise<GenericWindowResult> {
  const now = Date.now();
  pruneMemory(now);
  const rKey = genericKey(key, windowMs);

  const mem = memory.get(rKey);
  if (mem && mem.count > max && now < mem.reset) {
    return buildGeneric(key, max, mem.count, mem.reset);
  }

  const redis = redisClient();
  if (redis) {
    try {
      const [count, ttl] = (await redis.eval(CONSUME_LUA, 1, rKey, windowMs)) as [number, number];
      const resetAt = resetFromTtl(now, Number(ttl));
      memory.set(rKey, { count: Number(count), reset: resetAt });
      return buildGeneric(key, max, Number(count), resetAt);
    } catch {
      // fall through to memory-only
    }
  }

  const m2 = mem && now <= mem.reset ? mem : { count: 0, reset: now + windowMs };
  if (now > m2.reset) { m2.count = 0; m2.reset = now + windowMs; }
  m2.count += 1;
  memory.set(rKey, m2);
  return buildGeneric(key, max, m2.count, m2.reset);
}

/** Read-only status of an arbitrary window key (mirror → Redis). */
export async function peekGenericWindow(
  key: string,
  max: number,
  windowMs: number,
): Promise<GenericWindowResult> {
  const now = Date.now();
  const rKey = genericKey(key, windowMs);
  const mem = memory.get(rKey);
  if (mem && now <= mem.reset) {
    return buildGeneric(key, max, mem.count, mem.reset);
  }
  const redis = redisClient();
  if (redis) {
    try {
      const [count, ttl] = (await redis.eval(PEEK_LUA, 1, rKey, windowMs)) as [number, number];
      const resetAt = resetFromTtl(now, Number(ttl));
      memory.set(rKey, { count: Number(count), reset: resetAt });
      return buildGeneric(key, max, Number(count), resetAt);
    } catch {
      // fall through
    }
  }
  return buildGeneric(key, max, 0, now + windowMs);
}
