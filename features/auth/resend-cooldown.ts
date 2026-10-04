// ═══ RESEND COOLDOWN (Redis-only) ═══
// The 30s "please wait between sends" gate + 5-per-15min attempt window is
// one atomic Redis Lua script (single round-trip, ~1-3ms). The durable DB
// mirror was dropped with the consolidated schema (no cooldowns table); when
// Redis is unavailable the gate fails open — the per-flow verify-limits and
// risk checks still apply.
//
// All keys are email-scoped, so the cooldown holds across incognito, other
// browsers, and other devices.

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
      const [allowed, remain] = (await redis.eval(
        COOLDOWN_LUA, 1, rKey,
        now, cooldownMs, ATTEMPT_WINDOW_MS, MAX_ATTEMPTS_PER_WINDOW,
        TTL_HOURS * 3600 * 1000,
      )) as [number, number, string];
      const remainingMs = Math.max(0, Number(remain));
      if (!allowed) return { allowed: false, remainingMs };
      return { allowed: true, remainingMs: 0 };
    } catch {
      // Redis error → fail open.
    }
  }

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
            resetsInMs: Math.max(resetsInMs, cooldownRemaining) };
        }
      }
    } catch {}
  }

  return { remaining: MAX_ATTEMPTS_PER_WINDOW, resetsInMs: 0 };
}

export async function cleanupExpiredCooldowns(): Promise<void> {
  // Redis keys self-expire (PEXPIRE in the Lua script); nothing to sweep.
}
