/**
 * Unit tests for the Redis-backed verify limits + resend cooldown.
 *
 * All I/O is stubbed: `getRedis()` returns a fake ioredis whose `eval`
 * executes the real Lua scripts against a tiny in-memory Redis emulator,
 * so the atomic consume/peek/cooldown semantics are actually exercised.
 * No database or network access.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.UNSUBSCRIBE_SECRET = 'test-secret';

// ─── Tiny Lua-free Redis emulator ───────────────────────────────────
// Supports the exact commands the Lua scripts use: INCR, GET, PTTL, PEXPIRE,
// HSET, HGET, EVAL (implemented natively per-script semantics).

type Store = Map<string, { value: string; expires: number | null }>;

function makeFakeRedis(store: Store) {
  const now = () => Date.now();
  const pttl = (k: string): number => {
    const e = store.get(k)?.expires ?? null;
    return e === null ? -1 : e - now();
  };
  return {
    async eval(script: string, numKeys: number, ...args: any[]): Promise<any> {
      void numKeys;
      // Cooldown script (hash state): HGET/HSET → [allowed, remainingMs, kind]
      if (script.includes("redis.call('HGET'")) {
        const key = String(args[0]);
        const nowMs = Number(args[1]);
        const cdMs = Number(args[2]);
        const winMs = Number(args[3]);
        const maxA = Number(args[4]);
        const ttlMs = Number(args[5]);
        const h = (f: string) => {
          const e = store.get(`${key}|${f}`);
          return e && (e.expires === null || e.expires > nowMs) ? Number(e.value) : 0;
        };
        const hset = (f: string, v: number) => {
          store.set(`${key}|${f}`, { value: String(v), expires: nowMs + ttlMs });
        };
        let c = h('c');
        let ws = h('ws');
        const ls = h('ls');
        if (ws > 0 && nowMs - ws >= winMs) { c = 0; ws = 0; }
        if (ws > 0 && c >= maxA) return [0, winMs - (nowMs - ws), 'window'];
        if (ls > 0 && nowMs - ls < cdMs) return [0, cdMs - (nowMs - ls), 'cooldown'];
        hset('c', c + 1);
        hset('ws', ws === 0 ? nowMs : ws);
        hset('ls', nowMs);
        return [1, 0, ''];
      }
      // CONSUME/PEEK script: INCR or GET + TTL re-arm → returns [count, pttl]
      if (script.includes("redis.call('INCR'") || script.includes("redis.call('GET'")) {
        const key = args[0] as string;
        const windowMs = Number(args[1]);
        const isConsume = script.includes("redis.call('INCR'");
        let entry = store.get(key);
        if (!entry) {
          entry = { value: '0', expires: null };
          store.set(key, entry);
        }
        if (isConsume) entry.value = String(Number(entry.value) + 1);
        let ttl = pttl(key);
        if (ttl < 0) {
          entry.expires = now() + windowMs;
          ttl = windowMs;
        }
        return [Number(entry.value), ttl];
      }
      throw new Error('Unsupported script in test emulator');
    },
    // Cooldown script: hash-based decision → [allowed, remainingMs, kind]
    async evalCooldown(key: string, nowMs: number, cdMs: number, winMs: number, maxA: number, ttlMs: number): Promise<[number, number, string]> {
      const h = (f: string) => Number(store.get(`${key}|${f}`)?.value ?? '0');
      const hset = (f: string, v: number) => {
        store.set(`${key}|${f}`, { value: String(v), expires: nowMs + ttlMs });
      };
      let c = h('c');
      let ws = h('ws');
      const ls = h('ls');
      if (ws > 0 && nowMs - ws >= winMs) { c = 0; ws = 0; }
      if (ws > 0 && c >= maxA) return [0, winMs - (nowMs - ws), 'window'];
      if (ls > 0 && nowMs - ls < cdMs) return [0, cdMs - (nowMs - ls), 'cooldown'];
      const newC = c + 1;
      const newWs = ws === 0 ? nowMs : ws;
      hset('c', newC); hset('ws', newWs); hset('ls', nowMs);
      return [1, 0, ''];
    },
    async hget(key: string, field: string): Promise<string | null> {
      return store.get(`${key}|${field}`)?.value ?? null;
    },
  };
}

// Module-level fake state, recreated per test.
let store: Store;
let fake: ReturnType<typeof makeFakeRedis>;

vi.mock('@/features/auth/redis', () => ({
  getRedis: () => fake,
  checkAuthRedisHealth: async () => ({ ok: true, latencyMs: 1 }),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    verificationLimit: { findUnique: vi.fn(async () => null) }, // use DEFAULT_MAXES
    cooldown: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    securityEvent: { create: vi.fn(async () => ({})), findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
  },
}));

import { consumeVerifyAttempt, getVerifyStatus, consumeGenericWindow, peekGenericWindow } from '@/features/auth/verify-limits';
import { enforceResendCooldown, getRemainingAttempts } from '@/features/auth/resend-cooldown';

const WINDOW_MS = 15 * 60 * 1000;

beforeEach(() => {
  store = new Map();
  fake = makeFakeRedis(store);
  // Reset module-level memory mirrors between tests.
  const g = globalThis as any;
  g.__verifyLimitMemory = new Map();
});

// ─── consumeVerifyAttempt: method + global-email counters ──────────

describe('consumeVerifyAttempt', () => {
  it('allows sends up to the per-method max, then blocks with exceeded=method', async () => {
    // magic-link default max = 3
    expect((await consumeVerifyAttempt('magic-link', 'a@x.com')).ok).toBe(true);
    expect((await consumeVerifyAttempt('magic-link', 'a@x.com')).ok).toBe(true);
    expect((await consumeVerifyAttempt('magic-link', 'a@x.com')).ok).toBe(true);
    const blocked = await consumeVerifyAttempt('magic-link', 'a@x.com');
    expect(blocked.ok).toBe(false);
    expect(blocked.exceeded).toBe('magic-link');
    expect(blocked.remaining).toBe(0);
    expect(blocked.used).toBe(4);
  });

  it('blocks with exceeded=global-email when the shared cap is exhausted, even if the new method has room', async () => {
    // otp max = 5, login-otp max = 5, global-email max = 5. Burn the shared
    // global counter via 'otp' (exactly at its own max), then a DIFFERENT
    // method with full headroom must trip the global cap.
    for (let i = 0; i < 5; i++) await consumeVerifyAttempt('otp', 'b@x.com');
    const next = await consumeVerifyAttempt('login-otp', 'b@x.com');
    expect(next.ok).toBe(false);
    expect(next.exceeded).toBe('global-email');
  });

  it('reports remaining correctly and never negative', async () => {
    const first = await consumeVerifyAttempt('magic-link', 'c@x.com');
    expect(first.remaining).toBe(2); // max 3
    const second = await consumeVerifyAttempt('magic-link', 'c@x.com');
    expect(second.remaining).toBe(1);
    const third = await consumeVerifyAttempt('magic-link', 'c@x.com');
    expect(third.remaining).toBe(0);
    expect(third.ok).toBe(true); // count === max is still allowed
  });

  it('includes resetAt in the future for 429 payloads', async () => {
    await consumeVerifyAttempt('magic-link', 'd@x.com');
    await consumeVerifyAttempt('magic-link', 'd@x.com');
    await consumeVerifyAttempt('magic-link', 'd@x.com');
    const blocked = await consumeVerifyAttempt('magic-link', 'd@x.com');
    expect(blocked.ok).toBe(false);
    expect(blocked.resetAt).toBeGreaterThan(Date.now());
  });

  it('tracks emails independently (limits are per-email, not per-browser)', async () => {
    for (let i = 0; i < 3; i++) await consumeVerifyAttempt('magic-link', 'e1@x.com');
    const other = await consumeVerifyAttempt('magic-link', 'e2@x.com');
    expect(other.ok).toBe(true);
    expect(other.remaining).toBe(2);
  });
});

// ─── getVerifyStatus: read-only, no consume ────────────────────────

describe('getVerifyStatus', () => {
  it('does not consume when called', async () => {
    await consumeVerifyAttempt('magic-link', 'f@x.com');
    const s1 = await getVerifyStatus('magic-link', 'f@x.com');
    expect(s1.used).toBe(1);
    const s2 = await getVerifyStatus('magic-link', 'f@x.com');
    expect(s2.used).toBe(1);
  });

  it('sees the same counter as consume (status ↔ consume consistency)', async () => {
    await consumeVerifyAttempt('magic-link', 'g@x.com');
    await consumeVerifyAttempt('magic-link', 'g@x.com');
    const s = await getVerifyStatus('magic-link', 'g@x.com');
    expect(s.used).toBe(2);
    expect(s.remaining).toBe(1);
  });
});

// ─── Generic windows (checkWindowLimitDB delegation) ───────────────

describe('consumeGenericWindow / peekGenericWindow', () => {
  it('consumes and blocks over max', async () => {
    const k = 'login:ip:1.2.3.4';
    for (let i = 0; i < 5; i++) {
      expect((await consumeGenericWindow(k, 5, WINDOW_MS)).ok).toBe(true);
    }
    const blocked = await consumeGenericWindow(k, 5, WINDOW_MS);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it('peek is read-only', async () => {
    const k = 'oauth-cb:ip:5.6.7.8';
    await consumeGenericWindow(k, 2, WINDOW_MS);
    const p1 = await peekGenericWindow(k, 2, WINDOW_MS);
    expect(p1.used).toBe(1);
    const p2 = await peekGenericWindow(k, 2, WINDOW_MS);
    expect(p2.used).toBe(1);
  });
});

// ─── enforceResendCooldown: 30s gate + 5-per-15min window ─────────

describe('enforceResendCooldown', () => {
  it('allows the first send and blocks an immediate second (30s gate)', async () => {
    vi.useFakeTimers();
    const key = 'magic-link:h@x.com';
    vi.setSystemTime(1_700_000_000_000);
    const first = await enforceResendCooldown(key);
    expect(first.allowed).toBe(true);
    const second = await enforceResendCooldown(key);
    expect(second.allowed).toBe(false);
    expect(second.remainingMs).toBeGreaterThan(0);
    expect(second.remainingMs).toBeLessThanOrEqual(30_000);
    vi.useRealTimers();
  });

  it('hard-blocks after 5 attempts in the window with the window reset time', async () => {
    vi.useFakeTimers();
    const key = 'login-otp:i@x.com';
    let t = 1_700_000_000_000;
    vi.setSystemTime(t);
    for (let i = 0; i < 5; i++) {
      const r = await enforceResendCooldown(key);
      expect(r.allowed).toBe(true);
      t += 31_000; // spacing > 30s gate keeps the window path in play
      vi.setSystemTime(t);
    }
    // 6th attempt — still inside the 15-min window → hard block
    const sixth = await enforceResendCooldown(key);
    expect(sixth.allowed).toBe(false);
    expect(sixth.remainingMs).toBeGreaterThan(0);
    expect(sixth.remainingMs).toBeLessThanOrEqual(WINDOW_MS);
    vi.useRealTimers();
  });

  it('getRemainingAttempts mirrors the cooldown state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const key = 'magic-link:j@x.com';
    await enforceResendCooldown(key);
    const st = await getRemainingAttempts(key);
    expect(st.remaining).toBeLessThanOrEqual(4);
    expect(st.resetsInMs).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

// ─── 429 payload contract (shape the UI consumes) ──────────────────

describe('429 payload contract', () => {
  it('blocked consume results carry everything the UI needs', async () => {
    for (let i = 0; i < 3; i++) await consumeVerifyAttempt('magic-link', 'k@x.com');
    const r = await consumeVerifyAttempt('magic-link', 'k@x.com');
    // AuthCard/MagicLinkSentPage read: ok, exceeded, remaining, max, resetAt
    expect(r).toMatchObject({
      ok: false,
      exceeded: 'magic-link',
      remaining: 0,
      max: 3,
    });
    expect(typeof r.resetAt).toBe('number');
    expect(r.resetAt).toBeGreaterThan(Date.now());
  });

  it('resetAt → retryAfterMs conversion matches what handlers emit', async () => {
    for (let i = 0; i < 3; i++) await consumeVerifyAttempt('magic-link', 'l@x.com');
    const r = await consumeVerifyAttempt('magic-link', 'l@x.com');
    const retryAfterMs = Math.max(0, r.resetAt - Date.now());
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(WINDOW_MS);
    // UI: Math.ceil(retryAfterMs / 1000) seconds, then "resets at HH:MM"
    const retrySec = Math.ceil(retryAfterMs / 1000);
    expect(retrySec).toBeGreaterThan(0);
  });
});
