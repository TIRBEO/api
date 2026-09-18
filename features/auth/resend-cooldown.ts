// ═══ RESEND COOLDOWN (Redis-first, DB fallback) ═══
// The 30s "please wait between sends" gate + 5-per-15min attempt window used
// to cost 2 awaited DB round-trips per request (Cooldown findUnique + create/
// update). Now: one atomic Redis Lua script (single round-trip, ~1-3ms), with
// the DB Cooldown row kept as a durable fallback when Redis is unavailable
// (and mirrored best-effort so DB-backed admin views stay roughly accurate).
//
// All keys are email-scoped, so the cooldown holds across incognito, other
// browsers, and other devices.

import { prisma } from '@/infrastructure/db/prisma';
import { getRedis } from '@/features/auth/redis';

const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const TTL_HOURS = 24;

// ─── Redis Lua: one round-trip for the whole decision ───
// KEYS[1] = state hash, ARGV: nowMs, cooldownMs, windowMs, maxAttempts, ttlMs
// State hash fields: c (attempts in window), ws (windowStart), ls (lastSent)
const COOLDOWN_LUA = `
local now     = tonumber(ARGV[1])
local cdMs    = tonumber(ARGV[2])
local winMs   = tonumber(ARGV[3])
local maxA    = tonumber(ARGV[4])
local ttlMs   = tonumber(ARGV[5])

local c  = tonumber(redis.call('HGET', KEYS[1], 'c')  or '0')
local ws = tonumber(redis.call('HGET', KEYS[1], 'ws') or '0')
local ls = tonumber(redis.call('HGET', KEYS[1], 'ls') or '0')

-- window expired → reset
if ws > 0 and (now - ws) >= winMs then c = 0; ws = 0 end

-- attempts exhausted for this window → hard block
if ws > 0 and c >= maxA then
  return {0, winMs - (now - ws), 'window'}
end

-- per-send cooldown → soft block
if ls > 0 and (now - ls) < cdMs then
  return {0, cdMs - (now - ls), 'cooldown'}
end

-- allowed: bump counters
local newC = c + 1
local newWs = ws
if newWs == 0 then newWs = now end
redis.call('HSET', KEYS[1], 'c', newC, 'ws', newWs, 'ls', now)
redis.call('PEXPIRE', KEYS[1], ttlMs)
return {1, 0, ''}
`;

const g = globalThis as any;
function redisClient(): any {
  try {
    return getRedis() || null;
  } catch {
    return null;
  }
}

function cooldownRedisKey(key: string): string {
  return `resend-cd:${key}`;
}

/**
 * Enforce the resend cooldown for `key` (e.g. `magic-link:user@x.com`).
 * Returns { allowed, remainingMs } — same contract as before.
 */
