/**
 * The captcha gate's graceful, SUSPICION-AWARE fallback.
 *
 * A missing or invalid Turnstile token used to be a hard 403 — a dead end
 * whenever the widget itself cannot load (unreachable challenges.cloudflare.com,
 * ad-blocker, outage). The gate no longer traps anyone, but it is careful about
 * who it meters:
 *
 *   - A normal / anonymous tokenless request is NOT metered by the tightened
 *     budget at all. It proceeds under the standard per-endpoint per-IP limits
 *     the caller already enforces — the real, human-safe control. This is the
 *     whole point: a person doing a couple of legit sends (magic link + login
 *     OTP + password reset) never comes anywhere near a wall.
 *   - Only an already-SUSPICIOUS IP rides the tightened per-IP budget:
 *     `checkWindowLimitDB`, 30/hour. Suspicion is read from signals that already
 *     exist in the repo — a recent `captcha.blocked` / `captcha.attempt_failed`
 *     audit trail for the IP, or the shared suspicious-IP tracker
 *     (`isSuspiciousAsync`). 30 is a ceiling a scripter hits and a human never
 *     does.
 *   - The no-captcha-configured kill-switch stays a full no-op.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  configured: true,
  verified: false,
  fallbackAllows: true,
  fallbackKey: '',
  fallbackMax: 0,
  /** isSuspiciousAsync's answer (the rate-limit-hit signal). */
  suspiciousByTracker: false,
  /** Recent captcha.blocked/attempt_failed count for the IP (the trail signal). */
  captchaTrailCount: 0,
  events: [] as any[],
}));

vi.mock('@/features/auth/turnstile', () => ({
  isTurnstileConfigured: () => state.configured,
  verifyTurnstile: vi.fn(async () => state.verified),
}));
vi.mock('@/features/captcha/risk', () => ({
  checkWindowLimitDB: vi.fn(async (key: string, max: number) => {
    state.fallbackKey = key;
    state.fallbackMax = max;
    return state.fallbackAllows;
  }),
}));
vi.mock('@/features/auth/suspicious-activity', () => ({
  isSuspiciousAsync: vi.fn(async () => state.suspiciousByTracker),
}));
vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: {
      create: vi.fn(async ({ data }: any) => {
        state.events.push(data);
        return data;
      }),
      count: vi.fn(async () => state.captchaTrailCount),
    },
  },
}));

import { requireCaptchaGate } from '@/features/captcha/gate';

beforeEach(() => {
  state.configured = true;
  state.verified = false;
  state.fallbackAllows = true;
  state.fallbackKey = '';
  state.fallbackMax = 0;
  state.suspiciousByTracker = false;
  state.captchaTrailCount = 0;
  state.events = [];
});

describe('requireCaptchaGate fallback', () => {
  it('is a no-op when Turnstile is not configured (env kill-switch)', async () => {
    state.configured = false;
    const res = await requireCaptchaGate({ ipAddress: '1.2.3.4' });
    expect(res).toEqual({ ok: true });
    expect(state.fallbackKey).toBe('');
  });

  it('passes a valid token on the normal path without touching the fallback budget', async () => {
    state.verified = true;
    const res = await requireCaptchaGate({ token: 'good-token', ipAddress: '1.2.3.4' });
    expect(res).toEqual({ ok: true });
    expect(state.fallbackKey).toBe('');
  });

  it('does NOT meter a normal / anonymous tokenless request — it passes under the standard limits', async () => {
    // No tracker flag and no captcha-failure trail: this is a real person whose
    // widget could not load. The tightened budget must not even be consulted.
    const res = await requireCaptchaGate({ token: null, ipAddress: '203.0.113.7' });
    expect(res).toEqual({ ok: true });
    expect(state.fallbackKey).toBe(''); // fallback budget not consumed
    // Nothing was audited as a bypass either.
    expect(state.events.map((e) => e.kind)).not.toContain('captcha.fallback_bypassed');
  });

  it('lets a suspicious (tracker-flagged) tokenless request ride the tightened per-IP budget and audits it', async () => {
    state.suspiciousByTracker = true;
    const res = await requireCaptchaGate({ token: null, ipAddress: '203.0.113.7', userId: 'u-1' });
    expect(res).toEqual({ ok: true });
    // Tight budget: 30 per hour for this IP.
    expect(state.fallbackKey).toBe('captcha-fallback:ip:203.0.113.7');
    expect(state.fallbackMax).toBe(30);
    await vi.waitFor(() => {
      const kinds = state.events.map((e) => e.kind);
      expect(kinds).toContain('captcha.fallback_bypassed');
      expect(kinds).toContain('captcha.blocked'); // failure still recorded for escalation
    });
  });

  it('treats a recent captcha-failure audit trail as suspicion, even with a cold tracker', async () => {
    state.suspiciousByTracker = false;
    state.captchaTrailCount = 2; // prior captcha.blocked/attempt_failed for this IP
    const res = await requireCaptchaGate({ token: 'bad-token', ipAddress: '203.0.113.7', userId: 'u-1' });
    expect(res).toEqual({ ok: true });
    expect(state.fallbackKey).toBe('captcha-fallback:ip:203.0.113.7');
    expect(state.fallbackMax).toBe(30);
  });

  it('rejects a suspicious IP only once the fallback budget is spent, with a rate-limit style error', async () => {
    state.suspiciousByTracker = true;
    state.fallbackAllows = false;
    const res = await requireCaptchaGate({ token: 'bad-token', ipAddress: '203.0.113.7' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too many attempts/i);
    expect(res.error).not.toMatch(/captcha verification required/i);
  });
});
