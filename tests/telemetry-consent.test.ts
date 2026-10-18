/**
 * Consent gating for client telemetry (features/preferences/dataUsage).
 *
 * The four data-usage toggles were stored and never read: an account could turn
 * analytics cookies OFF and keep having its behaviour measured. These tests pin
 * the enforcement, and — equally important — the three ways it must NOT fire:
 * an account that never answered (default allow), an anonymous request (no
 * account to ask), and a failed read (never mass data loss on a hiccup).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = new Map<string, any>();

vi.mock('@/infrastructure/db/prisma', () => ({
  prisma: {
    userPreferences: {
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.userId) ?? null),
    },
  },
}));

vi.mock('@/features/auth/http-guards', () => ({
  getSession: vi.fn(async () => ({ userId: 'u1', email: 'e@u.dev' })),
}));

import {
  analyticsConsentAllowed,
  isAnalyticsCategoryEvent,
  stripClientConsentFields,
} from '@/features/preferences/dataUsage';
import { prisma } from '@/infrastructure/db/prisma';

const findUnique = prisma.userPreferences.findUnique as ReturnType<typeof vi.fn>;

function seed(userId: string, misc: any) {
  rows.set(userId, { userId, misc });
}

beforeEach(() => {
  rows.clear();
  findUnique.mockClear();
});

describe('isAnalyticsCategoryEvent', () => {
  it('treats behavioural kinds as analytics', () => {
    for (const kind of ['ui.click', 'page.view', 'docs.vote', 'funnel.step', 'marketing.open',
      'auth.signup_start', 'auth.login_submit', 'perf']) {
      expect(isAnalyticsCategoryEvent(kind), kind).toBe(true);
    }
  });

  it('keeps operational kinds flowing to everybody', () => {
    for (const kind of ['client_error', 'security.something', 'captcha.blocked', 'network.offline', 'job.stalled']) {
      expect(isAnalyticsCategoryEvent(kind), kind).toBe(false);
    }
  });

  it('does not invent a category it has never seen', () => {
    // Unknown kinds are NOT analytics: a classifier that guesses would switch
    // off production telemetry by not knowing about it.
    expect(isAnalyticsCategoryEvent('something.new')).toBe(false);
    expect(isAnalyticsCategoryEvent('')).toBe(false);
  });
});

describe('analyticsConsentAllowed', () => {
  it('allows an anonymous event — there is no account to consult', async () => {
    await expect(analyticsConsentAllowed(null)).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('allows an account that has never answered (default allow)', async () => {
    seed('u-fresh', {});
    await expect(analyticsConsentAllowed('u-fresh')).resolves.toBe(true);
  });

  it('allows an account with no preferences row at all', async () => {
    await expect(analyticsConsentAllowed('u-none')).resolves.toBe(true);
  });

  it('refuses analytics for the account that explicitly turned cookies off', async () => {
    seed('u-off', { settings: { theme: 'dark' } });
    rows.set('u-off', {
      userId: 'u-off',
      privacy: { dataUsage: { analyticsCookies: false } },
    });
    await expect(analyticsConsentAllowed('u-off')).resolves.toBe(false);
  });

  it('keeps the answer ON for a stored value that is not a real boolean', async () => {
    rows.set('u-junk', { userId: 'u-junk', privacy: { dataUsage: { analyticsCookies: 'no' } } });
    await expect(analyticsConsentAllowed('u-junk')).resolves.toBe(true);
  });

  it('fails open when the database cannot be asked', async () => {
    findUnique.mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(analyticsConsentAllowed('u-anything')).resolves.toBe(true);
  });
});

describe('stripClientConsentFields', () => {
  it('removes the fields that would fake an account answer into the ledger', () => {
    const out = stripClientConsentFields({
      page: '/login', consent: true, analyticsCookies: true, marketingCookies: true, dataUsage: {}, hasConsent: 'yes',
    });
    expect(out).toEqual({ page: '/login' });
  });

  it('survives being handed nothing', () => {
    expect(stripClientConsentFields(null as any)).toEqual({});
  });
});