export async function enforceResendCooldown(
  key: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<{ allowed: boolean; remainingMs: number }> {
  const now = Date.now();
  const rKey = cooldownRedisKey(key);

  // 1. Redis-first: one atomic round-trip decides.
  const redis = redisClient();
  if (redis) {
    try {
      const [allowed, remain, kind] = (await redis.eval(
        COOLDOWN_LUA, 1, rKey,
        now, cooldownMs, ATTEMPT_WINDOW_MS, MAX_ATTEMPTS_PER_WINDOW,
        TTL_HOURS * 3600 * 1000,
      )) as [number, number, string];
      const remainingMs = Math.max(0, Number(remain));
      if (!allowed) {
        // Mirror the block decision into the DB so admin/DB views stay close.
        mirrorToDb(key, kind === 'window' ? 'window' : 'cooldown').catch(() => {});
        return { allowed: false, remainingMs };
      }
      // Mirror the allowed consume best-effort (non-blocking).
      mirrorToDb(key, 'allow', cooldownMs).catch(() => {});
      return { allowed: true, remainingMs: 0 };
    } catch {
      // Redis error → fall through to DB path.
    }
  }

  // 2. DB fallback (original logic, unchanged semantics).
  return enforceResendCooldownDb(key, cooldownMs);
}

/** Best-effort DB mirror so the Cooldown table stays useful for admins. */
async function mirrorToDb(key: string, kind: 'allow' | 'window' | 'cooldown', cooldownMs = DEFAULT_COOLDOWN_MS): Promise<void> {
  try {
    const now = new Date();
    const existing = await prisma.cooldown.findUnique({ where: { key } }).catch(() => null);
    if (!existing) {
      await prisma.cooldown.create({
        data: { key, lastSent: kind === 'allow' ? now : new Date(0), count: kind === 'allow' ? 1 : MAX_ATTEMPTS_PER_WINDOW, windowStart: now, expiresAt: new Date(now.getTime() + TTL_HOURS * 3600 * 1000) },
      }).catch(() => {});
      return;
    }
    if (kind === 'allow') {
      const windowExpired = now.getTime() - existing.windowStart.getTime() >= ATTEMPT_WINDOW_MS;
      await prisma.cooldown.update({
        where: { key },
        data: {
          count: windowExpired ? 1 : { increment: 1 },
          windowStart: windowExpired ? now : existing.windowStart,
          lastSent: now,
          expiresAt: new Date(now.getTime() + TTL_HOURS * 3600 * 1000),
        },
      }).catch(() => {});
    } else if (kind === 'window') {
      // Attempt window exhausted in Redis — reflect it in the DB for reads.
      await prisma.cooldown.update({
        where: { key },
        data: { count: MAX_ATTEMPTS_PER_WINDOW, expiresAt: new Date(now.getTime() + TTL_HOURS * 3600 * 1000) },
      }).catch(() => {});
    }
    // 'cooldown' blocks are transient (30s) — no DB mirror needed.
  } catch {}
}

/** Original DB-only path, used when Redis is unavailable. */
async function enforceResendCooldownDb(
  key: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
): Promise<{ allowed: boolean; remainingMs: number }> {
  const now = new Date();
  const nowMs = now.getTime();

  const existing = await prisma.cooldown.findUnique({ where: { key } }).catch(() => null);

  if (!existing) {
    await prisma.cooldown.create({
      data: { key, lastSent: now, count: 1, windowStart: now, expiresAt: new Date(nowMs + TTL_HOURS * 3600 * 1000) },
    }).catch(() => {});
    return { allowed: true, remainingMs: 0 };
  }

  if (nowMs - existing.windowStart.getTime() >= ATTEMPT_WINDOW_MS) {
    await prisma.cooldown.update({
      where: { key },
      data: { count: 1, windowStart: now, lastSent: now, expiresAt: new Date(nowMs + TTL_HOURS * 3600 * 1000) },
    }).catch(() => {});
    return { allowed: true, remainingMs: 0 };
  }

  if (existing.count >= MAX_ATTEMPTS_PER_WINDOW) {
    const remainingMs = Math.max(0, ATTEMPT_WINDOW_MS - (nowMs - existing.windowStart.getTime()));
    return { allowed: false, remainingMs };
  }

  if (nowMs - existing.lastSent.getTime() < cooldownMs) {
    return { allowed: false, remainingMs: cooldownMs - (nowMs - existing.lastSent.getTime()) };
  }

  await prisma.cooldown.update({
    where: { key },
    data: { count: { increment: 1 }, lastSent: now, expiresAt: new Date(nowMs + TTL_HOURS * 3600 * 1000) },
  }).catch(() => {});

  return { allowed: true, remainingMs: 0 };
}

export async function getRemainingAttempts(key: string): Promise<{ remaining: number; resetsInMs: number }> {
  const now = Date.now();
  const rKey = cooldownRedisKey(key);

  // Redis-first read.
  const redis = redisClient();
  if (redis) {
    try {
      const [c, ws, ls] = (await Promise.all([
        redis.hget(rKey, 'c'),
        redis.hget(rKey, 'ws'),
        redis.hget(rKey, 'ls'),
      ])) as [string | null, string | null, string | null];
      const count = parseInt(c || '0', 10);
      const windowStart = parseInt(ws || '0', 10);
      const lastSent = parseInt(ls || '0', 10);
      if (count > 0 || windowStart > 0) {
        const windowExpired = windowStart > 0 && now - windowStart >= ATTEMPT_WINDOW_MS;
        if (!windowExpired) {
          const remaining = Math.max(0, MAX_ATTEMPTS_PER_WINDOW - count);
          const resetsInMs = Math.max(0, ATTEMPT_WINDOW_MS - (now - windowStart));
          const cooldownRemaining = lastSent > 0 ? Math.max(0, DEFAULT_COOLDOWN_MS - (now - lastSent)) : 0;
          if (remaining === 0) return { remaining: 0, resetsInMs };
          return {
            remaining: Math.min(remaining, cooldownRemaining > 0 ? 1 : remaining),
            resetsInMs: Math.max(resetsInMs, cooldownRemaining),
          };
        }
      }
    } catch {
      // fall through to DB
    }
  }

  // DB fallback (original logic).
  const nowD = new Date();
  const cd = await prisma.cooldown.findUnique({ where: { key } }).catch(() => null);

  if (!cd || nowD.getTime() - cd.windowStart.getTime() >= ATTEMPT_WINDOW_MS) {
    return { remaining: MAX_ATTEMPTS_PER_WINDOW, resetsInMs: 0 };
  }

  const remaining = Math.max(0, MAX_ATTEMPTS_PER_WINDOW - cd.count);
  const resetsInMs = Math.max(0, ATTEMPT_WINDOW_MS - (nowD.getTime() - cd.windowStart.getTime()));

  if (remaining === 0 && resetsInMs > 0) {
    return { remaining: 0, resetsInMs };
  }

  const cooldownRemaining = Math.max(0, DEFAULT_COOLDOWN_MS - (nowD.getTime() - cd.lastSent.getTime()));
  return { remaining: Math.min(remaining, cooldownRemaining > 0 ? 1 : remaining), resetsInMs: Math.max(resetsInMs, cooldownRemaining) };
}

export async function cleanupExpiredCooldowns(): Promise<void> {
  try {
    await prisma.cooldown.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    }).catch(() => {});
  } catch {}
}
