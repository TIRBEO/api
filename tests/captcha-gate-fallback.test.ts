/**
 * The captcha gate's graceful fallback.
 *
 * A missing or invalid Turnstile token used to be a hard 403 — which is a
 * dead end whenever the widget itself cannot load (unreachable
 * challenges.cloudflare.com, ad-blocker, outage). The gate now routes those
 * requests through a tightened per-IP budget (`checkWindowLimitDB`, 5/hour)
 * and only errors once the budget is spent. Abuse stays bounded; the
 * tightened fallback limit IS the control. The no-captcha-configured
 * kill-switch must stay a full no-op.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  configured: true,
  verified: false,
  fallbackAllows: true,
  fallbackKey: '',
  events: [] as any[],
}));

vi.mock('@/features/auth/turnstile', () => ({
  isTurnstileConfigured: () => state.configured,
  verifyTurnstile: vi.fn(async () => state.verified),
}));
vi.mock('@/features/captcha/risk', () => ({
  checkWindowLimitDB: vi.fn(async (key: string) => {
    state.fallbackKey = key;
    return state.fallbackAllows;
  }),
}));
vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    activityEvent: {
      create: vi.fn(async ({ data }: any) => {
        state.events.push(data);
        return data;
      }),
    },
  },
}));

import { requireCaptchaGate } from '@/features/captcha/gate';

beforeEach(() => {
  state.configured = true;
  state.verified = false;
  state.fallbackAllows = true;
  state.fallbackKey = '';
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

  it('lets a tokenless request ride the tightened per-IP budget and audits it', async () => {
    const res = await requireCaptchaGate({ token: null, ipAddress: '203.0.113.7', userId: 'u-1' });
    expect(res).toEqual({ ok: true });
    // Tight budget: 5 per hour for this IP.
    expect(state.fallbackKey).toBe('captcha-fallback:ip:203.0.113.7');
    await vi.waitFor(() => {
      const kinds = state.events.map((e) => e.kind);
      expect(kinds).toContain('captcha.fallback_bypassed');
      expect(kinds).toContain('captcha.blocked'); // failure still recorded for escalation
    });
  });

  it('rejects only once the fallback budget is spent, with a rate-limit style error', async () => {
    state.fallbackAllows = false;
    const res = await requireCaptchaGate({ token: 'bad-token', ipAddress: '203.0.113.7' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too many attempts/i);
    expect(res.error).not.toMatch(/captcha verification required/i);
  });
});
