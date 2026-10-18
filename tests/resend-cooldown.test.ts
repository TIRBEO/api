/**
 * The resend gate's behaviour when Redis is not there.
 *
 * Mailing a verification code is the one thing in this app that an attacker
 * can drive at volume with nothing but a form, so the gate used to be the only
 * ceiling. It is Redis-only, and Redis-only means the ceiling disappears the
 * moment Redis is down — which is exactly when a person is most likely to press
 * "resend" again and again. These tests pin the fallback: no Redis still costs
 * the caller the durable 5-per-15-min window in Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  redis: null as any,
  rows: new Map<string, number>(),
  failDb: false,
}));

vi.mock('@/features/auth/redis', () => ({
  getRedis: vi.fn(() => state.redis),
}));

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    rateLimitWindow: {
      upsert: vi.fn(async ({ where }: any) => {
        if (state.failDb) throw new Error('db down');
        const key = `${where.key_bucket.key}:${where.key_bucket.bucket}`;
        const next = (state.rows.get(key) ?? 0) + 1;
        state.rows.set(key, next);
        return { count: next };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import { enforceResendCooldown } from '@/features/auth/resend-cooldown';

beforeEach(() => {
  vi.clearAllMocks();
  state.redis = null;
  state.rows = new Map();
  state.failDb = false;
});

describe('enforceResendCooldown without Redis', () => {
  it('still stops at five sends in the window', async () => {
    const verdicts = [];
    for (let i = 0; i < 6; i++) verdicts.push(await enforceResendCooldown('magic-link:a@gmail.com'));
    expect(verdicts.slice(0, 5).every((v) => v.allowed)).toBe(true);
    expect(verdicts[5].allowed).toBe(false);
    expect(verdicts[5].remainingMs).toBeGreaterThan(0);
  });

  it('counts per address, not globally', async () => {
    for (let i = 0; i < 5; i++) await enforceResendCooldown('magic-link:a@gmail.com');
    expect((await enforceResendCooldown('magic-link:a@gmail.com')).allowed).toBe(false);
    expect((await enforceResendCooldown('magic-link:b@gmail.com')).allowed).toBe(true);
  });

  it('lets a send through when Redis AND Postgres are both gone', async () => {
    // The documented exception: with the database down there is no session to
    // protect, and failing closed here would deny a code to every account.
    state.failDb = true;
    expect(await enforceResendCooldown('magic-link:a@gmail.com')).toEqual({ allowed: true, remainingMs: 0 });
  });

  it('asks Postgres only when Redis is the thing missing', async () => {
    const { prisma } = await import('@/infrastructure/db/prisma');
    state.redis = { eval: vi.fn(async () => [1, 0, ''] ) } as any;
    expect(await enforceResendCooldown('magic-link:a@gmail.com')).toEqual({ allowed: true, remainingMs: 0 });
    expect(prisma.rateLimitWindow.upsert).not.toHaveBeenCalled();
  });

  it('a Redis script that throws falls back too, rather than passing for free', async () => {
    const { prisma } = await import('@/infrastructure/db/prisma');
    state.redis = { eval: vi.fn(async () => { throw new Error('redis down'); }) } as any;
    for (let i = 0; i < 5; i++) await enforceResendCooldown('reauth:a@gmail.com');
    expect((await enforceResendCooldown('reauth:a@gmail.com')).allowed).toBe(false);
    expect(prisma.rateLimitWindow.upsert).toHaveBeenCalledTimes(6);
  });
});
